import type { Config } from '../config/config.model.js';

/** The resolved `autofix.projectEnv` block (zod always supplies defaults). */
export type ProjectEnvSpec = NonNullable<Config['autofix']>['projectEnv'];

/** A running dev server the agent can probe. */
export interface DevServerHandle {
  /** Base URL the agent can hit, e.g. `http://127.0.0.1:54213`. */
  url: string;
  /** Did the readiness probe get an HTTP response within the timeout? */
  ready: boolean;
  /** Stop the server. Also called implicitly by `RunEnv.dispose()`. */
  stop(): Promise<void>;
}

/** Outcome of running one command inside a `RunEnv`. */
export interface ShellResult {
  /** The command as Cezar invoked it (for the cockpit / comment). */
  command: string;
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/**
 * A runnable project environment bound to one worktree. Two implementations:
 *  - `NativeShellEnv` — runs commands directly on the host, in the worktree.
 *  - `DockerComposeEnv` — runs commands inside a per-run `docker compose`
 *    project, with the worktree bind-mounted into the app service.
 *
 * The autofix workflow's `shell-check` steps drive `install` / `build` /
 * `test`; a `null` return means the command was not configured (skip the step).
 * Lifecycle: `dispose()` is always called once, even on failure.
 */
export interface RunEnv {
  readonly kind: 'native' | 'compose';
  /** The configured install command, or `null` when unset. */
  install(onLine?: (line: string) => void): Promise<ShellResult | null>;
  /** The configured build command, or `null` when unset. */
  build(onLine?: (line: string) => void): Promise<ShellResult | null>;
  /** The configured test command, or `null` when unset. */
  test(onLine?: (line: string) => void): Promise<ShellResult | null>;
  /** Run an arbitrary command in the env. */
  run(command: string, onLine?: (line: string) => void): Promise<ShellResult>;
  /**
   * Boot the configured dev server and wait (best-effort) for it to respond.
   * Returns `null` when no dev server is configured/enabled. Idempotent — a
   * second call returns the same handle. The server is also stopped by
   * `dispose()`.
   */
  startDevServer(onLine?: (line: string) => void): Promise<DevServerHandle | null>;
  /** Tear the env down (stops the dev server; compose: `down -v`; native: no-op). Idempotent. */
  dispose(): Promise<void>;
}

/**
 * Poll `url` until it returns any HTTP response or `timeoutMs` elapses. "Any
 * response" (even a 4xx/5xx) means the server is listening — good enough for a
 * readiness gate. Returns the final status, or `null` on timeout.
 */
export async function waitForHttp(
  url: string,
  timeoutMs: number,
  intervalMs = 750,
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(Math.min(5000, intervalMs * 4)),
      });
      return res.status;
    } catch {
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

/** Keep only the last `maxLines` lines of `text` — for failure tails in comments / prompts. */
export function tailLines(text: string, maxLines = 40): string {
  const lines = text.split('\n');
  return lines.slice(-maxLines).join('\n').trim();
}
