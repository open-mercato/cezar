import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { prependSystemPrompt, trackChildExit } from './agent-runner.ts';
import { buildChildEnv } from './agent-env.ts';
import { disclaimedCommand } from './disclaim-spawn.ts';
import { readNdjson } from './ndjson.ts';
import { createAntigravityUiState, mapAntigravityMessage } from './antigravity-ui-mapper.ts';

const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const KILL_GRACE_MS = 10_000;
const AUTO_END_DELAY_MS = 250;

export const resolveAntigravityBin = (bin?: string): string => bin || process.env.CEZ_AGY_BIN || 'agy';
/** Path to the bundled mock (`scripts/mock-antigravity.mjs`), for CEZ_DRY_RUN=1. */
export const mockAntigravityPath = (): string =>
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'mock-antigravity.mjs');

export interface AntigravityRunnerOptions {
  /** Override the binary name/path; defaults to `agy` on PATH (`CEZ_AGY_BIN`). */
  bin?: string;
  /** Wall-clock timeout for a run (ms); per-spec `timeoutMs` still wins. */
  timeoutMs?: number;
  killGraceMs?: number;
}

/**
 * agy has no system-prompt flag and takes its prompt from stdin in stream-json mode, so the whole
 * opening message travels on stdin — never on the command line, which Windows caps at 32K chars.
 * `-p=` (an EMPTY print prompt) must stay last: agy's `-p` takes the next argv word as its value.
 */
export function buildAntigravityArgs(spec: AgentRunSpec): string[] {
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--dangerously-skip-permissions'];
  if (spec.model?.trim()) args.push('--model', spec.model.trim());
  if (spec.resume && spec.sessionId) args.push('--conversation', spec.sessionId);
  for (const dir of spec.additionalDirectories ?? []) args.push('--add-dir', dir);
  return [...args, '-p='];
}

/** One stdin turn: `{"event":"user","message":{"content":"…"}}` (verified against agy 1.4.0). */
export function antigravityUserFrame(content: string): string {
  return `${JSON.stringify({ event: 'user', message: { content } })}\n`;
}

/**
 * Persistent subprocess adapter for the Antigravity CLI's headless stream-json mode.
 *
 * One `agy` process per session: each `sendMessage` writes one stdin frame and agy answers with a
 * turn of `step_update` frames closed by a `result` (`antigravity-ui-mapper.ts`). Closing stdin
 * ends the session; agy exits 0 once the in-flight turn is done. `--dangerously-skip-permissions`
 * is cezar's zero-config "approve everything" mode, the same trust stance as the other CLIs — a
 * worktree is not an OS sandbox.
 */
export class AntigravityRunner implements AgentRunner {
  readonly backend = 'antigravity' as const;
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly killGraceMs: number;
  private lastSession: AgentSession | null = null;

  constructor(opts: AntigravityRunnerOptions = {}) {
    this.bin = opts.bin || process.env.CEZ_AGY_BIN || (process.env.CEZ_DRY_RUN === '1' ? mockAntigravityPath() : 'agy');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.killGraceMs = opts.killGraceMs ?? KILL_GRACE_MS;
  }

  run(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void): Promise<AgentRunResult> {
    return this.startSession(spec, onEvent, { autoEndAfterFirstTurn: true }).result;
  }

  async interrupt(): Promise<void> {
    this.lastSession?.interrupt();
  }

  startSession(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void, opts: SessionOptions = {}): AgentSession {
    const env = buildChildEnv({ backend: this.backend, extraEnv: spec.env });
    const args = buildAntigravityArgs(spec);
    // The dry-run mock is a node script; on Windows `disclaimedCommand` already routes scripts to
    // node, elsewhere it relies on the shebang — be explicit so a non-executable checkout works.
    const script = /\.[cm]?js$/.test(this.bin);
    const [file, argv] = disclaimedCommand(script ? process.execPath : this.bin, script ? [this.bin, ...args] : args, env);
    const child: ChildProcessWithoutNullStreams = spawn(file, argv, { cwd: spec.cwd, env });
    const hasExited = trackChildExit(child);
    let open = true;
    let stopRequested = false;
    let timedOut = false;
    let authRequired = false;
    let turnInFlight = false;
    let spawnError: Error | null = null;
    let autoEndTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let state = createAntigravityUiState(spec.resume ? spec.sessionId : undefined);
    const textChunks: string[] = [];
    const toolCalls: AgentToolCallRecord[] = [];
    let sessionId = spec.sessionId;
    let stderr = '';
    let turnError: string | undefined;

    const emit = (event: AgentEvent): void => {
      if (event.type === 'text') textChunks.push(event.text);
      if (event.type === 'session') sessionId = event.sessionId;
      if (event.type === 'tool-call') toolCalls.push({ id: event.id, name: event.tool, input: event.input });
      if (event.type === 'error') turnError = event.message;
      onEvent?.(event);
    };

    child.on('error', (error: NodeJS.ErrnoException) => {
      spawnError =
        error.code === 'ENOENT'
          ? new Error(`\`${this.bin}\` not found on PATH — install the Antigravity CLI and run \`agy\` once to sign in`)
          : error;
    });
    child.stdin.on('error', () => {
      /* agy exited first; the exit path reports why */
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-16_384);
      if (!authRequired && /authentication required|please sign in|not authenticated/i.test(stderr)) {
        authRequired = true;
        hardStop();
      }
    });

