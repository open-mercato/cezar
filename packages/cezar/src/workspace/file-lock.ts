import { AsyncLocalStorage } from 'node:async_hooks';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

import { assertCezarHomeWriteIsSandboxed } from '../paths.ts';

/** Cross-process mkdir lock. A live owner is never stolen, however old it is. */
export const FILE_LOCK_TIMEOUT_MS = 10_000;
const EMPTY_LOCK_GRACE_MS = 60_000;

export class FileLockTimeoutError extends Error {
  constructor(message = 'The workspace is busy. Try again.') {
    super(message);
    this.name = 'FileLockTimeoutError';
  }
}

const held = new AsyncLocalStorage<Set<string>>();

/**
 * Serialize writers across processes. A caller that already holds `lockDir` on this
 * async stack re-enters instead of waiting on itself (spec §4.6.3).
 */
export async function withFileLock<T>(
  lockDir: string,
  action: () => Promise<T>,
  timeoutMs = FILE_LOCK_TIMEOUT_MS,
): Promise<T> {
  const current = held.getStore();
  if (current?.has(lockDir)) return action();
  assertCezarHomeWriteIsSandboxed(lockDir);
  await acquire(lockDir, timeoutMs);
  const next = new Set(current);
  next.add(lockDir);
  try {
    return await held.run(next, action);
  } finally {
    await release(lockDir);
  }
}

async function acquire(lockDir: string, timeoutMs: number): Promise<void> {
  const owner = join(lockDir, String(process.pid));
  const parent = dirname(lockDir);
  const started = Date.now();
  for (;;) {
    // Exclusive mkdir is the lock, so it cannot be recursive. A fresh CEZ_HOME
    // has no directory yet — create the parent or the first write dies ENOENT.
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    try {
      await fs.mkdir(lockDir, { mode: 0o700 });
      try {
        await fs.writeFile(owner, '', { flag: 'wx', mode: 0o600 });
      } catch (error) {
        await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() - started >= timeoutMs) throw new FileLockTimeoutError();
      await recoverDeadOwner(lockDir);
      await new Promise((done) => setTimeout(done, 10));
    }
  }
}

async function recoverDeadOwner(lockDir: string): Promise<void> {
  const info = await fs.lstat(lockDir).catch(() => null);
  if (!info) return;
  const owners = await fs.readdir(lockDir).catch(() => []);
  if (owners.length === 1 && /^[1-9][0-9]*$/.test(owners[0] ?? '')) {
    try {
      process.kill(Number(owners[0]), 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return;
      await fs.unlink(join(lockDir, owners[0] ?? '')).catch(() => {});
      await fs.rmdir(lockDir).catch(() => {});
    }
    return;
  }
  if (owners.length === 0 && Date.now() - info.mtimeMs > EMPTY_LOCK_GRACE_MS) {
    await fs.rmdir(lockDir).catch(() => {});
  }
}

async function release(lockDir: string): Promise<void> {
  await fs.unlink(join(lockDir, String(process.pid))).catch(() => {});
  await fs.rmdir(lockDir).catch(() => {});
}
