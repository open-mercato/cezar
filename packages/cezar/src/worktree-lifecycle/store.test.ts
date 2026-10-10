import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LifecycleStore, withLifecycleFileLock } from './store.ts';
import { lifecycleOperationSchema, type WorktreeLifecycleRecord } from '@open-mercato/cezar-contract';

let root: string;
let store: LifecycleStore;
let record: WorktreeLifecycleRecord;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'cez-lifecycle-')));
  store = new LifecycleStore(join(root, '.ai', 'cezar'), root);
  record = { schemaVersion: 1, worktreeId: randomUUID(), runId: randomUUID(), projectRoot: root, worktreePath: '', generation: 1, autoCleanupSuppressed: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  record.worktreePath = join(root, '.ai', 'cezar', 'worktrees', record.runId);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const operation = () => lifecycleOperationSchema.parse({ schemaVersion: 1, id: randomUUID(), worktreeId: record.worktreeId, generation: 1, phase: 'setup', intent: 'create', state: 'queued', revision: 0, createdAt: record.createdAt, updatedAt: record.updatedAt, executions: [] });

describe('LifecycleStore', () => {
  it('durably writes independent private records and preserves future fields', async () => {
    await store.writeWorktree({ ...record, future: 'kept' });
    expect(await store.readWorktree(record.runId)).toMatchObject({ ...record, future: 'kept' });
    await store.writeWorktree({ ...record, generation: 2 });
    expect(await store.readWorktree(record.runId)).toMatchObject({ worktreeId: record.worktreeId, generation: 2, future: 'kept' });
    const mode = (await fs.stat(join(store.directory, 'worktrees', `${record.runId}.json`))).mode & 0o777;
    if (process.platform !== 'win32') expect(mode).toBe(0o600);
  });
  it('clears known optional state while retaining additive unknown fields', async () => {
    await store.writeWorktree({ ...record, preparedBy: 'completed', activeOperationId: randomUUID(), future: 'kept' });
    await store.writeWorktree(record);
    const saved = await store.readWorktree(record.runId);
    expect(saved).not.toHaveProperty('preparedBy');
    expect(saved).not.toHaveProperty('activeOperationId');
    expect(saved).toHaveProperty('future', 'kept');
    const op = operation();
    await store.writeOperation({ ...op, error: 'old error', future: 'kept' }, null);
    await store.writeOperation({ ...op, revision: 1 }, 0);
    const resumed = await store.readOperation(op.id);
    expect(resumed).not.toHaveProperty('error');
    expect(resumed).toHaveProperty('future', 'kept');
  });
  it('a failed durable checkpoint leaves previous state intact and leaks no temporary file', async () => {
    await store.writeWorktree(record);
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk unavailable'));
    try { await expect(store.writeWorktree({ ...record, generation: 2 })).rejects.toThrow('disk unavailable'); }
    finally { rename.mockRestore(); }
    expect((await store.readWorktree(record.runId))?.generation).toBe(1);
    expect(await fs.readdir(join(store.directory, 'worktrees'))).toEqual([`${record.runId}.json`]);
  });
  it('rejects escaping IDs, wrong project roots, guessed paths and symlinked directories', async () => {
    await expect(store.readWorktree('../../outside')).rejects.toThrow();
    await expect(store.readWorktree('..')).rejects.toThrow();
    await expect(store.writeWorktree({ ...record, projectRoot: '/tmp' })).rejects.toThrow('another project');
    await expect(store.writeWorktree({ ...record, worktreePath: root })).rejects.toThrow('managed task directory');
    await fs.mkdir(join(root, '.ai', 'cezar'), { recursive: true });
    await fs.symlink(root, join(root, '.ai', 'cezar', 'worktrees'));
    await expect(store.writeWorktree(record)).rejects.toThrow('symbolic link');
  });
  it('salvages valid records while reporting corrupt identities without guessing context', async () => {
    await store.writeWorktree(record);
    const other = randomUUID();
    await fs.writeFile(join(store.directory, 'worktrees', `${other}.json`), '{broken');
    expect(await store.listWorktrees()).toEqual({ records: [record], errors: [{ id: other, error: expect.stringContaining('retained') }] });
  });
  it('CAS admits one revision change and refuses stale double-clicks and identity replacement', async () => {
    const op = operation();
    await store.writeOperation(op, null);
    const results = await Promise.allSettled([
      store.writeOperation({ ...op, revision: 1, state: 'running' }, 0),
      store.writeOperation({ ...op, revision: 1, state: 'needs_attention' }, 0),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    await expect(store.writeOperation(op, null)).rejects.toThrow('already exists');
    await expect(store.writeWorktree({ ...record })).resolves.toBeUndefined();
    await expect(store.writeWorktree({ ...record, worktreeId: randomUUID() })).rejects.toThrow('cannot be replaced');
  });
  it('retains stable identity for reclaimed tasks after history expires', async () => {
    await store.writeWorktree(record);
    const op = operation();
    await store.writeOperation({ ...op, state: 'completed' }, null);
    await store.pruneHistory(() => true, Date.now() + 8 * 86400_000);
    expect(await store.readOperation(op.id)).toBeNull();
    expect((await store.readWorktree(record.runId))?.worktreeId).toBe(record.worktreeId);
    await store.writeWorktree({ ...record, generation: 2 });
    expect((await store.readWorktree(record.runId))?.worktreeId).toBe(record.worktreeId);
  });
  it('never prunes active history or retained directories, even without task records', async () => {
    await store.writeWorktree(record);
    const op = operation();
    await store.writeOperation({ ...op, state: 'needs_attention' }, null);
    await store.pruneHistory(() => false, Date.now() + 8 * 86400_000);
    expect(await store.readOperation(op.id)).not.toBeNull();
    expect(await store.readWorktree(record.runId)).not.toBeNull();
    await store.writeOperation({ ...op, revision: 1, state: 'completed' }, 0);
    await fs.mkdir(record.worktreePath, { recursive: true });
    await store.pruneHistory(() => false, Date.now() + 8 * 86400_000);
    expect(await store.readOperation(op.id)).not.toBeNull();
  });
  it('expires completed old-generation history after recreation while retaining current facts and identity', async () => {
    await store.writeWorktree({ ...record, generation: 2 });
    await fs.mkdir(record.worktreePath, { recursive: true });
    const previous = { ...operation(), state: 'completed' as const };
    const current = { ...operation(), generation: 2, state: 'completed' as const };
    await store.writeOperation(previous, null);
    await store.writeOperation(current, null);
    await store.pruneHistory(() => true, Date.now() + 8 * 86400_000);
    expect(await store.readOperation(previous.id)).toBeNull();
    expect(await store.readOperation(current.id)).not.toBeNull();
    expect((await store.readWorktree(record.runId))?.worktreeId).toBe(record.worktreeId);
  });
  it('pages persisted output and rejects duplicate sequence numbers', async () => {
    const op = operation();
    const frame = { seq: 1, time: record.createdAt, executionId: randomUUID(), stream: 'stdout' as const, text: 'safe output' };
    await store.appendOutput(op.id, frame);
    await store.appendOutput(op.id, { ...frame, seq: 2 });
    await expect(store.appendOutput(op.id, frame)).rejects.toThrow('sequence');
    expect(await store.readOutput(op.id, 0, 1)).toEqual({ items: [frame], nextSeq: 1, truncated: false });
    expect(await store.readOutput(op.id, 1)).toEqual({ items: [{ ...frame, seq: 2 }], nextSeq: 2, truncated: false });
  });
  it('filesystem lease serializes independent store objects', async () => {
    const other = new LifecycleStore(store.dataDir, root);
    let running = 0;
    let max = 0;
    await Promise.all([store, other].map(instance => instance.withWorktreeLock(record.runId, async () => {
      max = Math.max(max, ++running);
      await new Promise(resolve => setTimeout(resolve, 30));
      running--;
    })));
    expect(max).toBe(1);
  });
  it('retries when a releasing owner removes its directory between stat and readdir', async () => {
    const lock = join(root, 'releasing.lock');
    await fs.mkdir(lock);
    await fs.writeFile(join(lock, `${process.pid}-${randomUUID()}`), '');
    const reading = vi.spyOn(fs, 'readdir').mockImplementationOnce(async () => {
      await fs.rm(lock, {recursive: true});
      throw Object.assign(new Error('owner released'), {code: 'ENOENT'});
    });
    try {
      await expect(withLifecycleFileLock(lock, async () => 42, {wait: false})).resolves.toBe(42);
    } finally { reading.mockRestore(); }
    expect(await fs.stat(lock).catch(() => null)).toBeNull();
  });
  it('nonblocking acquisition leaves a live owner and its lease untouched', async () => {
    const lock = join(root, 'live.lock');
    await withLifecycleFileLock(lock, async () => {
      const before = await fs.readdir(lock);
      const mutate = vi.fn(async () => undefined);
      await expect(withLifecycleFileLock(lock, mutate, {wait: false})).rejects.toThrow('busy');
      expect(mutate).not.toHaveBeenCalled();
      expect(await fs.readdir(lock)).toEqual(before);
    });
  });
  it.each([true, false])('recovers a dead owner with wait=%s', async wait => {
    const lock = join(root, 'test.lock');
    await fs.mkdir(lock);
    await fs.writeFile(join(lock, `999999999-${randomUUID()}`), '');
    await expect(withLifecycleFileLock(lock, async () => 42, {wait})).resolves.toBe(42);
    expect(await fs.stat(lock).catch(() => null)).toBeNull();
  });
});
