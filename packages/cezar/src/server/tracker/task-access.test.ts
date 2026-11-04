import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { executeTrackerOperation, trackerPrompt, trackerTaskContext, type TrackerTaskBinding } from './task-access.ts';
const mock = vi.hoisted(() => ({ driver: vi.fn() }));
vi.mock('./index.ts', () => ({ createTrackerService: () => mock }));
let dir: string;
const association = { kind: 'linear' as const, connectionId: 'c', source: { id: 's', webUrl: 'https://linear.app/a' }, externalId: 'team', externalName: 'Team' };
const binding: TrackerTaskBinding = { automationId: 'a', automationRevision: 1, receiptId: 'r', provider: 'linear', association, issueId: 'issue', key: 'ABC-1', url: 'https://linear.app/a', access: { version: 1, writes: ['comment', 'transition'] } };
const action = { kind: 'comment' as const, body: 'Ready for review' };
const sendThen = (outcome: () => Promise<void>) => vi.fn(async (_id: string, _action: unknown, beforeWrite: () => Promise<void>) => { await beforeWrite(); await outcome(); });
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tracker-ops-')); });
afterEach(async () => { vi.resetAllMocks(); await rm(dir, { recursive: true, force: true }); });
it('records before sending and replays completed results without posting again', async () => {
  const act = sendThen(async () => {
    const names = await readdir(join(dir, 'runs', 'run.tracker-operations'));
    const persisted = JSON.parse(await readFile(join(dir, 'runs', 'run.tracker-operations', names[0]!), 'utf8'));
    expect(persisted.result.status).toBe('unknown');
  });
  mock.driver.mockResolvedValue({ association, context: vi.fn(), act });
  const input = { operationId: randomUUID(), action };
  expect((await executeTrackerOperation(dir, dir, 'run', binding, input)).status).toBe('completed');
  expect((await executeTrackerOperation(dir, dir, 'run', binding, input)).status).toBe('completed');
  expect(act).toHaveBeenCalledTimes(1);
  expect((await executeTrackerOperation(dir, dir, 'run', binding, { ...input, action: { ...action, body: 'Changed' } })).status).toBe('rejected');
});
it('keeps a timeout unknown across retries and does not issue a second request', async () => {
  const act = sendThen(async () => { throw new Error('response lost after commit'); });
  mock.driver.mockResolvedValue({ association, context: vi.fn(), act });
  const input = { operationId: randomUUID(), action };
  expect((await executeTrackerOperation(dir, dir, 'run', binding, input)).status).toBe('unknown');
  expect((await executeTrackerOperation(dir, dir, 'run', binding, input)).status).toBe('unknown');
  expect(act).toHaveBeenCalledTimes(1);
});
it('queues a second write to the same issue instead of reporting it unknown', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const act = sendThen(() => gate);
  mock.driver.mockResolvedValue({ association, context: vi.fn(), act });
  const first = executeTrackerOperation(dir, dir, 'first', binding, { operationId: randomUUID(), action });
  await vi.waitFor(() => expect(act).toHaveBeenCalledTimes(1));
  const second = executeTrackerOperation(dir, dir, 'second', binding, { operationId: randomUUID(), action });
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(act).toHaveBeenCalledTimes(1);
  release();
  expect((await first).status).toBe('completed');
  expect((await second).status).toBe('completed');
  expect(act).toHaveBeenCalledTimes(2);
});
it('reaps a lock left by an earlier process that had this PID', async () => {
  const act = sendThen(async () => {});
  mock.driver.mockResolvedValue({ association, context: vi.fn(), act });
  const input = { operationId: randomUUID(), action };
  // Seed a stale lock with our own PID, as a previous process with the same PID would leave.
  const { createHash } = await import('node:crypto');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const scope = [association.kind, association.source, association.externalId, association.connectionId, binding.issueId];
  const lock = join(dir, 'runs', `tracker-${createHash('sha256').update(JSON.stringify(scope)).digest('hex')}.lock`);
  await mkdir(lock, { recursive: true }); await writeFile(join(lock, String(process.pid)), '');
  expect((await executeTrackerOperation(dir, dir, 'run', binding, input)).status).toBe('completed');
});
it('reaps a lock whose live owner PID was reused, but only once it is far older than any write', async () => {
  const act = sendThen(async () => {});
  mock.driver.mockResolvedValue({ association, context: vi.fn(), act });
  const { createHash } = await import('node:crypto');
  const { mkdir, writeFile, utimes } = await import('node:fs/promises');
  const scope = [association.kind, association.source, association.externalId, association.connectionId, binding.issueId];
  const lock = join(dir, 'runs', `tracker-${createHash('sha256').update(JSON.stringify(scope)).digest('hex')}.lock`);
  // PID 1 is always alive and never ours.
  await mkdir(lock, { recursive: true }); await writeFile(join(lock, '1'), '');
  const old = new Date(Date.now() - 11 * 60_000);
  await utimes(lock, old, old);
  expect((await executeTrackerOperation(dir, dir, 'run', binding, { operationId: randomUUID(), action })).status).toBe('completed');
  expect(act).toHaveBeenCalledTimes(1);
});
it('denies writes before touching the provider when they were not granted', async () => {
  const result = await executeTrackerOperation(dir, dir, 'run', { ...binding, access: { version: 1, writes: [] } }, { operationId: randomUUID(), action });
  expect(result.status).toBe('rejected'); expect(mock.driver).not.toHaveBeenCalled();
});
it('refuses changed bindings and an issue identity substituted by the provider', async () => {
  mock.driver.mockResolvedValue({ association: { ...association, connectionId: 'rotated' }, context: vi.fn() });
  await expect(trackerTaskContext(dir, binding)).rejects.toThrow();
  mock.driver.mockResolvedValue({ association, context: vi.fn().mockResolvedValue({ issueId: 'another' }) });
  await expect(trackerTaskContext(dir, binding)).rejects.toThrow();
});

