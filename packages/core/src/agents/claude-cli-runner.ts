import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { TokenBudgetExceededError } from '../actions/autofix/token-budget.js';
import {
  type AgentRunner,
  type AgentRunSpec,
  type AgentRunResult,
  type AgentEvent,
  type AgentToolCallRecord,
} from './agent-runner.js';
import { costWeightedTokens, parseStructured, type RawUsage } from './structured-output.js';

/** Injectable for tests — same shape as `node:child_process.spawn`. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams;

/** Default wall-clock cap for a single CLI run before SIGTERM → SIGKILL. */
export const DEFAULT_RUN_TIMEOUT_MS = 20 * 60_000;
/** Grace period between SIGTERM and SIGKILL when a timeout fires. */
export const KILL_GRACE_MS = 10_000;
/**
 * Rough $/Mtoken used to translate `spec.tokenBudget` into Claude headless's
 * `--max-budget-usd`. Conservative (above Opus blended input+output) so the
 * dollar cap trips no *earlier* than the token cap. Overridable per-runner.
 * TODO(phase-4-verify): confirm pricing / whether `--max-budget-usd` is honored.
 */
export const DEFAULT_USD_PER_MILLION_TOKENS = 20;

export interface ClaudeCodeCliRunnerOptions {
  /** Override the binary name/path; defaults to `claude` on PATH. */
  bin?: string;
  spawnFn?: SpawnFn;
  /** Wall-clock timeout for a run (ms); per-spec `timeoutMs` still wins. */
  timeoutMs?: number;
  /** $/Mtoken used to derive `--max-budget-usd` from `spec.tokenBudget`. */
  usdPerMillionTokens?: number;
  /**
   * How the runner invokes `claude`:
   *  - `'stream-json'` (default since Phase 2 of the horizontal-scaling
   *    rollout) — `claude --input-format stream-json --output-format
   *    stream-json` (no `-p`); the user prompt is sent over stdin as
   *    one `{type:user}` NDJSON line. Each `.run()` call still spawns
   *    its own child today, but pairing this transport with the same
   *    `spec.sessionId` across steps lets `claude` resume the prior
   *    on-disk conversation so prompt cache hits the cumulative prefix.
   *  - `'print'` — `claude -p <userPrompt>`, one turn-cycle, exit.
   *    Kept as an escape hatch (env override `CEZAR_CLI_TRANSPORT=print`
   *    or `spec.transport = 'print'` upstream).
   */
  transport?: 'print' | 'stream-json';
}

/**
 * Resolve the default transport: explicit `opts.transport` wins, then the
 * `CEZAR_CLI_TRANSPORT` env override, then `'stream-json'` (the post-Phase-2
 * default). Print mode stays reachable for callers that need the legacy
 * argv-style argv invocation (e.g. older claude builds, debugging).
 */
function resolveDefaultTransport(
  explicit: 'print' | 'stream-json' | undefined,
): 'print' | 'stream-json' {
  if (explicit) return explicit;
  const env = process.env.CEZAR_CLI_TRANSPORT;
  if (env === 'print' || env === 'stream-json') return env;
  return 'stream-json';
}

/**
 * `AgentRunner` over the Claude Code CLI in headless mode (`claude -p`). Auth =
 * the host's logged-in Pro/Max subscription (no API key needed). Tool/cwd
 * sandboxing is delegated to `--allowedTools` + a worktree-only `cwd` (the SDK
 * `canUseTool` hook isn't available here): the CLI is default-deny, so listing
 * only the tools we want is the whole policy; `Bash` is narrowed to
 * `Bash(<prefix>:*)` patterns when `spec.bashAllowlist` is set.
 *
 * TODO(phase-4-verify): confirm against a live `claude` run — the `stream-json`
 * `result`/`usage` payload schema, that headless is default-deny for unlisted
 * tools, and that `--max-budget-usd` is respected.
 */
export class ClaudeCodeCliRunner implements AgentRunner {
  readonly backend = 'claude-cli' as const;

  private readonly bin: string;
  private readonly spawnFn: SpawnFn;
  private readonly timeoutMs: number;
  private readonly usdPerMillionTokens: number;
  private readonly transport: 'print' | 'stream-json';
  private child: ChildProcessWithoutNullStreams | null = null;

