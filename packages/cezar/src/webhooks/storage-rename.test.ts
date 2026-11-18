import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { atomicWrite } from './storage.ts';

// Windows CI: a scanner or reader holding the inbound state file failed its rename EPERM
// once, which blocked the bot's state for good ('Inbound state blocked').
const fault = vi.hoisted(() => ({ failures: 0, calls: 0 }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const busy = () => { fault.calls++; if (fault.failures > 0) { fault.failures--; throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }); } };
  const renameSync: typeof actual.renameSync = (from, to) => { busy(); actual.renameSync(from, to); };
  const promises = { ...actual.promises, rename: async (from: string, to: string) => { busy(); await actual.promises.rename(from, to); } };
  return { ...actual, default: { ...actual, renameSync, promises }, renameSync, promises };
});

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const dirs: string[] = [];
afterEach(() => { Object.defineProperty(process, 'platform', platform); fault.failures = 0; fault.calls = 0; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const directory = () => { const dir = mkdtempSync(join(tmpdir(), 'webhook-rename-')); dirs.push(dir); return dir; };

it('publishes state through a transient win32 sharing violation', async () => {
  const dir = directory();
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  fault.failures = 2;
  await atomicWrite(dir, '700001.json', { ok: true });
  expect(JSON.parse(readFileSync(join(dir, '700001.json'), 'utf8'))).toEqual({ ok: true });
  expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([]);
});

it('still fails a real permission error on POSIX at once', async () => {
  const dir = directory();
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  fault.failures = 1;
  await expect(atomicWrite(dir, 'state.json', {})).rejects.toThrow('EPERM');
  expect(fault.calls).toBe(1);
  expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([]);
});

it('compacts the outbox through a transient win32 sharing violation', async () => {
  const { Outbox } = await import('./outbox.ts');
  const dir = directory();
  const source = (sequence: number) => ({
    version: 1 as const, id: `evt_00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`, sequence, installationId: 'inst_test', projectId: 'project', previousStatus: 'running' as const,
    episodeId: `task-1-${sequence}`, type: 'task.finished' as const, occurredAt: '2026-10-13T12:00:00Z', mode: 'local' as const,
    snapshot: { id: 'task-1', status: 'done' as const, archived: false, continuation: 0 },
  });
  const box = await Outbox.open(dir, 'inst_test'); box.append(source(1)); box.append(source(2));
  await box.advance(box.peek()!.end);
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  fault.failures = 2;
  await expect(box.compact()).resolves.toBe(true);
  expect((await Outbox.open(dir, 'inst_test')).sources().map(row => row.sequence)).toEqual([2]);
});
