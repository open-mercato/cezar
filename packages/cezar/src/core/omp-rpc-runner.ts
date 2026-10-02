import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent, AgentRunResult, AgentRunSpec, AgentRunner, AgentSession, ContentBlock, SessionOptions } from './agent-runner.ts';
import { isSignalTerminationExit, trackChildExit } from './agent-runner.ts';
import type { AgentToolCallRecord } from './agent-runner.ts';
import { buildChildEnv } from './agent-env.ts';
import { readNdjson } from './ndjson.ts';
import { createOmpUiState, mapOmpRpcMessage, ompTurnStarted, type OmpUiMapperState } from './omp-ui-mapper.ts';

const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const KILL_GRACE_MS = 10_000;
const AUTO_END_DELAY_MS = 250;
/**
 * How long a turn waits for the `session_settled` that follows a
 * `prompt_result` with `sessionSettled: false`, before teardown anyway.
 * omp promises the frame once its background work settles; under cezar's lean
 * child env a settle can be silently missed, and an unbounded wait would turn
 * a finished turn into a deadline kill (rpc.md "Yield vs settled").
 */
const SESSION_SETTLE_GRACE_MS = 20_000;

export interface OmpRunnerOptions {
  bin?: string;
  timeoutMs?: number;
  /** Overridable so tests do not wait out the 20s default. */
  settleGraceMs?: number;
  /** Overridable so tests do not wait out each teardown grace step. */
  killGraceMs?: number;
}

/**
 * Persistent subprocess adapter for omp's documented RPC mode.
 *
 * Protocol reference: docs/rpc.md shipped with the omp CLI (also published at
 * https://omp.sh/docs/rpc). omp is pi's continuation, so this adapter is the
 * pi runner's sibling: one `omp --mode rpc` process per run, newline-delimited
 * JSON commands on stdin, frames on stdout. The differences from pi:
 *
 *   - startup sends `get_state` (session id + active model) — same, but pi
 *     forwarded a `--session-id` arg and omp resolves resumption through
 *     `--resume <id>` at launch instead.
 *   - the terminal settle is `prompt_result` (one per accepted prompt) instead
 *     of `agent_settled`; a `sessionSettled: false` result waits for the
 *     `session_settled` frame that follows background work.
 *   - `--no-ui` runs extensions headless so cezar never owes dialog answers.
 *
 * `spec.systemPrompt` rides the native `--append-system-prompt` channel (like
 * claude), so `prependSystemPrompt` is NOT used here.
 */
export class OmpRpcRunner implements AgentRunner {
  readonly backend = 'omp' as const;
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly settleGraceMs: number;
  private readonly killGraceMs: number;
  private lastSession: AgentSession | null = null;

  constructor(opts: OmpRunnerOptions = {}) {
    this.bin = opts.bin ?? process.env.CEZ_OMP_BIN ?? (process.env.CEZ_DRY_RUN === '1' ? mockOmpPath() : 'omp');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.settleGraceMs = opts.settleGraceMs ?? SESSION_SETTLE_GRACE_MS;
    this.killGraceMs = opts.killGraceMs ?? KILL_GRACE_MS;
  }

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
    const child = nodeSpawn(this.bin, buildOmpArgs(spec), {
      cwd: spec.cwd,
      env: buildChildEnv({ backend: this.backend, extraEnv: spec.env }),
    });
    let open = true;
    let settled = true;
    let timedOut = false;
    let autoEndTimer: NodeJS.Timeout | undefined;
    let settleGraceTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    /** True once WE asked the process to go (EOF or signal) — a signal exit
     *  after that is cezar's own teardown, not an agent failure (#703). */
    let weClosed = false;
    let ompUi: OmpUiMapperState = createOmpUiState();
    const textChunks: string[] = [];
    const toolCalls: AgentToolCallRecord[] = [];
    let sessionId = spec.sessionId;
    let tokensUsed = 0;
    let spawnError: Error | null = null;
    const stderr: string[] = [];

