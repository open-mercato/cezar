import { renameSync } from 'node:fs';

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

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !TRANSIENT_CODES.has(code) || attempt >= RETRY_DELAYS_MS.length) throw error;
      sleep(RETRY_DELAYS_MS[attempt]!);
    }
  }
}