  constructor(opts: ClaudeCodeCliRunnerOptions = {}) {
    // Swap to the mock binary when `CEZAR_DRY_RUN=1` so workflow / cockpit
    // / event-persistence work can be exercised without burning tokens.
    // Explicit `opts.bin` wins so tests can still inject their own stub.
    const defaultBin = process.env.CEZAR_DRY_RUN === '1' ? mockClaudePath() : 'claude';
    this.bin = opts.bin ?? defaultBin;
    this.spawnFn = opts.spawnFn ?? (nodeSpawn as unknown as SpawnFn);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    this.usdPerMillionTokens = opts.usdPerMillionTokens ?? DEFAULT_USD_PER_MILLION_TOKENS;
    this.transport = resolveDefaultTransport(opts.transport);
  }

  async run<T = unknown>(
    spec: AgentRunSpec<T>,
    onEvent?: (event: AgentEvent) => void,
  ): Promise<AgentRunResult<T>> {
    try {
      return await this.runOnce(spec, onEvent);
    } catch (err) {
      // Cross-restart resume fallback (docs: Phase 2E). When `spec.resume`
      // is set but the on-disk session isn't on this host (cross-host
      // re-claim), `claude --resume <id>` exits non-zero. Retry transparently
      // with `--session-id <id>` so the engine still threads the same id
      // through the workflow, just without conversation history. Log a
      // `note` so the cockpit shows the degraded path.
      if (spec.resume && spec.sessionId && isResumeFailure(err)) {
        onEvent?.({
          type: 'note',
          message: `claude --resume ${spec.sessionId} failed (likely cross-host re-claim) — retrying with fresh session under the same id`,
        });
        return this.runOnce({ ...spec, resume: false }, onEvent);
      }
      throw err;
    }
  }

  private async runOnce<T = unknown>(
    spec: AgentRunSpec<T>,
    onEvent?: (event: AgentEvent) => void,
  ): Promise<AgentRunResult<T>> {
    const args = buildClaudeArgs(spec, this.usdPerMillionTokens, this.transport);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnFn(this.bin, args, { cwd: spec.cwd, env: process.env });
    } catch (err) {
      throw wrapSpawnError(err, this.bin);
    }
    this.child = child;

