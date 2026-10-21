import { open, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { LOCK_STALE_MS, LOCK_WAIT_MS } from './constants.ts';
import type { ToolsContext } from './runtime.ts';

/**
 * Per-tool cross-process lock: parallel agents that `ensure` the same tool take turns, and the
 * loser re-detects after the winner finished instead of installing twice. Exclusive-create plus
 * a pid-liveness check, the same shape as `skills-update.ts`'s lock. Waiting is bounded: a
 * holder that is alive but older than `LOCK_STALE_MS` is treated as hung and replaced.
 */

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function holderIsLive(path: string, now: number): Promise<boolean> {
  try {
    const [pidText, tsText] = (await readFile(path, 'utf8')).trim().split(/\s+/);
    const pid = Number(pidText);
    const ts = Number(tsText);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(ts)) throw new Error('unparsed');
    return pidAlive(pid) && now - ts <= LOCK_STALE_MS;
  } catch {
    // Unreadable or half-written (the holder is between create and write): trust it for a moment.
    try {
      return now - (await stat(path)).mtimeMs <= 5_000;
    } catch {
      return false;
    }
  }
}

export interface LockOptions {
  waitMs?: number;
  pollMs?: number;
  now?: () => number;
}

export async function withToolLock<T>(ctx: ToolsContext, name: string, work: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const now = options.now ?? Date.now;
  const path = join(ctx.toolsDir, '.locks', `${name}.lock`);
  await mkdir(join(ctx.toolsDir, '.locks'), { recursive: true });
  const deadline = now() + (options.waitMs ?? LOCK_WAIT_MS);
  let announced = false;
  for (;;) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n${now()}\n`);
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!(await holderIsLive(path, now()))) {
        await rm(path, { force: true });
        continue;
      }
      if (now() >= deadline) throw new Error(`timed out waiting for another cezar process to finish with ${name}`);
      if (!announced) ctx.log(`another process is working on ${name}; waiting for it`);
      announced = true;
      await ctx.sleep(options.pollMs ?? 1_000);
    }
  }
  try {
    return await work();
  } finally {
    await rm(path, { force: true });
  }
}