it('rechecks a cancelled or superseded task immediately before the provider write', async () => {
  const send = vi.fn();
  mock.driver.mockResolvedValue({ association, context: vi.fn(), act: async (_id: string, _action: unknown, beforeWrite: () => Promise<void>) => { await beforeWrite(); send(); } });
  const input = { operationId: randomUUID(), action };
  const result = await executeTrackerOperation(dir, dir, 'run', binding, input, () => false);
  expect(result.status).toBe('rejected');
  expect(result.message).toContain('Not sent');
  expect(send).not.toHaveBeenCalled();
  // Nothing was sent, so the same ID may be retried once the task is authorized again.
  expect((await executeTrackerOperation(dir, dir, 'run', binding, input)).status).toBe('completed');
  expect(send).toHaveBeenCalledTimes(1);
});

it('replays a recorded outcome after the connection was rotated, without contacting the tracker', async () => {
  mock.driver.mockResolvedValue({ association, context: vi.fn(), act: sendThen(async () => {}) });
  const input = { operationId: randomUUID(), action };
  expect((await executeTrackerOperation(dir, dir, 'run', binding, input)).status).toBe('completed');
  mock.driver.mockResolvedValue({ association: { ...association, connectionId: 'rotated' }, context: vi.fn() });
  expect((await executeTrackerOperation(dir, dir, 'run', binding, input)).status).toBe('completed');
});

it('refuses operations for a run started before mediated access', async () => {
  const { issueId: _drop, ...legacy } = binding;
  expect((await executeTrackerOperation(dir, dir, 'run', legacy, { operationId: randomUUID(), action })).status).toBe('rejected');
  expect(mock.driver).not.toHaveBeenCalled();
});

it('describes only granted writes and an unavailable context in the agent note', () => {
  const note = trackerPrompt({ binding: { ...binding, access: { version: 1, writes: ['comment'] } }, unavailable: 'Tracker offline.', commands: true });
  expect(note).toContain('Tracker context is unavailable: Tracker offline.');
  expect(note).toContain('tracker comment');
  expect(note).not.toContain('tracker transition');
  expect(trackerPrompt({ binding, unavailable: 'legacy', commands: false })).not.toContain('$CEZ_BIN');
});

// Pauses the owner-file write after it reaches disk but before its promise resolves.
it('never lets a contender reap an owner that is still acquiring the lock', async () => {
  const { promises: fs } = await import('node:fs');
  const original = fs.writeFile.bind(fs);
  let ownerReady!: () => void, releaseOwner!: () => void, releaseWrites!: () => void;
  const ready = new Promise<void>(r => { ownerReady = r; });
  const ownerGate = new Promise<void>(r => { releaseOwner = r; });
  const writesGate = new Promise<void>(r => { releaseWrites = r; });
  let paused = false;
  const spy = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
    await original(...args);
    if (!paused && String(args[0]).endsWith('/' + process.pid)) {
      paused = true; ownerReady(); await ownerGate;
    }
  });
  let active = 0, maximum = 0;
  const act = sendThen(async () => { active++; maximum = Math.max(maximum, active); await writesGate; active--; });
  mock.driver.mockResolvedValue({ association, context: vi.fn(), act });
  const first = executeTrackerOperation(dir, dir, 'first', binding, { operationId: randomUUID(), action });
  await ready;
  const second = executeTrackerOperation(dir, dir, 'second', binding, { operationId: randomUUID(), action });
  await new Promise(r => setTimeout(r, 300));
  releaseOwner();
  await new Promise(r => setTimeout(r, 300));
  releaseWrites();
  await Promise.all([first, second]);
  spy.mockRestore();
  expect(maximum).toBe(1);
});

