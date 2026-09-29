/**
 * Cursor Agent CLI runner (`agent`) — headless print mode.
 *
 * Continue / multi-turn: v1 is fresh-session only (print mode exits when done).
 * `sendMessage` returns false and emits a note; a follow-up run starts a new
 * `agent -p` process. Resume via Cursor `--resume` is a future enhancement.
 *
 * Emits v1 `AgentEvent`s and, when `opts.onUiEvent` is set, protocol v2
 * `UiEvent`s alongside (same pattern as claude/codex/opencode).
 */

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
import { isSignalTerminationExit, prependSystemPrompt } from './agent-runner.ts';
import { buildChildEnv } from './agent-env.ts';
import { readNdjson } from './ndjson.ts';
import {
  createCursorUiState,
  mapCursorMessage,
  mapCursorStreamEvent,
  type CursorUiMapping,
} from './cursor-ui-mapper.ts';

export const DEFAULT_CURSOR_TIMEOUT_MS = 30 * 60_000;
export const CURSOR_KILL_GRACE_MS = 10_000;

export interface CursorAgentRunnerOptions {
  bin?: string;
  timeoutMs?: number;
}

export type BuildCursorArgsInput = {
  userPrompt: string;
  systemPrompt?: string;
  model?: string;
};

/** CLI argv for headless write mode (prompt is the final positional). */
export function buildCursorArgs(input: BuildCursorArgsInput): string[] {
  const prompt = prependSystemPrompt(input.systemPrompt, input.userPrompt);
  const args = ['-p', '--force', '--trust', '--output-format', 'stream-json'];
  if (input.model?.trim()) {
    args.push('--model', input.model.trim());
  }
  args.push(prompt);
  return args;
}

/** Path to the bundled mock (`scripts/mock-cursor-agent.mjs`), for CEZ_DRY_RUN=1 — shipped
 *  alongside `scripts/mock-claude.mjs` so packaged installs can dry-run Cursor too. */
export function mockCursorAgentPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // here = <pkg>/dist/core (built) or <pkg>/src/core (tsx dev).
  return resolvePath(here, '..', '..', 'scripts', 'mock-cursor-agent.mjs');
}

/** The real Cursor binary name — `CEZ_CURSOR_AGENT_BIN` override, else `agent` on PATH. Shared
 *  by every call site that shells out to the real CLI (identity, model discovery, detection),
 *  so an operator's override is honored consistently instead of four separate `?? 'agent'`s. */
export function resolveCursorAgentBin(optsBin?: string): string {
  return optsBin || process.env.CEZ_CURSOR_AGENT_BIN || 'agent';
}

/** Like {@link resolveCursorAgentBin}, but under `CEZ_DRY_RUN=1` substitutes the bundled mock —
 *  only for actually spawning a run turn. The mock does not implement `status`/`about`/`models`
 *  subcommands, so identity and model-discovery call sites use {@link resolveCursorAgentBin}
 *  directly and keep talking to the real binary (or failing closed) even under dry-run. */
export function resolveCursorBin(optsBin?: string): string {
  if (optsBin) return optsBin;
  if (process.env.CEZ_CURSOR_AGENT_BIN) return process.env.CEZ_CURSOR_AGENT_BIN;
  if (process.env.CEZ_DRY_RUN === '1') return mockCursorAgentPath();
  return 'agent';
}

function wrapSpawnError(err: unknown, bin: string): Error {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    return new Error(
      `\`${bin}\` not found on PATH — install the Cursor CLI (curl https://cursor.com/install -fsS | bash) and run \`agent login\` (or set CEZ_CURSOR_AGENT_BIN)`,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode != null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    const fin = (code: number | null) => resolve(code);
    child.once('close', fin);
    child.once('exit', fin);
    child.once('error', () => fin(child.exitCode ?? null));
  });
}

export class CursorAgentRunner implements AgentRunner {
  readonly backend = 'cursor' as const;

  private readonly bin: string;
  private readonly timeoutMs: number;
  private lastSession: AgentSession | null = null;

