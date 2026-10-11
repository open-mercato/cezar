import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { trackChildExit } from './agent-runner.ts';
import { buildChildEnv } from './agent-env.ts';
import { EOF_KILL_GRACE_MS, EOF_TERM_GRACE_MS, KILL_GRACE_MS } from './claude-cli-runner.ts';

export interface JunieAcpMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown } | unknown;
}

interface PendingRequest {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

export function resolveJunieExecutable(override?: string): string {
  if (override) return override;
  if (process.env.CEZ_JUNIE_BIN) return process.env.CEZ_JUNIE_BIN;
  // CEZ_DRY_RUN=1 swaps in the bundled mock so the cockpit / store / GUI can
  // be exercised without a logged-in junie or burning tokens — same posture
  // as claude/pi (#M5 review: the spec always claimed this, the wiring was
  // just missing).
  return process.env.CEZ_DRY_RUN === '1' ? mockJuniePath() : 'junie';
}

/** Path to the bundled mock (`scripts/mock-junie-acp.mjs`), for CEZ_DRY_RUN=1. */
function mockJuniePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // here = <pkg>/dist/core (built) or <pkg>/src/core (tsx dev).
  return resolvePath(here, '..', '..', 'scripts', 'mock-junie-acp.mjs');
}

export function buildJunieAcpEnv(extraEnv?: Record<string, string>): NodeJS.ProcessEnv {
  return buildChildEnv({ backend: 'junie', extraEnv });
}

/**
 * Spawn `junie --acp=true -p <cwd>` — the real Agent Client Protocol (ACP)
 * transport the CLI documents as "for IDE integrations" (`junie --help`,
 * `Acp:` section). Verified live against `@jetbrains/junie` 26.9.22: JSON-RPC
 * 2.0, newline-delimited, over stdin/stdout — the same shape as
 * `codex app-server`. `-p <cwd>` matches the project directory to the run's
 * working directory (junie also honors `EJ_RUNNER_PWD`, set by its own shim
 * from the spawning process's cwd, so `cwd` alone is sufficient here).
 */
export function spawnJunieAcp(
  bin: string,
  cwd: string,
  extraEnv?: Record<string, string>,
): ChildProcessWithoutNullStreams {
  try {
    return nodeSpawn(bin, ['--acp=true', '-p', cwd], {
      cwd,
      env: buildJunieAcpEnv(extraEnv),
    });
  } catch (error) {
    throw junieSpawnError(error, bin);
  }
}

/** Minimal newline-JSON request correlator — identical contract to
 *  `CodexAppServerRpc`, kept as its own type so a junie-specific error
 *  vocabulary (`junieErrorText`) does not leak into the codex transport. */
export class JunieAcpRpc {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    // A write to a child that already exited reports EPIPE as an async 'error' event, not
    // a throw, so the try/catch in `write` cannot see it. Unhandled, it crashes the host —
    // and `discoverJunieModels` reaches `endJunieAcp` on every provider-status probe. The
    // read/exit path owns settlement.
    child.stdin.on('error', () => {});
  }

  allocateId(): number {
    return this.nextId++;
  }

  request(method: string, params: unknown): Promise<Record<string, unknown>> {
    const id = this.allocateId();
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.write({ jsonrpc: '2.0', id, method, params });
    return promise;
  }

  /** `session/cancel` is a NOTIFICATION on junie's wire, not a request —
   *  verified live: sending it with an `id` gets "Method not supported"
   *  (the request dispatcher has no such method), while the bare notification
   *  is accepted and the in-flight `session/prompt` resolves `cancelled`. */
  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  /** Answer a server→client request (`session/request_permission`). */
  respond(message: { id: number | string; result?: unknown; error?: unknown }): void {
    this.write({ jsonrpc: '2.0', ...message });
  }

  dispatchResponse(message: JunieAcpMessage): boolean {
    if (typeof message.id !== 'number' || (message.result === undefined && message.error === undefined)) return false;
    const pending = this.pending.get(message.id);
    if (!pending) return false;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(junieErrorText(message.error)));
    else pending.resolve((message.result as Record<string, unknown>) ?? {});
    return true;
  }

  rejectPending(message = 'junie exited'): void {
    for (const request of this.pending.values()) request.reject(new Error(message));
    this.pending.clear();
  }

  private write(message: unknown): void {
    if (this.child.stdin.destroyed) return;
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      // The read/exit path owns settlement when stdin disappears.
    }
  }
}

/**
 * Close stdin, then escalate SIGTERM→SIGKILL for a process that ignores EOF.
 * Identical shape to `endCodexAppServer` — junie's shim installs its own
 * signal handlers (`128 + signal` exit), so the caller needs to know a
 * non-zero exit was its own doing, not a junie failure (#703 precedent).
 */
export function endJunieAcp(
  child: ChildProcessWithoutNullStreams,
  onTimers?: (term: NodeJS.Timeout, kill: NodeJS.Timeout | undefined) => void,
  onSignal?: () => void,
): void {
  try {
    child.stdin.end();
  } catch {
    // already gone
  }
  const hasExited = trackChildExit(child);
  let killTimer: NodeJS.Timeout | undefined;
  const termTimer = setTimeout(() => {
    if (!hasExited()) {
      onSignal?.();
      child.kill('SIGTERM');
    }
    killTimer = setTimeout(() => {
      if (!hasExited()) {
        onSignal?.();
        child.kill('SIGKILL');
      }
    }, EOF_KILL_GRACE_MS);
    killTimer.unref?.();
    onTimers?.(termTimer, killTimer);
  }, EOF_TERM_GRACE_MS);
  termTimer.unref?.();
  onTimers?.(termTimer, killTimer);
}

export function waitForJunieAcpExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode != null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(safety);
      resolve(code);
    };
    child.once('close', (code) => finish(code));
    child.once('exit', (code) => finish(code));
    child.once('error', () => finish(child.exitCode ?? null));
    const safety = setTimeout(
      () => finish(child.exitCode ?? null),
      EOF_TERM_GRACE_MS + EOF_KILL_GRACE_MS + KILL_GRACE_MS + 5_000,
    );
    safety.unref?.();
  });
}

export function junieSpawnError(error: unknown, bin: string): Error {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    // `.code` travels with the error so callers (the provider-status probe) can tell "not
    // installed" apart from any other spawn failure without parsing this message.
    return Object.assign(
      new Error(
        `\`${bin}\` not found on PATH — install Junie (https://junie.jetbrains.com/cli) and run \`junie\` once to log in`,
      ),
      { code: 'ENOENT' },
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

function junieErrorText(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return typeof error === 'string' ? error : JSON.stringify(error);
}