    // In stream-json transport the prompt isn't in argv — it goes over
    // stdin as one NDJSON `{type:user, message:…}` line, then we close
    // stdin so claude knows there's no further input and can run to
    // completion. The session id is included so the message gets
    // associated with the right session-file on disk.
    if (this.transport === 'stream-json') {
      const userMessage = {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: spec.userPrompt }] },
        session_id: spec.sessionId,
      };
      try {
        child.stdin.write(`${JSON.stringify(userMessage)}\n`);
        child.stdin.end();
      } catch (err) {
        onEvent?.({
          type: 'note',
          message: `claude: stdin write failed: ${(err as Error).message}`,
        });
      }
    }

    const toolCalls: AgentToolCallRecord[] = [];
    const textChunks: string[] = [];
    let tokensUsed = 0;
    let sawUsage = false;
    let budgetExceeded = false;
    let spawnFailed: Error | null = null;

    child.on('error', (err: NodeJS.ErrnoException) => {
      spawnFailed = wrapSpawnError(err, this.bin);
    });

    const stderrChunks: string[] = [];
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => stderrChunks.push(chunk));

    // Wall-clock kill switch: SIGTERM, then SIGKILL after a grace period.
    const limitMs = spec.timeoutMs ?? this.timeoutMs;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const deadline = setTimeout(() => {
      timedOut = true;
      void this.interrupt();
      // Unblock the NDJSON reader (the subprocess may keep its stdout open).
      child.stdout.destroy();
      killTimer = setTimeout(() => {
        if (child.exitCode == null && !child.killed) child.kill('SIGKILL');
      }, KILL_GRACE_MS);
      if (typeof killTimer.unref === 'function') killTimer.unref();
    }, limitMs);
    if (typeof deadline.unref === 'function') deadline.unref();

    try {
      for await (const line of readNdjson(child.stdout)) {
        if (timedOut) break;
        let msg: ClaudeStreamMessage;
        try {
          msg = JSON.parse(line) as ClaudeStreamMessage;
        } catch {
          // Non-JSON noise on the stream — surface it, never crash.
          onEvent?.({
            type: 'note',
            message: `claude: skipped unparseable stream line: ${truncate(line)}`,
          });
          continue;
        }

        let delta = 0;
        try {
          delta = handleClaudeMessage(msg, { toolCalls, textChunks, onEvent });
        } catch (err) {
          // Renamed/missing fields shouldn't take the whole run down.
          onEvent?.({
            type: 'note',
            message: `claude: skipped malformed event (${msg.type ?? 'unknown'}): ${(err as Error).message}`,
          });
          continue;
        }
        if (delta > 0) {
          sawUsage = true;
          tokensUsed += delta;
          if (spec.tokenBudget) {
            spec.tokenBudget.record({ inputTokens: delta });
            onEvent?.({ type: 'token-usage', tokensUsed });
            try {
              spec.tokenBudget.assertWithinBudget();
            } catch (err) {
              if (err instanceof TokenBudgetExceededError) {
                budgetExceeded = true;
                onEvent?.({
                  type: 'note',
                  message: `token budget exceeded: used ${err.used} of ${err.limit}`,
                });
                await this.interrupt();
                break;
              }
              throw err;
            }
          }
        }
      }
    } catch (err) {
      // A timeout destroys stdout, which surfaces here as a premature-close
      // error — expected; rethrow anything else.
      if (!timedOut) throw err;
    } finally {
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      this.child = null;
    }

    const exitCode = await waitForExit(child);

    if (spawnFailed) throw spawnFailed;

    const text = textChunks.join('\n').trim();
    const parsed = spec.responseSchema ? parseStructured(text, spec.responseSchema) : null;

    if (timedOut) {
      const mins = Math.round((limitMs / 60_000) * 10) / 10;
      onEvent?.({ type: 'note', message: `timed out after ${mins}m — killed` });
      onEvent?.({ type: 'error', message: `claude CLI timed out after ${mins}m and was killed` });
      onEvent?.({ type: 'done' });
      return {
        text,
        parsed,
        toolCalls,
        tokensUsed,
        budgetExceeded: false,
        sessionId: spec.sessionId,
      };
    }

    if (!budgetExceeded && exitCode !== 0 && exitCode !== null) {
      const stderr = stderrChunks.join('').trim();
      const detail = stderr ? ` — ${stderr.split('\n').slice(-3).join(' | ')}` : '';
      const msg = `claude CLI exited with code ${exitCode}${detail}`;
      onEvent?.({ type: 'error', message: msg });
      throw new Error(msg);
    }

    if (!sawUsage) {
      // The cockpit shows "unknown" rather than a misleading 0.
      onEvent?.({ type: 'note', message: 'token usage not reported by claude CLI' });
    }

    onEvent?.({ type: 'done' });
    return { text, parsed, toolCalls, tokensUsed, budgetExceeded, sessionId: spec.sessionId };
  }

  async interrupt(): Promise<void> {
    const child = this.child;
    if (!child || child.killed) return;
    // Headless `claude -p` has no in-band interrupt; SIGTERM is the cooperative
    // stop (the timeout escalates to SIGKILL after a grace period).
    child.kill('SIGTERM');
  }
}

/**
 * Build the headless `claude` argv. `-p` selects print/headless mode;
 * `--output-format stream-json --verbose` gives the per-event NDJSON stream;
 * `--append-system-prompt` keeps the default Claude Code system prompt and adds
 * our step prompt on top; `--allowedTools` is the sandbox (default-deny for
 * anything not listed); `--permission-mode acceptEdits` lets edits through
 * without a prompt (there's no TTY).
 */
