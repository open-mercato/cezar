import { spawn } from 'node:child_process';

export interface SetupCommandResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface SetupCommandOptions {
  /** Hard wall-clock limit for the command. Defaults to 10 minutes. */
  timeoutMs?: number;
  /** Grace period after SIGTERM before SIGKILL on timeout. Defaults to 5s. */
  killGraceMs?: number;
  /** Cap each of stdout/stderr to this many bytes (tail kept). Defaults to 64 KB. */
  maxCaptureBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 5 * 1000;
const DEFAULT_MAX_CAPTURE_BYTES = 64 * 1024;

/** Appends to a captured buffer while keeping only the last `max` bytes. */
function appendBounded(buffer: string, text: string, max: number): string {
  const next = buffer + text;
  return next.length > max ? next.slice(next.length - max) : next;
}

/**
 * Runs a single user-configured setup command (e.g. `yarn install`,
 * `yarn migrate`) inside the worktree. Output is streamed to `onLine` as it
 * arrives so the cockpit can show progress for long-running installs.
 *
 * Uses shell mode because users will typically write commands the way they'd
 * type them in a terminal (with pipes, env-vars, etc.). Trust boundary is the
 * same as a CI script — the worktree is a clone of the user's own repo and
 * the command list is configured by the workspace admin.
 *
 * Hardening against a wedged/runaway command (per-workspace config can DoS a
 * shared dispatch worker otherwise):
 * - a hard `timeoutMs` wall clock (SIGTERM, then SIGKILL after a grace period);
 * - stdin is detached so an interactive credential prompt errors out instead of
 *   blocking forever;
 * - captured stdout/stderr are bounded to the last `maxCaptureBytes` (the tail
 *   is all any caller reads anyway).
 */
export function runSetupCommand(
  command: string,
  cwd: string,
  onLine?: (line: string) => void,
  options: SetupCommandOptions = {},
): Promise<SetupCommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const maxCaptureBytes = options.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES;

  return new Promise((resolve) => {
    // stdin is ignored so an interactive prompt (e.g. a missing credential
    // helper) fails fast instead of hanging on a read from a closed pipe.
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // Escalate to SIGKILL if the process ignores SIGTERM.
      killTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
    };

    const finish = (result: SetupCommandResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const handleChunk = (kind: 'out' | 'err') => (chunk: Buffer) => {
      const text = chunk.toString();
      if (kind === 'out') stdout = appendBounded(stdout, text, maxCaptureBytes);
      else stderr = appendBounded(stderr, text, maxCaptureBytes);
      if (onLine) {
        for (const line of text.split('\n')) {
          const trimmed = line.trimEnd();
          if (trimmed) onLine(trimmed);
        }
      }
    };

    child.stdout?.on('data', handleChunk('out'));
    child.stderr?.on('data', handleChunk('err'));
    child.on('error', (err) => {
      finish({ ok: false, exitCode: null, stdout, stderr: stderr + `\n${err.message}`, timedOut });
    });
    child.on('close', (code) => {
      const stderrOut = timedOut
        ? stderr + `\nsetup command timed out after ${timeoutMs}ms`
        : stderr;
      finish({ ok: !timedOut && code === 0, exitCode: code, stdout, stderr: stderrOut, timedOut });
    });
  });
}