    child.on('error', (error: NodeJS.ErrnoException) => {
      spawnError = wrapSpawnError(error, this.bin);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => stderr.push(chunk));

    const emitUi = (value: unknown): void => {
      const mapped = mapOmpRpcMessage(value, ompUi);
      ompUi = mapped.state;
      for (const event of mapped.events) opts.onUiEvent?.(event);
    };
    const write = (command: Record<string, unknown>): boolean => {
      if (!open || !child.stdin.writable) return false;
      try {
        child.stdin.write(`${JSON.stringify(command)}\n`);
        return true;
      } catch {
        return false;
      }
    };
    const sendMessage = (content: ContentBlock[]): boolean => {
      const { message, images } = toOmpPrompt(content);
      if (autoEndTimer) {
        clearTimeout(autoEndTimer);
        autoEndTimer = undefined;
      }
      if (
        !write({
          type: 'prompt',
          message,
          ...(images.length > 0 ? { images } : {}),
          ...(!settled ? { streamingBehavior: 'steer' } : {}),
        })
      ) {
        return false;
      }
      const mapped = ompTurnStarted(ompUi);
      ompUi = mapped.state;
      for (const event of mapped.events) opts.onUiEvent?.(event);
      settled = false;
      return true;
    };
    let sigTermSent = false;
    /** SIGTERM first, then — only if the child truly has not exited — SIGKILL
     *  (AGENT_PROTOCOL.md §1: the SIGTERM→SIGKILL watchdog must gate on real
     *  termination via `trackChildExit`, never on `ChildProcess.killed`). */
    const armWatchdog = (): void => {
      const trackedExit = trackChildExit(child);
      const check = (): void => {
        if (child.exitCode != null || trackedExit()) return;
        if (!sigTermSent) {
          sigTermSent = true;
          child.kill('SIGTERM');
        } else {
          child.kill('SIGKILL');
        }
        killTimer = setTimeout(check, this.killGraceMs);
        killTimer.unref?.();
      };
      if (child.exitCode == null) {
        killTimer = setTimeout(check, this.killGraceMs);
        killTimer.unref?.();
      }
    };
    const end = (): void => {
      if (!open) return;
      open = false;
      weClosed = true;
      child.stdin.end();
      armWatchdog();
    };
    const interrupt = (): void => {
      if (!open) return;
      weClosed = true;
      write({ type: 'abort' });
      open = false;
      armWatchdog();
    };
    const maybeAutoEnd = (): void => {
      if (opts.autoEndAfterFirstTurn && open && !autoEndTimer) {
        autoEndTimer = setTimeout(end, AUTO_END_DELAY_MS);
        autoEndTimer.unref?.();
      }
    };
    const armSettleGrace = (): void => {
      if (!opts.autoEndAfterFirstTurn || settleGraceTimer || !open) return;
      settleGraceTimer = setTimeout(() => {
        settleGraceTimer = undefined;
        maybeAutoEnd();
      }, this.settleGraceMs);
      settleGraceTimer.unref?.();
    };

    write({ id: 'cezar-state', type: 'get_state' });
    sendMessage([
      ...(spec.images ?? []),
      {
        type: 'text',
        text: spec.userPrompt,
      },
    ]);

    const limitMs = spec.timeoutMs ?? this.timeoutMs;
    const deadline =
      limitMs > 0
        ? setTimeout(() => {
            timedOut = true;
            interrupt();
          }, limitMs)
        : undefined;
    deadline?.unref?.();

    const result = (async (): Promise<AgentRunResult> => {
      try {
        for await (const line of readNdjson(child.stdout)) {
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            onEvent?.({ type: 'note', message: `omp: skipped unparseable RPC line: ${truncate(line)}` });
            continue;
          }
          emitUi(value);
          if (!isRecord(value)) continue;

          if (value.type === 'response' && value.command === 'get_state' && value.success === true && isRecord(value.data)) {
            const discovered = string(value.data.sessionId);
            if (discovered && discovered !== sessionId) {
              sessionId = discovered;
              onEvent?.({ type: 'session', sessionId: discovered });
            }
          } else if (value.type === 'response' && value.success === false) {
            onEvent?.({ type: 'error', message: rpcError(value) });
          } else if (value.type === 'message_update' && isRecord(value.assistantMessageEvent)) {
            const update = value.assistantMessageEvent;
            if (update.type === 'text_delta' && typeof update.delta === 'string') {
              textChunks.push(update.delta);
              onEvent?.({ type: 'text', text: update.delta });
            }
          } else if (value.type === 'message_end' && isRecord(value.message) && value.message.role === 'assistant') {
            const usage = usageValues(value.message.usage);
            if (usage) {
              tokensUsed += usage.weighted;
              onEvent?.({ type: 'token-usage', tokensUsed });
              if (usage.cost > 0) onEvent?.({ type: 'cost', usd: usage.cost });
            }
          } else if (value.type === 'tool_execution_start') {
            const id = string(value.toolCallId);
            const name = string(value.toolName);
            if (id && name) {
              toolCalls.push({ id, name, input: value.args });
              onEvent?.({ type: 'tool-call', id, tool: name, input: value.args });
            }
          } else if (value.type === 'tool_execution_end') {
            const id = string(value.toolCallId);
            if (id) {
              const resultValue = isRecord(value.result) ? value.result : {};
              onEvent?.({
                type: 'tool-result',
                toolCallId: id,
                result: contentText(resultValue.content) ?? '',
                isError: value.isError === true,
              });
              emitImages(resultValue.content, onEvent);
            }
          } else if (value.type === 'prompt_result') {
            settled = true;
            onEvent?.({ type: 'turn-end' });
            if (value.status === 'error' && isRecord(value.error)) {
              onEvent?.({ type: 'error', message: string(value.error.message) ?? 'omp turn failed' });
            }
            // `sessionSettled: true` means nothing can wake the session; `false`
            // means background work is still owed, and `session_settled` below
            // is the real teardown point (rpc.md "Yield vs settled").
            if (value.sessionSettled !== false) maybeAutoEnd();
            else armSettleGrace();
          } else if (value.type === 'session_settled') {
            if (settleGraceTimer) {
              clearTimeout(settleGraceTimer);
              settleGraceTimer = undefined;
            }
            maybeAutoEnd();
          } else if (value.type === 'extension_error') {
            onEvent?.({ type: 'note', message: string(value.error) ?? 'omp extension error' });
          }
        }
      } finally {
        clearTimeout(deadline);
        if (autoEndTimer) {
          clearTimeout(autoEndTimer);
          autoEndTimer = undefined;
        }
        clearTimeout(settleGraceTimer);
        clearTimeout(killTimer);
        open = false;
      }

      const exitCode = await waitForExit(child);
      if (spawnError) throw spawnError;
      if (timedOut) {
        const message = `omp CLI timed out after ${Math.round((limitMs / 60_000) * 10) / 10}m and was killed`;
        onEvent?.({ type: 'error', message });
        onEvent?.({ type: 'done' });
        return { text: textChunks.join('').trim(), toolCalls, tokensUsed, sessionId };
      }
      // A signal exit after WE asked the process to go (EOF ended, or the
      // watchdog's SIGTERM) is our own teardown, not an agent failure (#703).
      if (exitCode !== 0 && exitCode !== null && !(weClosed && isSignalTerminationExit(exitCode))) {
        const detail = stderr.join('').trim().split('\n').slice(-3).join(' | ');
        const message = `omp CLI exited with code ${exitCode}${detail ? ` — ${detail}` : ''}`;
        onEvent?.({ type: 'error', message });
        throw new Error(message);
      }
      if (!settled) onEvent?.({ type: 'note', message: 'omp RPC session ended before prompt_result' });
      if (tokensUsed === 0) onEvent?.({ type: 'note', message: 'token usage not reported by omp CLI' });
      opts.onUiEvent?.({ type: 'session.ended', reason: ompUi.stopReason });
      onEvent?.({ type: 'done' });
      return { text: textChunks.join('').trim(), toolCalls, tokensUsed, sessionId };
    })();