it('keeps ownership after the last queued waiter times out', async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  let entered!: () => void;
  const ready = new Promise<void>(r => { entered = r; });
  let active = 0, maximum = 0;
  const act = sendThen(async () => { active++; maximum = Math.max(maximum, active); entered(); await gate; active--; });
  mock.driver.mockResolvedValue({ association, context: vi.fn(), act });
  const first = executeTrackerOperation(dir, dir, 'first', binding, { operationId: randomUUID(), action });
  await ready;
  const second = await executeTrackerOperation(dir, dir, 'second', binding, { operationId: randomUUID(), action });
  expect(second.status).toBe('rejected');
  const third = executeTrackerOperation(dir, dir, 'third', binding, { operationId: randomUUID(), action });
  await new Promise(r => setTimeout(r, 500));
  release();
  await Promise.all([first, third]);
  expect(maximum).toBe(1);
}, 30000);

it.each(['ENOTDIR', 'EACCES', 'unlink'] as const)('fails promptly and releases the queue after lock %s', async fault => {
  const { promises: fs } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const scope = [association.kind, association.source, association.externalId, association.connectionId, binding.issueId];
  const lock = join(dir, 'runs', `tracker-${createHash('sha256').update(JSON.stringify(scope)).digest('hex')}.lock`);
  await fs.mkdir(join(dir, 'runs'));
  if (fault === 'ENOTDIR') await fs.writeFile(lock, 'obstruction');
  else await fs.mkdir(lock);
  if (fault === 'unlink') await fs.writeFile(join(lock, String(process.pid)), '');
  const originalMkdir = fs.mkdir.bind(fs);
  let attempts = 0;
  // Bound the buggy implementation's retry loop so a regression fails quickly, not by hanging the suite.
  const mkdirSpy = vi.spyOn(fs, 'mkdir').mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
    if (String(args[0]) === lock && ++attempts > 3) throw Object.assign(new Error('retry cutoff'), { code: 'EIO' });
    return originalMkdir(...args);
  });
  const readdir = fs.readdir.bind(fs), unlink = fs.unlink.bind(fs);
  const readSpy = vi.spyOn(fs, 'readdir').mockImplementation(async (...args: Parameters<typeof fs.readdir>) => {
    if (fault === 'EACCES' && String(args[0]) === lock) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return readdir(...args);
  });
  const unlinkSpy = vi.spyOn(fs, 'unlink').mockImplementation(async path => {
    if (fault === 'unlink' && String(path) === join(lock, String(process.pid))) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return unlink(path);
  });
  const act = sendThen(async () => {});
  mock.driver.mockResolvedValue({ association, context: vi.fn(), act });
  const input = { operationId: randomUUID(), action };
  try {
    await expect(executeTrackerOperation(dir, dir, 'run', binding, input)).rejects.toMatchObject({ code: fault === 'ENOTDIR' ? 'ENOTDIR' : 'EACCES' });
    expect(act).not.toHaveBeenCalled();
  } finally { mkdirSpy.mockRestore(); readSpy.mockRestore(); unlinkSpy.mockRestore(); await fs.rm(lock, { recursive: true, force: true }); }
  expect((await executeTrackerOperation(dir, dir, 'run', binding, input)).status).toBe('completed');
}, 25000);
it('names the cooldown when the tracker rate-limits a context read, and an unsupported provider', async () => {
  const { TrackerRequestError } = await import('./transport.ts');
  mock.driver.mockResolvedValue({ association, context: vi.fn(async () => { throw new TrackerRequestError('rate_limited', 'limited', 42); }) });
  await expect(trackerTaskContext(dir, binding)).rejects.toThrow('retry tracker read in 42 seconds');
  mock.driver.mockResolvedValue({ association });
  await expect(trackerTaskContext(dir, binding)).rejects.toThrow('does not support mediated task access');
});