function buildClaudeArgs<T>(
  spec: AgentRunSpec<T>,
  usdPerMillionTokens: number,
  transport: 'print' | 'stream-json' = 'print',
): string[] {
  // The two transports differ only in how the user prompt arrives.
  //  - 'print'       — `-p <prompt>` passes the prompt as an argv string.
  //  - 'stream-json' — `--input-format stream-json` tells claude to read
  //                    user messages from stdin; the caller writes the
  //                    NDJSON `{type:user, …}` line after spawn.
  const args: string[] =
    transport === 'stream-json'
      ? [
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--verbose',
          '--append-system-prompt',
          spec.systemPrompt,
          '--permission-mode',
          'acceptEdits',
        ]
      : [
          '-p',
          spec.userPrompt,
          '--output-format',
          'stream-json',
          '--verbose',
          '--append-system-prompt',
          spec.systemPrompt,
          '--permission-mode',
          'acceptEdits',
        ];
  // Pin the session so an operator can `cd <worktree> && claude --resume
  // <sessionId>` after a failed run to take over interactively. We use
  // the agent_run.id as the session id (already a UUID) so the cockpit
  // can show it verbatim. Pre-2025 claude builds may reject `--session-id`;
  // the runner silently drops it via the surrounding try/catch on spawn.
  //
  // `spec.resume` (set by the engine on a re-claimed job) flips to
  // `claude --resume <sessionId>` so the new process picks up the prior
  // on-disk conversation. If the session blob isn't on this host (cross-
  // host re-claim), `claude --resume` exits non-zero — the engine catches
  // that and retries the step without `resume` so the runner re-spawns
  // with the same `--session-id`, which falls back to a cold start under
  // the same id. The error path logs a `note` so the operator sees the
  // degraded path.
  if (spec.sessionId) {
    if (spec.resume) {
      args.push('--resume', spec.sessionId);
    } else {
      args.push('--session-id', spec.sessionId);
    }
  }
  const allowed = buildAllowedTools(spec.allowedTools, spec.bashAllowlist);
  if (allowed.length > 0) {
    args.push('--allowedTools', allowed.join(','));
  }
  if (spec.model) {
    args.push('--model', spec.model);
  }
  // Headless Claude has no `--max-turns` equivalent — only `--max-budget-usd`.
  // Translate `tokenBudget` into a rough dollar cap (overridable). `maxTurns`
  // is therefore not enforced for this backend.
  // TODO(phase-4-verify): confirm `--max-budget-usd` semantics on a live run.
  if (spec.tokenBudget) {
    const limitTokens = readBudgetLimit(spec.tokenBudget);
    if (limitTokens && limitTokens > 0) {
      const usd = Math.max(0.01, (limitTokens / 1_000_000) * usdPerMillionTokens);
      args.push('--max-budget-usd', usd.toFixed(2));
    }
  }
  for (const dir of spec.additionalDirectories ?? []) {
    args.push('--add-dir', dir);
  }
  // TODO(phase-4-verify): `--json-schema` could enforce structured output
  // server-side; for now we extract from the final assistant text via
  // parseStructured so behavior matches the API path.
  return args;
}

/**
 * Map `spec.allowedTools` onto Claude Code's `--allowedTools` syntax. `Bash`
 * with a `bashAllowlist` becomes one `Bash(<prefix>:*)` entry per allowed
 * command prefix (e.g. `bashAllowlist: ['npm test', 'git status']` →
 * `Bash(npm test:*)`, `Bash(git status:*)`); `Bash` with no allowlist stays
 * plain `Bash`. Everything else passes through unchanged.
 */
export function buildAllowedTools(allowedTools: string[], bashAllowlist?: string[]): string[] {
  const out: string[] = [];
  for (const tool of allowedTools) {
    if (tool === 'Bash' && bashAllowlist && bashAllowlist.length > 0) {
      for (const prefix of bashAllowlist) {
        const p = prefix.trim();
        if (p) out.push(`Bash(${p}:*)`);
      }
    } else {
      out.push(tool);
    }
  }
  return out;
}