    const session: AgentSession = {
      result,
      sendMessage,
      end,
      interrupt,
      pid: child.pid,
      get open() {
        return open;
      },
    };
    this.lastSession = session;
    return session;
  }
}

export function buildOmpArgs(spec: AgentRunSpec): string[] {
  const args = ['--mode', 'rpc', '--no-ui'];
  // omp resolves a session by its own session id prefix (`--resume <id>`), the
  // RPC-mode equivalent of cezar's other backends' resume flags.
  if (spec.sessionId && spec.resume) args.push('--resume', spec.sessionId);
  if (spec.systemPrompt) args.push('--append-system-prompt', spec.systemPrompt);
  if (spec.model) args.push('--model', spec.model);
  return args;
}

function toOmpPrompt(content: ContentBlock[]): {
  message: string;
  images: Array<{ type: 'image'; data: string; mimeType: string }>;
} {
  const text: string[] = [];
  const images: Array<{ type: 'image'; data: string; mimeType: string }> = [];
  for (const block of content) {
    if (block.type === 'text') text.push(block.text);
    else images.push({ type: 'image', data: block.source.data, mimeType: block.source.media_type });
  }
  return { message: text.join('\n'), images };
}

function usageValues(value: unknown): { weighted: number; cost: number } | undefined {
  if (!isRecord(value)) return undefined;
  const input = number(value.input) ?? 0;
  const output = number(value.output) ?? 0;
  const cacheRead = number(value.cacheRead) ?? 0;
  const cacheWrite = number(value.cacheWrite) ?? 0;
  const total = number(value.totalTokens);
  const weighted = total ?? input + output + cacheRead + cacheWrite;
  if (weighted <= 0) return undefined;
  const cost = isRecord(value.cost) ? number(value.cost.total) : undefined;
  return { weighted, cost: cost ?? 0 };
}