  constructor(opts: CursorAgentRunnerOptions = {}) {
    this.bin = resolveCursorBin(opts.bin);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_CURSOR_TIMEOUT_MS;
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
    const args = buildCursorArgs({
      userPrompt: spec.userPrompt,
      systemPrompt: spec.systemPrompt,
      model: spec.model,
    });

    let child: ChildProcessWithoutNullStreams;
    try {
      const isNodeScript = /\.[cm]?js$/.test(this.bin);
      child = nodeSpawn(
        isNodeScript ? process.execPath : this.bin,
        isNodeScript ? [this.bin, ...args] : args,
        {
          cwd: spec.cwd,
          env: buildChildEnv({ backend: this.backend, extraEnv: spec.env }),
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`failed to spawn Cursor agent (${this.bin}): ${message}`);
    }

    // `spawn` reports a missing/unresolvable binary asynchronously via 'error' (process.nextTick),
    // not by throwing — an unhandled 'error' event crashes the whole cezar process. This listener
    // must be attached synchronously, before any await, same as claude-cli-runner.ts.
    let spawnFailed: Error | null = null;
    child.on('error', (err: NodeJS.ErrnoException) => {
      spawnFailed = wrapSpawnError(err, this.bin);
    });

    const toolCalls: AgentToolCallRecord[] = [];
    const textChunks: string[] = [];
    let sessionId = spec.sessionId;
    let tokensUsed = 0;
    let open = true;
    let terminatedByCezar = false;
    let timedOut = false;
    // A `result` frame with `is_error: true` can still exit 0 — the stream is the source of
    // truth for whether the turn failed, not the process exit code.
    let resultError: string | undefined;
    const stderrChunks: string[] = [];

    let uiState = createCursorUiState({ fallbackSessionId: spec.sessionId });
    const emitUi = (map: (state: typeof uiState) => CursorUiMapping): void => {
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

    const emit = (event: AgentEvent) => {
      if (event.type === 'text') textChunks.push(event.text);
      if (event.type === 'tool-call') {
        toolCalls.push({ id: event.id, name: event.tool, input: event.input });
      }
      if (event.type === 'session') sessionId = event.sessionId;
      if (event.type === 'token-usage') tokensUsed = event.tokensUsed;
      if (event.type === 'error') resultError = event.message;
      onEvent?.(event);
    };

    const limitMs = spec.timeoutMs ?? this.timeoutMs;
    let deadline: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    if (limitMs > 0) {
      deadline = setTimeout(() => {
        timedOut = true;
        terminatedByCezar = true;
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }, CURSOR_KILL_GRACE_MS);
        killTimer.unref?.();
      }, limitMs);
      deadline.unref?.();
    }

    const result = (async (): Promise<AgentRunResult> => {
      try {
        for await (const line of readNdjson(child.stdout)) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          emitUi((state) => mapCursorMessage(parsed, state));
          for (const event of mapCursorStreamEvent(parsed)) emit(event);
        }
      } catch {
        if (!timedOut) {
          /* premature close — fall through to exit handling */
        }
      } finally {
        if (deadline) clearTimeout(deadline);
        if (killTimer) clearTimeout(killTimer);
        open = false;
      }

      const exitCode = await waitForExit(child);
      const text = textChunks.join('').trim();

      if (spawnFailed) throw spawnFailed;

      if (timedOut) {
        const mins = Math.round((limitMs / 60_000) * 10) / 10;
        onEvent?.({ type: 'error', message: `cursor agent timed out after ${mins}m and was killed` });
        onEvent?.({ type: 'done' });
        return { text, toolCalls, tokensUsed, sessionId };
      }

      if (terminatedByCezar && isSignalTerminationExit(exitCode)) {
        onEvent?.({
          type: 'note',
          message: `cursor agent terminated by cezar (code ${exitCode})`,
        });
        onEvent?.({ type: 'done' });
        return { text, toolCalls, tokensUsed, sessionId };
      }

      if (exitCode !== 0 && exitCode !== null) {
        const stderr = stderrChunks.join('').trim();
        const detail = stderr ? ` — ${stderr.split('\n').slice(-3).join(' | ')}` : '';
        const msg = `cursor agent exited with code ${exitCode}${detail}`;
        onEvent?.({ type: 'error', message: msg });
        throw new Error(msg);
      }

      // A `result` frame reporting `is_error: true` while the process still exits 0 — the
      // stream already emitted its own `error` event; do not also report success.
      if (resultError) throw new Error(resultError);

      onEvent?.({ type: 'done' });
      return { text, toolCalls, tokensUsed, sessionId };
    })();

    child.stderr.on('data', (buf: Buffer) => {
      stderrChunks.push(buf.toString('utf8'));
    });

    const interrupt = () => {
      terminatedByCezar = true;
      open = false;
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    };

    const session: AgentSession = {
      result,
      pid: child.pid,
      sendMessage(_content: ContentBlock[]): boolean {
        onEvent?.({
          type: 'note',
          message:
            'Cursor print mode is one-shot in v1 — Continue starts a fresh session instead of resuming.',
        });
        return false;
      },
      end() {
        interrupt();
      },
      interrupt,
      get open() {
        return open;
      },
    };

    this.lastSession = session;
    return session;
  }
}
