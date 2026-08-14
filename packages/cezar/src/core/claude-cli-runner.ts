import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import type {
  AgentEvent,
  AgentRunResult,
  AgentRunSpec,
  AgentRunner,
  AgentSession,
  AgentToolCallRecord,
  ContentBlock,
  SessionOptions,
} from './agent-runner.ts';

// Re-exported for backends and the run manager that still import them from here.
export type { AgentSession, SessionOptions } from './agent-runner.ts';
import { isSignalTerminationExit, trackChildExit } from './agent-runner.ts';
import { buildChildEnv } from './agent-env.ts';
import { costWeightedTokens, type RawUsage } from './usage.ts';
import { readNdjson } from './ndjson.ts';
import {
  claudeTurnStarted,
  createClaudeUiState,
  mapClaudeMessage,
  stringifyToolResultContent,
  toolResultImageBlocks,
  type ClaudeUiMapping,
} from './claude-ui-mapper.ts';

/** Default wall-clock cap for a single run before SIGTERM → SIGKILL.
 *  Interactive sessions pass `timeoutMs: 0` to disable it entirely. */
export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000;
/** Grace period between SIGTERM and SIGKILL when a timeout fires. */
export const KILL_GRACE_MS = 10_000;
/** After `end()` closes stdin: claude in stream-json mode can ignore EOF and
 *  hang (janitor-confirmed CLI bug) — escalate SIGTERM, then SIGKILL. */
export const EOF_TERM_GRACE_MS = 8_000;
export const EOF_KILL_GRACE_MS = 4_000;
/** Reopen window after a turn ends before an auto-ended session closes stdin. */
export const AUTO_END_DELAY_MS = 250;

export interface ClaudeCliRunnerOptions {
  /** Override the binary name/path; defaults to `claude` on PATH. */
  bin?: string;
  /** Wall-clock timeout for a run (ms); per-spec `timeoutMs` still wins. */
  timeoutMs?: number;
}

/**
 * `AgentRunner` over the Claude Code CLI in headless stream-json mode. Auth =
 * the host's logged-in Pro/Max subscription (no API key needed). Sandboxing is
 * `--allowedTools` (default-deny for anything not listed) + running inside the
 * repo `cwd`; `Bash` is narrowed to `Bash(<prefix>:*)` patterns only when
 * `bashAllowlist` is set — the zero-config default has no allowlist, so `Bash`
 * is unrestricted shell access (#430).
 *
 * Session mechanics (multi-turn stdin, EOF watchdog, reopen window) follow
 * github-janitor's `claudeRunner.ts`; the original single-turn adaptation
 * came from @cezar/core's `ClaudeCodeCliRunner`.
 */
export class ClaudeCliRunner implements AgentRunner {
  readonly backend = 'claude' as const;

  private readonly bin: string;
  private readonly timeoutMs: number;
  private lastSession: AgentSession | null = null;

  constructor(opts: ClaudeCliRunnerOptions = {}) {
    // CEZ_DRY_RUN=1 swaps in the bundled mock so the cockpit / store /
    // GUI can be exercised without a logged-in claude or burning tokens.
    const defaultBin =
      process.env.CEZ_CLAUDE_BIN ??
      (process.env.CEZ_DRY_RUN === '1' ? mockClaudePath() : 'claude');
    this.bin = opts.bin ?? defaultBin;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  }

  /** One-shot run: start a session and auto-end it after the first turn. */
  run(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void): Promise<AgentRunResult> {
    return this.startSession(spec, onEvent, { autoEndAfterFirstTurn: true }).result;
  }

  async interrupt(): Promise<void> {
    this.lastSession?.interrupt();
  }

  startSession(
    spec: AgentRunSpec,
    onEvent?: (event: AgentEvent) => void,
    opts: SessionOptions = {},
  ): AgentSession {
    const args = buildClaudeArgs(spec);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = nodeSpawn(this.bin, args, {
        cwd: spec.cwd,
        env: buildChildEnv({ backend: this.backend, extraEnv: spec.env }),
      });
    } catch (err) {
      throw wrapSpawnError(err, this.bin);
    }

    let stdinOpen = true;
    let autoEndTimer: NodeJS.Timeout | undefined;
    let eofTermTimer: NodeJS.Timeout | undefined;
    let eofKillTimer: NodeJS.Timeout | undefined;