function emitImages(value: unknown, onEvent?: (event: AgentEvent) => void): void {
  if (!Array.isArray(value)) return;
  for (const part of value) {
    if (isRecord(part) && part.type === 'image') {
      const mediaType = string(part.mediaType) ?? 'image/png';
      const data = string(part.data) ?? string(part.image);
      if (data) onEvent?.({ type: 'image', mediaType, data });
    }
  }
}

function contentText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const parts = value
    .map((part) => (isRecord(part) && part.type === 'text' ? string(part.text) : undefined))
    .filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function rpcError(value: Record<string, unknown>): string {
  const error = isRecord(value.error) ? value.error : undefined;
  return string(error?.message) ?? string(value.message) ?? `omp RPC command ${string(value.command) ?? 'unknown'} failed`;
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  // `Promise.withResolvers` needs an ES2024 lib target this repo does not compile with;
  // the executor form is the house pattern (pi-runner.ts).
  return new Promise((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.once('exit', (code) => resolve(code));
  });
}

function wrapSpawnError(error: NodeJS.ErrnoException, bin: string): Error {
  if (error.code === 'ENOENT') return new Error(`omp CLI not found (${bin}) — install it or set CEZ_OMP_BIN`);
  return error;
}

/** Path to the bundled mock (`scripts/mock-omp-rpc.mjs`), for CEZ_DRY_RUN=1. */
function mockOmpPath(): string {
  // Resolved the same way `mockPiPath` is, rather than through `new URL().pathname`:
  // on Windows that yields a leading-slash `/C:/…` which `spawn` cannot execute.
  const here = dirname(fileURLToPath(import.meta.url));
  // here = <pkg>/dist/core (built) or <pkg>/src/core (tsx dev).
  return resolvePath(here, '..', '..', 'scripts', 'mock-omp-rpc.mjs');
}

function truncate(value: string, max = 200): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}