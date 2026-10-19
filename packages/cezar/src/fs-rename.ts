import { promises as fsp, renameSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * `renameSync` that survives Windows' transient sharing violations (telemetry 4a7c9f6c).
 *
 * Replacing a file on Windows fails with `EPERM`/`EACCES`/`EBUSY` while ANY process holds the
 * target open without `FILE_SHARE_DELETE` — Defender scanning the file we just wrote, the search
 * indexer, a backup agent, an editor. Those handles live for milliseconds, so the same rename
 * succeeds a moment later; graceful-fs retries for the same reason. Bounded (~1 s total), and
 * only on win32: on POSIX those codes are real permission errors and retrying would only delay
 * the failure.
 */
const TRANSIENT_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 250, 450];

export interface RenameRetryOptions {
  platform?: NodeJS.Platform;
  rename?: (from: string, to: string) => void;
  sleep?: (ms: number) => void;
}

export interface AsyncRenameRetryOptions {
  platform?: NodeJS.Platform;
  rename?: (from: string, to: string) => Promise<void>;
  sleep?: (ms: number) => Promise<unknown>;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The retry delay for this failure, or undefined when it must be rethrown. */
function retryDelay(error: unknown, attempt: number): number | undefined {
  const code = (error as NodeJS.ErrnoException).code;
  if (!code || !TRANSIENT_CODES.has(code)) return undefined;
  return RETRY_DELAYS_MS[attempt];
}

export function renameSyncWithRetry(from: string, to: string, options: RenameRetryOptions = {}): void {
  const rename = options.rename ?? renameSync;
  if ((options.platform ?? process.platform) !== 'win32') {
    rename(from, to);
    return;
  }
  const sleep = options.sleep ?? sleepSync;
  for (let attempt = 0; ; attempt += 1) {
    try {
      rename(from, to);
      return;
    } catch (error) {
      const ms = retryDelay(error, attempt);
      if (ms === undefined) throw error;
      sleep(ms);
    }
  }
}

/** Async twin of `renameSyncWithRetry`: same policy, but it awaits a timer instead of blocking the event loop. */
export async function renameWithRetry(from: string, to: string, options: AsyncRenameRetryOptions = {}): Promise<void> {
  // Looked up per call so a test's spy on `fs.promises.rename` still sees the write.
  const rename = options.rename ?? ((a: string, b: string) => fsp.rename(a, b));
  if ((options.platform ?? process.platform) !== 'win32') {
    await rename(from, to);
    return;
  }
  const sleep = options.sleep ?? delay;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const ms = retryDelay(error, attempt);
      if (ms === undefined) throw error;
      await sleep(ms);
    }
  }
}