    // Protocol v2 emission — additive alongside v1 (`onEvent` keeps flowing
    // byte-identical); the channel is `opts.onUiEvent` (RunManager wiring
    // lands in R2 step 2.1). The mapper never throws, but a defect in it
    // must still never disturb the v1 stream — hence the belt-and-braces try.
    let uiState = createClaudeUiState({ fallbackSessionId: spec.sessionId });
    const emitUi = (map: (state: typeof uiState) => ClaudeUiMapping): void => {
      try {
        const mapped = map(uiState);
        uiState = mapped.state;
        if (opts.onUiEvent) {
          for (const event of mapped.events) opts.onUiEvent(event);
        }
      } catch {
        // v2 mapping is best-effort; v1 consumers stay unaffected.
      }
    };

    const sendMessage = (content: ContentBlock[]): boolean => {
      if (!stdinOpen) return false;
      // A follow-up inside the reopen window cancels the scheduled close.
      if (autoEndTimer) {
        clearTimeout(autoEndTimer);
        autoEndTimer = undefined;
      }
      const line = JSON.stringify({
        type: 'user',
        message: { role: 'user', content },
        session_id: spec.sessionId,
      });
      try {
        child.stdin.write(`${line}\n`);
        // Each user message written to stdin begins a turn (§7.1).
        emitUi(claudeTurnStarted);
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onEvent?.({ type: 'note', message: `claude: stdin write failed: ${message}` });
        return false;
      }
    };

    // Set the moment WE signal the child — the EOF watchdog, a cancel, or the
    // wall-clock kill switch. claude installs its own SIGTERM handler and exits
    // 143 instead of dying from the signal, so without this flag our own
    // teardown reads as an agent failure (#703).
    let terminatedByCezar = false;
    const signalChild = (signal: 'SIGTERM' | 'SIGKILL'): void => {
      terminatedByCezar = true;
      child.kill(signal);
    };
    // Every watchdog below asks "is the child still alive?" — and that question
    // is NOT `child.killed`, which only reports signal delivery. claude handles
    // SIGTERM itself, so `killed` is true while the process runs on; escalation
    // has to follow real termination or it never fires (#844).
    const hasExited = trackChildExit(child);

    const end = (): void => {
      if (!stdinOpen) return;
      stdinOpen = false;
      try {
        child.stdin.end();
      } catch {
        // already gone
      }
      eofTermTimer = setTimeout(() => {
        if (!hasExited()) signalChild('SIGTERM');
        eofKillTimer = setTimeout(() => {
          if (!hasExited()) signalChild('SIGKILL');
        }, EOF_KILL_GRACE_MS);
        eofKillTimer.unref?.();
      }, EOF_TERM_GRACE_MS);
      eofTermTimer.unref?.();
    };

    const interrupt = (): void => {
      stdinOpen = false;
      if (!hasExited()) signalChild('SIGTERM');
    };

    // Seed the first user message — the same path every follow-up takes.
    // Pasted task screenshots (spec.images) ride along as leading blocks.
    sendMessage([...(spec.images ?? []), { type: 'text', text: spec.userPrompt }]);

    const toolCalls: AgentToolCallRecord[] = [];
    const textChunks: string[] = [];
    let tokensUsed = 0;
    let sawUsage = false;
    let spawnFailed: Error | null = null;

    child.on('error', (err: NodeJS.ErrnoException) => {
      spawnFailed = wrapSpawnError(err, this.bin);
    });