    const write = (frame: string): boolean => {
      if (!open || !child.stdin.writable) return false;
      try {
        child.stdin.write(frame);
        return true;
      } catch {
        return false;
      }
    };
    const sendMessage = (content: ContentBlock[]): boolean => {
      const text = content
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      const images = content.length - content.filter((block) => block.type === 'text').length;
      if (images > 0) {
        emit({
          type: 'note',
          message: `antigravity: agy's headless input carries text only — ${images} image(s) were not attached`,
        });
      }
      if (!text.trim()) return false;
      if (autoEndTimer) {
        clearTimeout(autoEndTimer);
        autoEndTimer = undefined;
      }
      if (!write(antigravityUserFrame(text))) return false;
      turnInFlight = true;
      // An earlier turn's error must not explain a later exit.
      turnError = undefined;
      return true;
    };
    const armKill = (): void => {
      if (killTimer || hasExited()) return;
      killTimer = setTimeout(() => {
        if (hasExited()) return;
        child.kill('SIGTERM');
        const hard = setTimeout(() => {
          if (!hasExited()) child.kill('SIGKILL');
        }, this.killGraceMs);
        hard.unref?.();
      }, this.killGraceMs);
      killTimer.unref?.();
    };
    const end = (): void => {
      if (!open) return;
      open = false;
      stopRequested = true;
      child.stdin.end();
      armKill();
    };
    const interrupt = (): void => {
      stopRequested = true;
      open = false;
      if (!hasExited()) child.kill('SIGTERM');
      armKill();
    };
    const hardStop = (): void => {
      interrupt();
      const hard = setTimeout(() => {
        if (!hasExited()) child.kill('SIGKILL');
      }, this.killGraceMs);
      hard.unref?.();
    };

    sendMessage([...(spec.images ?? []), { type: 'text', text: prependSystemPrompt(spec.systemPrompt, spec.userPrompt) }]);

    const limitMs = spec.timeoutMs ?? this.timeoutMs;
    const deadline =
      limitMs > 0
        ? setTimeout(() => {
            timedOut = true;
            hardStop();
          }, limitMs)
        : undefined;
    deadline?.unref?.();

    const result = (async (): Promise<AgentRunResult> => {
      try {
        for await (const line of readNdjson(child.stdout)) {
          let frame: unknown;
          try {
            frame = JSON.parse(line);
          } catch {
            continue;
          }
          const mapped = mapAntigravityMessage(frame, state);
          state = mapped.state;
          for (const event of mapped.events) opts.onUiEvent?.(event);
          for (const event of mapped.agentEvents) emit(event);
          if ((frame as { event?: unknown } | null)?.event === 'result') {
            turnInFlight = false;
            emit({ type: 'turn-end' });
            if (opts.autoEndAfterFirstTurn && open && !autoEndTimer) {
              autoEndTimer = setTimeout(end, AUTO_END_DELAY_MS);
              autoEndTimer.unref?.();
            }
          }
        }
      } catch (error) {
        if (!stopRequested && !spawnError) throw error;
      } finally {
        if (deadline) clearTimeout(deadline);
        if (autoEndTimer) clearTimeout(autoEndTimer);
        open = false;
      }

      const exitCode = await waitForExit(child);
      if (killTimer) clearTimeout(killTimer);
      const fail = (message: string, reason: 'error' | 'timeout' = 'error', reported = false): never => {
        if (!reported) emit({ type: 'error', message });
        opts.onUiEvent?.({ type: 'session.error', message, fatal: true });
        opts.onUiEvent?.({ type: 'session.ended', reason, message });
        throw new Error(message);
      };
      if (spawnError) fail((spawnError as Error).message);
      if (authRequired) fail('Antigravity authentication failed — run `agy` in a terminal and sign in with your Google account.');
      if (timedOut) fail(`Antigravity CLI timed out after ${Math.round((limitMs / 60_000) * 10) / 10}m and was killed`, 'timeout');
      // A stop cezar asked for is never an agent failure (#703) — on Windows a killed agy exits 1,
      // not 128+signal, so the flag decides rather than `isSignalTerminationExit` alone.
      if (exitCode !== 0 && exitCode !== null && !stopRequested) {
        // A turn-level `result` error (an unknown `--model`, a rejected request) makes agy exit 1
        // right after it; the mapper already reported that message — surface it, not the exit code.
        if (turnError) fail(turnError, 'error', true);
        const detail = stderr.trim().split(/\r?\n/).slice(-3).join(' | ');
        fail(`Antigravity CLI exited with code ${exitCode}${detail ? ` — ${detail}` : ''}`);
      }
      if (turnInFlight) emit({ type: 'note', message: 'antigravity: the session ended before the turn finished' });
      if (state.tokensUsed === 0) emit({ type: 'note', message: 'token usage not reported by the Antigravity CLI' });
      opts.onUiEvent?.({ type: 'session.ended', reason: turnInFlight ? 'cancelled' : state.stopReason });
      emit({ type: 'done' });
      return { text: textChunks.join('\n').trim(), toolCalls, tokensUsed: state.tokensUsed, sessionId };
    })();

    const session: AgentSession = {
      result,
      sendMessage,
      end,
      interrupt,
      hardStop,
      pid: child.pid,
      get open() {
        return open;
      },
    };
    this.lastSession = session;
    return session;
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit) => child.once('close', resolveExit));
}
