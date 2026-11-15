import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

// Interleaves other processes inside `removeAbandonedMutex` (store.ts) by wrapping two fs calls.
const hooks = vi.hoisted(() => ({
  rename: undefined as undefined | ((from: string, to: string) => void),
  stat: undefined as undefined | ((path: string) => void),
  lock: undefined as undefined | (() => void),
}));
// Runs other processes while this one is inside the reclaim mutex (`acquire` in withReclaimMutex).
vi.mock('proper-lockfile', async (importOriginal) => {
  const actual = (await importOriginal<{ default: typeof import('proper-lockfile') }>()).default;
  const lockSync = ((...args: Parameters<typeof actual.lockSync>) => { hooks.lock?.(); return actual.lockSync(...args); }) as typeof actual.lockSync;
  return { default: { ...actual, lockSync } };
});
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const renameSync = ((from: string, to: string) => { hooks.rename?.(from, to); actual.renameSync(from, to); }) as typeof actual.renameSync;
  const statSync = ((path: string, ...rest: unknown[]) => { hooks.stat?.(String(path)); return (actual.statSync as (...a: unknown[]) => unknown)(path, ...rest); }) as typeof actual.statSync;
  return { ...actual, default: { ...actual, renameSync, statSync }, renameSync, statSync };
});

const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
const { AutomationStore } = await import('./store.ts');

const dirs: string[] = [];
afterEach(async () => {
  hooks.rename = hooks.stat = hooks.lock = undefined;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

it("never puts a live holder's moved mutex back over one a third contender took meanwhile", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cezar-reclaim-mutex-'));
  dirs.push(dir);
  const mutex = join(dir, 'automation-poll.lock.guard.reclaim');
  fs.mkdirSync(mutex);
  const old = new Date(Date.now() - 20 * 60_000);
  fs.utimesSync(mutex, old, old);
  let third: number | undefined;
  hooks.rename = (from) => {
    if (from !== mutex) return;
    hooks.rename = undefined;
    // A reclaims the abandoned mutex between our staleness check and our rename, so we move A's.
    fs.rmdirSync(mutex);
    fs.mkdirSync(mutex);
  };
  hooks.stat = (path) => {
    if (!path.startsWith(`${mutex}.`)) return;
    hooks.stat = undefined;
    // With A's mutex moved away, C takes the free path before we try to put A's back.
    fs.mkdirSync(mutex);
    third = fs.statSync(mutex).ino;
  };

  expect(AutomationStore.open(dir).acquireLease()).toBeUndefined();
  expect(third).toBeDefined();
  expect(fs.statSync(mutex).ino).toBe(third);
  expect(fs.readdirSync(dir).filter((name) => name.startsWith('automation-poll.lock.guard.reclaim.'))).toEqual([]);
});

it("does not remove a third contender's mutex when releasing one a reclaimer moved away", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cezar-reclaim-mutex-'));
  dirs.push(dir);
  const mutex = join(dir, 'automation-poll.lock.guard.reclaim');
  let third: number | undefined;
  hooks.lock = () => {
    hooks.lock = undefined;
    // B moves our live mutex to its tombstone; C takes the free path before B can restore ours.
    fs.renameSync(mutex, `${mutex}.b-tombstone`);
    fs.mkdirSync(mutex);
    third = fs.statSync(mutex).ino;
  };

  const lease = AutomationStore.open(dir).acquireLease();
  expect(lease).toBeDefined();
  lease?.release();
  expect(third).toBeDefined();
  expect(fs.existsSync(mutex)).toBe(true);
  expect(fs.statSync(mutex).ino).toBe(third);
});