    const stderrChunks: string[] = [];
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => stderrChunks.push(chunk));

    // Optional wall-clock kill switch (disabled for interactive sessions).
    const limitMs = spec.timeoutMs ?? this.timeoutMs;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined;
    if (limitMs > 0) {
      deadline = setTimeout(() => {
        timedOut = true;
        interrupt();
        child.stdout.destroy();
        killTimer = setTimeout(() => {
          if (!hasExited()) signalChild('SIGKILL');
        }, KILL_GRACE_MS);
        killTimer.unref?.();
      }, limitMs);
      deadline.unref?.();
    }

    const result = (async (): Promise<AgentRunResult> => {
      try {
        for await (const line of readNdjson(child.stdout)) {
          if (timedOut) break;
          let msg: ClaudeStreamMessage;
          try {
            msg = JSON.parse(line) as ClaudeStreamMessage;
          } catch {
            onEvent?.({ type: 'note', message: `claude: skipped unparseable stream line: ${truncate(line)}` });
            continue;
          }

          // Claude reports `error_during_execution` while reacting to our
          // teardown signal. Once cezar has signalled the child, that frame
          // describes the intentional stop rather than an agent failure.
          // Normalize only this precise wire shape so genuine result errors
          // (authentication, limits, malformed sessions) stay authoritative.
          const mappedMessage = normalizeIntentionalTeardownResult(msg, terminatedByCezar);
          emitUi((state) => mapClaudeMessage(mappedMessage, state));

          let delta = 0;
          try {
            delta = handleClaudeMessage(mappedMessage, { toolCalls, textChunks, onEvent });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            onEvent?.({ type: 'note', message: `claude: skipped malformed event (${msg.type ?? 'unknown'}): ${message}` });
            continue;
          }
          if (delta > 0) {
            sawUsage = true;
            tokensUsed += delta;
            onEvent?.({ type: 'token-usage', tokensUsed });
          }

          if (msg.type === 'result') {
            if (typeof msg.total_cost_usd === 'number' && msg.total_cost_usd > 0) {
              onEvent?.({ type: 'cost', usd: msg.total_cost_usd });
            }
            onEvent?.({ type: 'turn-end' });
            if (opts.autoEndAfterFirstTurn && stdinOpen && !autoEndTimer) {
              autoEndTimer = setTimeout(end, AUTO_END_DELAY_MS);
              autoEndTimer.unref?.();
            }
          }
        }
      } catch (err) {
        // A timeout destroys stdout, which surfaces here as a premature-close
        // error — expected; rethrow anything else.
        if (!timedOut) throw err;
      } finally {
        if (deadline) clearTimeout(deadline);
        if (killTimer) clearTimeout(killTimer);
        if (autoEndTimer) clearTimeout(autoEndTimer);
        stdinOpen = false;
      }

      const exitCode = await waitForExit(child);
      if (eofTermTimer) clearTimeout(eofTermTimer);
      if (eofKillTimer) clearTimeout(eofKillTimer);

      if (spawnFailed) throw spawnFailed;

      const text = textChunks.join('\n').trim();

      if (timedOut) {
        const mins = Math.round((limitMs / 60_000) * 10) / 10;
        onEvent?.({ type: 'error', message: `claude CLI timed out after ${mins}m and was killed` });
        onEvent?.({ type: 'done' });
        return { text, toolCalls, tokensUsed, sessionId: spec.sessionId };
      }

      // A session cezar itself tore down (EOF watchdog after `end()`, or a
      // cancel) exits 143/137 — that is our own signal coming back, not an
      // agent failure, so it settles on the normal path with a note (#703).
      if (terminatedByCezar && isSignalTerminationExit(exitCode)) {
        onEvent?.({
          type: 'note',
          message: `claude CLI did not exit on its own after close; terminated by cezar (code ${exitCode})`,
        });
        onEvent?.({ type: 'done' });
        return { text, toolCalls, tokensUsed, sessionId: spec.sessionId };
      }

      if (exitCode !== 0 && exitCode !== null) {
        const stderr = stderrChunks.join('').trim();
        const detail = stderr ? ` — ${stderr.split('\n').slice(-3).join(' | ')}` : '';
        const msg = `claude CLI exited with code ${exitCode}${detail}`;
        onEvent?.({ type: 'error', message: msg });
        throw new Error(msg);
      }

      if (!sawUsage) {
        onEvent?.({ type: 'note', message: 'token usage not reported by claude CLI' });
      }

      onEvent?.({ type: 'done' });
      return { text, toolCalls, tokensUsed, sessionId: spec.sessionId };
    })();

    const session: AgentSession = {
      result,
      sendMessage,
      end,
      interrupt,
      pid: child.pid,
      get open() {
        return stdinOpen;
      },
    };
    this.lastSession = session;
    return session;
  }
}

/**
 * Build the headless argv. `--input-format stream-json` reads user messages
 * from stdin; `--output-format stream-json --verbose` gives per-event NDJSON;
 * `--permission-mode dontAsk` keeps headless runs non-interactive: tools in
 * `--allowedTools` proceed and everything else is denied instead of prompting.
 * `CEZ_APPROVAL_GATE=1` opts back into Claude's approval UI (#435).
 */
