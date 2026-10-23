import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { LOCK_STALE_MS, LOCK_WAIT_MS } from './constants.ts';
import { type ToolsContext, pidAlive } from './runtime.ts';

/**
 * Per-tool cross-process lock: parallel agents that `ensure` the same tool take turns, and the
 * loser re-detects after the winner finished instead of installing twice. Exclusive-create plus
 * a pid-liveness check, the same shape as `skills-update.ts`'s lock. Waiting is bounded: a
 * holder that is alive but older than `LOCK_STALE_MS` is treated as hung and replaced.
 */

interface Holder {
  raw: string;
  live: boolean;
  /** The lock file is not there (released between our open and our read): just retry the create. */
  gone?: boolean;
}

async function readHolder(path: string, now: number): Promise<Holder> {
  try {
    const raw = await readFile(path, 'utf8');
    const [pidText, tsText] = raw.trim().split(/\s+/);
    const pid = Number(pidText);
    const ts = Number(tsText);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(ts)) throw new Error('unparsed');
    return { raw, live: pidAlive(pid) && now - ts <= LOCK_STALE_MS };
  } catch {
    // Unreadable or half-written (the holder is between create and write, or Windows has it
    // open): trust it for a moment, and treat a vanished file as released, never as stale.
    try {
      return { raw: '', live: now - (await stat(path)).mtimeMs <= 5_000 };
    } catch {
      return { raw: '', live: false, gone: true };
    }
  }
}

/**
 * Remove a lock judged stale. Two waiters can both judge it stale, and the slower one's `rm`
 * would delete the fresh lock the faster one just created. So takeovers are serialized by a
 * short-lived guard file and the verdict is re-checked under it: a lock that changed, or went
 * live, is left alone. (A holder releasing at the very same instant is the one window left.)
 */
async function takeOverStale(path: string, staleRaw: string, now: () => number): Promise<void> {
  const guard = `${path}.takeover`;
  try {
    await (await open(guard, 'wx', 0o600)).close();
  } catch {
    // Another waiter is taking over; a guard its owner died holding is cleared after 10 s.
    if (await stat(guard).then((s) => now() - s.mtimeMs > 10_000, () => false)) await rm(guard, { force: true });
    return;
  }
  try {
    const current = await readHolder(path, now());
    if (!current.gone && !current.live && current.raw === staleRaw) await rm(path, { force: true });
  } finally {
    await rm(guard, { force: true });
  }
}

export interface LockOptions {
  waitMs?: number;
  pollMs?: number;
  now?: () => number;
}

/** Windows reports a file that is mid-delete or mid-rename as EPERM/EBUSY/EACCES instead of EEXIST. */
const WINDOWS_TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);

export async function withToolLock<T>(ctx: ToolsContext, name: string, work: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const now = options.now ?? Date.now;
  const path = join(ctx.toolsDir, '.locks', `${name}.lock`);
  await mkdir(join(ctx.toolsDir, '.locks'), { recursive: true });
  const deadline = now() + (options.waitMs ?? LOCK_WAIT_MS);
  let announced = false;
  const token = randomUUID(); // who owns the file: release only deletes OUR lock
  for (;;) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n${now()}\n${token}\n`);
      await handle.close();
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      const transient = process.platform === 'win32' && WINDOWS_TRANSIENT.has(code);
      if (code !== 'EEXIST' && !transient) throw error;
      const holder = transient ? { raw: '', live: true } : await readHolder(path, now());
      if (holder.gone) continue;
      if (!holder.live) {
        await takeOverStale(path, holder.raw, now);
        continue;
      }
      if (now() >= deadline) throw new Error(`timed out waiting for another cezar process to finish with ${name}`);
      if (!announced && !transient) ctx.log(`another process is working on ${name}; waiting for it`);
      announced = announced || !transient;
      await ctx.sleep(options.pollMs ?? 1_000);
    }
  }
  try {
    return await work();
  } finally {
    await releaseIfOwner(path, token);
  }
}

/**
 * Delete the lock only if it is still ours. A plain `rm` would delete the lock of whoever took
 * over after we were judged hung. Atomic compare: rename it aside (one winner), verify the token
 * in what we moved, drop it if ours, otherwise put it back (`link` refuses to overwrite a newer one).
 */
async function releaseIfOwner(path: string, token: string): Promise<void> {
  const aside = `${path}.release-${process.pid}-${token}`;
  try {
    await rename(path, aside);
  } catch {
    return; // already gone: taken over, and released by its new owner
  }
  const owned = (await readFile(aside, 'utf8').catch(() => '')).includes(token);
  if (!owned) await link(aside, path).catch(() => undefined);
  await rm(aside, { force: true });
}