/** Best-effort read of a `TokenBudget`'s configured limit, if it exposes one. */
function readBudgetLimit(budget: unknown): number | null {
  if (!budget || typeof budget !== 'object') return null;
  const b = budget as Record<string, unknown>;
  for (const key of ['limit', 'maxTokens', 'budget']) {
    const v = b[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

function truncate(s: string, max = 200): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Resolve the path to `scripts/mock-claude.mjs` shipped alongside
 * @cezar/core. After `tsc` build this file lives at
 * `dist/agents/claude-cli-runner.js`, so `../../scripts/mock-claude.mjs`
 * walks back to the package root.
 */
function mockClaudePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolvePath(here, '..', '..', 'scripts', 'mock-claude.mjs');
}

// ---- stream-json event handling -------------------------------------------

interface ClaudeStreamMessage {
  type?: string;
  subtype?: string;
  message?: {
    role?: string;
    content?: unknown[];
    usage?: RawUsage;
  };
  // `result` messages carry these at the top level.
  result?: string;
  usage?: RawUsage;
  is_error?: boolean;
  total_cost_usd?: number;
}

function handleClaudeMessage(
  msg: ClaudeStreamMessage,
  ctx: {
    toolCalls: AgentToolCallRecord[];
    textChunks: string[];
    onEvent?: (e: AgentEvent) => void;
  },
): number {
  if (msg.type === 'assistant' && msg.message?.content) {
    for (const block of msg.message.content) {
      const b = block as {
        type?: string;
        text?: string;
        id?: string;
        name?: string;
        input?: unknown;
      };
      if (b.type === 'text' && typeof b.text === 'string') {
        ctx.textChunks.push(b.text);
        ctx.onEvent?.({ type: 'text', text: b.text });
      } else if (b.type === 'tool_use' && b.id && b.name) {
        ctx.toolCalls.push({ id: b.id, name: b.name, input: b.input });
        ctx.onEvent?.({ type: 'tool-call', id: b.id, tool: b.name, input: b.input });
      }
    }
    return costWeightedTokens(msg.message.usage);
  }

  if (msg.type === 'user' && msg.message?.content) {
    for (const block of msg.message.content) {
      const b = block as {
        type?: string;
        tool_use_id?: string;
        content?: unknown;
        is_error?: boolean;
      };
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        ctx.onEvent?.({
          type: 'tool-result',
          toolCallId: b.tool_use_id,
          result: stringifyContent(b.content),
          isError: b.is_error === true,
        });
      }
    }
    return 0;
  }

  if (msg.type === 'result') {
    // Final message: `result` is the full assistant text; only fall back to it
    // if we never saw streamed assistant text blocks.
    if (typeof msg.result === 'string' && ctx.textChunks.length === 0) {
      ctx.textChunks.push(msg.result);
      ctx.onEvent?.({ type: 'text', text: msg.result });
    }
    if (msg.is_error) {
      ctx.onEvent?.({
        type: 'note',
        message: `claude reported result error${msg.subtype ? ` (${msg.subtype})` : ''}`,
      });
    }
    return costWeightedTokens(msg.usage);
  }

  // system/init and anything else: nothing actionable.
  return 0;
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const b = c as { type?: string; text?: string };
        if (b.type === 'text' && typeof b.text === 'string') return b.text;
        try {
          return JSON.stringify(b);
        } catch {
          return String(b);
        }
      })
      .join('\n');
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

// ---- subprocess plumbing --------------------------------------------------

/** Async line iterator over a readable stream of UTF-8 NDJSON. */
async function* readNdjson(stream: NodeJS.ReadableStream): AsyncGenerator<string> {
  stream.setEncoding('utf8');
  let buffer = '';
  for await (const chunk of stream as AsyncIterable<string>) {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) yield line;
    }
  }
  const tail = buffer.trim();
  if (tail) yield tail;
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode != null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    let done = false;
    const fin = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(safety);
      resolve(code);
    };
    child.once('close', (code) => fin(code));
    child.once('exit', (code) => fin(code));
    // Don't swallow a late error as a clean null exit — fall back to the
    // child's own exit code (which is non-null/non-zero on failure).
    child.once('error', () => fin(child.exitCode ?? null));
    // A SIGKILLed process may never emit 'close' through some edge cases.
    const safety = setTimeout(() => fin(child.exitCode ?? null), KILL_GRACE_MS + 5_000);
    if (typeof safety.unref === 'function') safety.unref();
  });
}

function wrapSpawnError(err: unknown, bin: string): Error {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    return new Error(
      `${bin} CLI not found on PATH — install Claude Code or use the anthropic-api backend`,
    );
  }
  if (code === 'E2BIG') {
    // The combined argv (system prompt in --append-system-prompt, plus the
    // user prompt in -p under print transport) blew past the OS ARG_MAX
    // limit. Surface an actionable message instead of a bare `spawn E2BIG`.
    return new Error(
      `${bin}: prompt too large for argv (E2BIG) — use the stream-json transport (default; set CEZAR_CLI_TRANSPORT=stream-json) or shorten the system prompt`,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * `claude --resume <id>` errors that mean "no on-disk session here" — caller
 * (the engine via the runner) retries without the resume flag. We can't see
 * the exact stderr from the catch site (it's already wrapped into the thrown
 * `Error`'s message), so we sniff the message: a non-zero exit code paired
 * with `claude CLI exited with code` is the cue. ENOENT (binary missing) is
 * NOT a resume-failure — that's already wrapped into a clear "install Claude
 * Code" message and shouldn't be retried.
 */
function isResumeFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /claude CLI exited with code \d+/.test(err.message);
}