export function buildClaudeArgs(
  spec: AgentRunSpec,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const args: string[] = [
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    env.CEZ_APPROVAL_GATE === '1' ? 'acceptEdits' : 'dontAsk',
  ];
  if (spec.systemPrompt) {
    args.push('--append-system-prompt', spec.systemPrompt);
  }
  // Pin the session so the user can `claude --resume <sessionId>` in the repo
  // to take over interactively after a run. With `resume` we reopen the
  // existing on-disk conversation instead.
  if (spec.sessionId) {
    if (spec.resume) {
      args.push('--resume', spec.sessionId);
    } else {
      args.push('--session-id', spec.sessionId);
    }
  }
  const allowed = buildAllowedTools(spec.allowedTools ?? [], spec.bashAllowlist);
  if (allowed.length > 0) {
    args.push('--allowedTools', allowed.join(','));
  }
  if (spec.model) {
    args.push('--model', spec.model);
  }
  for (const dir of spec.additionalDirectories ?? []) {
    args.push('--add-dir', dir);
  }
  return args;
}

/**
 * Map `allowedTools` onto claude's `--allowedTools` syntax. `Bash` with a
 * `bashAllowlist` becomes one `Bash(<prefix>:*)` entry per allowed prefix;
 * `Bash` with no allowlist stays plain `Bash`.
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

function truncate(s: string, max = 200): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Path to the bundled mock (`scripts/mock-claude.mjs`), for CEZ_DRY_RUN=1. */
function mockClaudePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // here = <pkg>/dist/core (built) or <pkg>/src/core (tsx dev).
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

function normalizeIntentionalTeardownResult(
  msg: ClaudeStreamMessage,
  terminatedByCezar: boolean,
): ClaudeStreamMessage {
  if (
    terminatedByCezar
    && msg.type === 'result'
    && msg.is_error === true
    && msg.subtype === 'error_during_execution'
  ) {
    return { ...msg, subtype: 'success', is_error: false };
  }
  return msg;
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
      const b = block as { type?: string; text?: string; id?: string; name?: string; input?: unknown };
      if (b.type === 'text' && typeof b.text === 'string') {
        ctx.textChunks.push(b.text);
        ctx.onEvent?.({ type: 'text', text: b.text });
      } else if (b.type === 'tool_use' && b.id && b.name) {
        ctx.toolCalls.push({ id: b.id, name: b.name, input: b.input });
        ctx.onEvent?.({ type: 'tool-call', id: b.id, tool: b.name, input: b.input });
      }
    }
    // Assistant-frame usage belongs to the individual API calls inside this
    // agentic turn. Claude's terminal result frame already aggregates those
    // calls, so adding both sources inflates the run total (#716). Keep these
    // frames presentation-only; the result branch below is authoritative,
    // matching the v2 `usage.updated` mapping in AGENT_PROTOCOL.md.
    return 0;
  }

  if (msg.type === 'user' && msg.message?.content) {
    for (const block of msg.message.content) {
      const b = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        ctx.onEvent?.({
          type: 'tool-result',
          toolCallId: b.tool_use_id,
          result: stringifyToolResultContent(b.content),
          isError: b.is_error === true,
        });
        // Screenshots and other images inside the result get their own
        // events — the text path above renders them as a placeholder.
        for (const img of toolResultImageBlocks(b.content)) {
          ctx.onEvent?.({ type: 'image', mediaType: img.media_type, data: img.data });
        }
      }
    }
    return 0;
  }

  if (msg.type === 'result') {
    // Final message of a turn: `result` is the full assistant text; only fall
    // back to it if we never saw streamed assistant text blocks.
    if (typeof msg.result === 'string' && ctx.textChunks.length === 0) {
      ctx.textChunks.push(msg.result);
      ctx.onEvent?.({ type: 'text', text: msg.result });
    }
    if (msg.is_error) {
      ctx.onEvent?.({
        type: 'error',
        message: typeof msg.result === 'string' && msg.result.trim() !== ''
          ? msg.result
          : `claude reported result error${msg.subtype ? ` (${msg.subtype})` : ''}`,
      });
    }
    return costWeightedTokens(msg.usage);
  }

  // system/init and anything else: nothing actionable.
  return 0;
}

// stringify/image helpers moved to claude-ui-mapper.ts (shared by v1 and v2).

// ---- subprocess plumbing --------------------------------------------------

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
    const safety = setTimeout(
      () => fin(child.exitCode ?? null),
      EOF_TERM_GRACE_MS + EOF_KILL_GRACE_MS + KILL_GRACE_MS + 5_000,
    );
    safety.unref?.();
  });
}

function wrapSpawnError(err: unknown, bin: string): Error {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    return new Error(
      `\`${bin}\` not found on PATH — install Claude Code (https://claude.com/claude-code) and run \`claude\` once to log in`,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}
