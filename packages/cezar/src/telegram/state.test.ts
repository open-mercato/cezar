import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { ZodError } from 'zod';
import { join } from 'node:path';
import { freshState, InboundStateStore, MAX_STATE_BYTES, readInboundState, type InboundState, type JournalEntry } from './state.ts';

function setup() {
  let disk = freshState('123', { projectId: 'project', installationId: 'installation', root: '/repo', generation: randomUUID() });
  let fail = false, owns = true;
  const writes: InboundState[] = [];
  const store = new InboundStateStore(disk, {
    assertOwner() { if (!owns) throw new Error('lost owner'); },
    async write(state) { if (fail) throw new Error('disk failure'); disk = structuredClone(state); writes.push(disk); },
  });
  const entry = (updateId: number): JournalEntry => ({ id: randomUUID(), epoch: store.snapshot().epoch, updateId, at: Date.now(),
    botId: '123', chatId: '456', userId: '456', runId: 'run', kind: 'reply', state: 'claimed', reason: 'pending' });
  return { store, entry, writes, disk: () => disk, fail: () => { fail = true; }, lose: () => { owns = false; } };
}

describe('Telegram durable inbound journal', () => {
  it('durably claims one source per update and recovers crash uncertainty without replay', async () => {
    const test = setup(), entry = test.entry(42), now = Date.now();
    const source = { id: randomUUID(), projectId: 'project', receiverId: 'receiver', grantId: randomUUID(),
      botId: '123', epoch: entry.epoch,
      grantGeneration: randomUUID(), enableGeneration: randomUUID(), chatId: '456', userId: '456', sourceMessageId: 7,
      updateId: 42, episodeId: randomUUID(), requestId: randomUUID(), state: 'claimed' as const, createdAt: now, updatedAt: now };
    expect(await test.store.claimSource(entry, source)).toBe(true);
    expect(await test.store.claimSource(entry, { ...source, id: randomUUID() })).toBe(false);
    const restored = new InboundStateStore(test.disk(), { assertOwner() {}, async write() {}, now: () => now + 1 });
    await restored.recover();
    expect(restored.snapshot().sources[0]).toMatchObject({ state: 'uncertain', updateId: 42 });
    expect(restored.snapshot().journal[0]).toMatchObject({ state: 'uncertain' });
    expect(restored.snapshot().nextOffset).toBe(43);
  });
  it('settles source, journal, run id and offset in one crash-safe write', async () => {
    const test = setup(), entry = test.entry(43), now = Date.now(), runId = randomUUID();
    const source = { id: randomUUID(), botId: '123', epoch: entry.epoch, projectId: 'project', receiverId: 'receiver', grantId: randomUUID(),
      grantGeneration: randomUUID(), enableGeneration: randomUUID(), chatId: '456', userId: '456', sourceMessageId: 8,
      updateId: 43, episodeId: randomUUID(), requestId: randomUUID(), runId, state: 'claimed' as const, createdAt: now, updatedAt: now };
    await test.store.claimSource(entry, source);
    const before = test.writes.length; test.fail();
    await expect(test.store.settleSource(entry.epoch, 43, source.id, { ...entry, runId, state: 'accepted', reason: 'task_created' },
      { state: 'finished', runId })).rejects.toThrow('disk failure');
    expect(test.writes).toHaveLength(before);
    expect(test.disk().sources[0]).toMatchObject({ state: 'claimed', runId });
    expect(test.disk()).toMatchObject({ nextOffset: null });
    expect(test.disk().journal[0]).toMatchObject({ state: 'claimed' });
  });
  it('recovers claimed as uncertain and advances offset without executing again', async () => {
    const test = setup(), entry = test.entry(42);
    expect(await test.store.claim(entry)).toBe(true);
    const restored = new InboundStateStore(test.disk(), { assertOwner() {}, async write() {} });
    await restored.recover();
    expect(restored.snapshot().journal[0]?.state).toBe('uncertain');
    expect(restored.snapshot().nextOffset).toBe(43);
    expect(await restored.claim(entry)).toBe(false);
  });
  it('never lets two concurrent claims execute and serializes unrelated mutations', async () => {
    const test = setup(), entry = test.entry(42);
    expect(await Promise.all([test.store.claim(entry), test.store.claim(entry)])).toEqual([true, false]);
    const first = randomUUID(), second = randomUUID();
    await Promise.all([
      test.store.change(state => { state.configGeneration = first; }),
      test.store.change(state => { expect(state.configGeneration).toBe(first); state.configGeneration = second; }),
    ]);
    expect(test.disk().configGeneration).toBe(second);
  });
  it('blocks after a failed claim write without exposing unpublished state', async () => {
    const test = setup(); test.fail();
    await expect(test.store.claim(test.entry(1))).rejects.toThrow('disk failure');
    expect(test.store.snapshot().journal).toEqual([]);
    expect(() => test.store.assertReady()).toThrow('blocked');
    await expect(test.store.finish(test.store.snapshot().epoch, 1)).rejects.toThrow('blocked');
  });
  it('keeps durable claimed after failed result write for recovery', async () => {
    const test = setup(), entry = test.entry(10);
    await test.store.claim(entry); test.fail();
    await expect(test.store.finish(entry.epoch, 10, { ...entry, state: 'accepted', reason: 'delivered' })).rejects.toThrow('disk failure');
    expect(test.disk().journal[0]?.state).toBe('claimed');
    expect(test.disk().nextOffset).toBeNull();
  });
  it('refuses any operation after ownership loss', async () => {
    const test = setup(); test.lose();
    await expect(test.store.claim(test.entry(1))).rejects.toThrow('lost owner');
    expect(test.writes).toHaveLength(0);
  });
  it('uses one persistent probing epoch through silence and accepts lower IDs in new epoch', async () => {
    const test = setup(), old = test.entry(900);
    await test.store.finish(old.epoch, 900, { ...old, state: 'rejected', reason: 'expired' });
    await test.store.change(state => { state.lastUpdateAt = 1; });
    const now = 7 * 86400_000;
    await test.store.preparePoll(now);
    const epoch = test.store.snapshot().epoch;
    expect(epoch).not.toBe(old.epoch); expect(test.store.snapshot().nextOffset).toBeNull();
    await test.store.preparePoll(now + 1000);
    expect(test.store.snapshot().epoch).toBe(epoch);
    expect(await test.store.claim(test.entry(5))).toBe(true);
  });
  it('accepts a reused update id as a distinct source after epoch rotation', async () => {
    const test = setup(), first = test.entry(50), now = Date.now();
    const source = (epoch: string, id = randomUUID()) => ({ id, botId: '123', epoch, projectId: 'project', receiverId: 'receiver', grantId: randomUUID(),
      grantGeneration: randomUUID(), enableGeneration: randomUUID(), chatId: '456', userId: '456', sourceMessageId: 9,
      updateId: 50, episodeId: randomUUID(), requestId: randomUUID(), runId: randomUUID(), state: 'claimed' as const, createdAt: now, updatedAt: now });
    const oldSource = source(first.epoch);
    await test.store.claimSource(first, oldSource);
    await test.store.settleSource(first.epoch, 50, oldSource.id, { ...first, state: 'accepted', reason: 'task_created' }, { state: 'finished', runId: oldSource.runId });
    await test.store.change(state => { state.lastUpdateAt = 1; }); await test.store.preparePoll(7 * 86400_000);
    const next = test.entry(50), nextSource = source(next.epoch);
    expect(next.epoch).not.toBe(first.epoch);
    expect(await test.store.claimSource(next, nextSource)).toBe(true);
    expect(test.store.snapshot().sources.filter(row => row.updateId === 50)).toHaveLength(2);
  });
  it('does not allow finishing a claimed effect without an outcome', async () => {
    const test = setup(), entry = test.entry(1); await test.store.claim(entry);
    await expect(test.store.finish(entry.epoch, 1)).rejects.toThrow('Missing action result');
    expect(test.store.snapshot().nextOffset).toBeNull();
  });
  it('limits completed history but retains an unresolved claim', async () => {
    const test = setup();
    await test.store.change(state => {
      state.journal = Array.from({ length: 600 }, (_, i) => ({ ...test.entry(i), state: 'accepted' as const }));
      state.journal.push(test.entry(601));
    });
    expect(test.store.snapshot().journal).toHaveLength(451);
    expect(test.store.snapshot().journal.at(-1)?.state).toBe('claimed');
  });
  it('limits the read before parsing and never repairs corrupt state implicitly', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'telegram-state-'));
    try {
      await writeFile(join(directory, '123.json'), 'x'.repeat(MAX_STATE_BYTES + 1));
      await expect(readInboundState(directory, '123')).rejects.toThrow('limit');
      await writeFile(join(directory, '123.json'), '{}');
      await expect(readInboundState(directory, '123')).rejects.toBeInstanceOf(ZodError);
      expect(await readInboundState(directory, '456')).toBeUndefined();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
it('refuses a FIFO state without blocking project diagnostics', async () => {
  const { execFileSync, spawnSync } = await import('node:child_process');
  const directory = await mkdtemp(join(tmpdir(), 'telegram-state-fifo-'));
  try {
    execFileSync('mkfifo', [join(directory, '123.json')], { timeout: 1000 });
    const source = new URL('./state.ts', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      `import { readInboundState } from ${JSON.stringify(source)}; try { await readInboundState(process.argv[1], '123'); process.exitCode = 2; } catch { console.log('refused'); }`, directory], { timeout: 3000, encoding: 'utf8' });
    expect(child.error).toBeUndefined(); expect(child.status).toBe(0); expect(child.stdout).toContain('refused');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it('evicts correlations to meet the byte cap without losing an unresolved action or approved access', async () => {
  const test = setup(), entry = test.entry(9000), generation = randomUUID();
  await test.store.claim(entry);
  await test.store.change(state => {
    state.receivers.push({ receiverId: 'receiver', chatId: '456', enabled: true, generation, acceptAfter: 0, deliveryRevision: 1, credentialFingerprint: 'a'.repeat(64) });
    state.grants.push({ id: randomUUID(), receiverId: 'receiver', chatId: '456', userId: '456', label: 'Person', permissions: ['respond'], capability: 'task_control', generation: randomUUID(), enableGeneration: generation, approvedAt: 0 });
    state.correlations = Array.from({ length: 5000 }, (_, i) => ({ receiverId: 'receiver', chatId: '456', messageId: i + 1, deliveryRevision: 1,
      bindingGeneration: state.binding.generation, enableGeneration: generation, runId: 'r'.repeat(128), type: 'task.attention_required', sequence: i, episodeId: 'e'.repeat(128), continuation: 0, requestId: 'q'.repeat(128), createdAt: Date.now() }));
  });
  expect(Buffer.byteLength(JSON.stringify(test.disk()) + '\n')).toBeLessThanOrEqual(MAX_STATE_BYTES);
  expect(test.disk().correlations.length).toBeLessThan(5000); expect(test.disk().correlations.at(-1)?.messageId).toBe(5000);
  expect(test.disk().grants).toHaveLength(1); expect(test.disk().journal[0]?.state).toBe('claimed');
});
it('a failed recovery write leaves claimed durable and blocks retries until another recovery succeeds', async () => {
  const test = setup(), entry = test.entry(20); await test.store.claim(entry);
  const failing = new InboundStateStore(test.disk(), { assertOwner() {}, async write() { throw new Error('fsync failed'); } });
  await expect(failing.recover()).rejects.toThrow('fsync failed');
  await expect(failing.claim(entry)).rejects.toThrow('blocked');
  const recovered = new InboundStateStore(test.disk(), { assertOwner() {}, async write() {} });
  await recovered.recover(); expect(recovered.snapshot().journal[0]?.state).toBe('uncertain');
  expect(await recovered.claim(entry)).toBe(false);
});
it('retains a new probing epoch across restart and never deduplicates its lower ID against an old epoch', async () => {
  const test = setup(), entry = test.entry(500);
  await test.store.finish(entry.epoch, 500, { ...entry, state: 'accepted' });
  await test.store.change(state => { state.lastUpdateAt = 1; }); await test.store.preparePoll(7 * 86400_000);
  const epoch = test.disk().epoch;
  const recovered = new InboundStateStore(test.disk(), { assertOwner() {}, async write() {} });
  await recovered.recover(); await recovered.preparePoll(8 * 86400_000);
  expect(recovered.snapshot().epoch).toBe(epoch); expect(recovered.snapshot().nextOffset).toBeNull();
  expect(recovered.duplicate(epoch, 5)).toBe(false); expect(recovered.duplicate(entry.epoch, 500)).toBe(true);
});
it('aggregates rejection floods without false person attribution or eviction of task outcomes', async () => {
  const test = setup(), accepted = test.entry(1);
  await test.store.finish(accepted.epoch, 1, { ...accepted, state: 'accepted', reason: 'delivered' });
  for (let i = 2; i < 105; i++) await test.store.finish(accepted.epoch, i, { ...test.entry(i), at: 60_001, userId: String(i), chatId: String(i), runId: undefined, state: 'rejected', reason: 'unauthorized' });
  await test.store.flush();
  const summaries = test.disk().journal.filter(row => row.kind === 'rejection_summary');
  expect(summaries).toHaveLength(1); expect(summaries[0]).toMatchObject({ count: 103, at: 60_000, reason: 'unauthorized' });
  expect(summaries[0]).not.toHaveProperty('userId'); expect(summaries[0]).not.toHaveProperty('chatId');
  expect(test.disk().journal.find(row => row.id === accepted.id)?.state).toBe('accepted');
  await test.store.finish(accepted.epoch, 104, { ...test.entry(104), at: 60_001, state: 'rejected', reason: 'unauthorized' }); await test.store.flush();
  expect(test.disk().journal.find(row => row.kind === 'rejection_summary')?.count).toBe(103);
  for (let i = 105; i < 160; i++) await test.store.finish(accepted.epoch, i, { ...test.entry(i), at: i * 60_000, state: 'rejected', reason: 'rate_limited' });
  await test.store.flush();
  expect(test.disk().journal.filter(row => row.kind === 'rejection_summary')).toHaveLength(50);
  expect(test.disk().journal.some(row => row.id === accepted.id)).toBe(true);
});
it('keeps stranger and ignored bookkeeping in memory until one flush, but writes effect outcomes at once', async () => {
  const test = setup(), epoch = test.store.snapshot().epoch;
  for (let i = 1; i <= 20; i++) await test.store.finish(epoch, i, i % 2 ? undefined : { ...test.entry(i), state: 'rejected', reason: 'unauthorized' });
  await test.store.touch(5000);
  expect(test.writes).toHaveLength(0);
  expect(test.store.snapshot().nextOffset).toBe(21); expect(test.store.duplicate(epoch, 20)).toBe(true);
  await test.store.flush(); await test.store.flush();
  expect(test.writes).toHaveLength(1); expect(test.disk()).toMatchObject({ nextOffset: 21, lastUpdateAt: 5000 });
  const entry = test.entry(30); await test.store.claim(entry);
  await test.store.finish(epoch, 30, { ...entry, state: 'rejected', reason: 'unauthorized' });
  expect(test.writes).toHaveLength(3); expect(test.disk().journal.find(row => row.updateId === 30)?.state).toBe('rejected');
  await test.store.finish(epoch, 31, { ...test.entry(31), state: 'accepted', reason: 'delivered' });
  expect(test.writes).toHaveLength(4);
});
it('serves one frozen snapshot per published version', async () => {
  const test = setup(), first = test.store.snapshot();
  expect(test.store.snapshot()).toBe(first); expect(Object.isFrozen(first.receivers)).toBe(true);
  expect(() => { (first as { nextOffset: number | null }).nextOffset = 5; }).toThrow(TypeError);
  await test.store.finish(first.epoch, 1);
  const quiet = test.store.snapshot();
  expect(quiet).not.toBe(first); expect(quiet.nextOffset).toBe(2); expect(quiet.correlations).toBe(first.correlations);
  await test.store.change(state => { state.configGeneration = randomUUID(); });
  expect(test.store.snapshot().correlations).not.toBe(first.correlations); expect(first.nextOffset).toBeNull();
});
it('reads a state file written before chat contexts existed, and keeps one context per person', async () => {
  const test = setup(), old = structuredClone(test.disk()) as Partial<InboundState>;
  delete old.contexts;
  const store = new InboundStateStore(old as InboundState, { assertOwner() {}, async write() {}, now: () => 10_000 });
  expect(store.snapshot().contexts).toBeUndefined();
  const row = { receiverId: 'receiver', chatId: '456', userId: '456', runId: 'run-a', at: 9_000 };
  await store.remember(row); await store.remember({ ...row, runId: 'run-b', at: 9_500 }); await store.remember({ ...row, userId: '789', at: 9_600 });
  expect(store.snapshot().contexts).toEqual([{ ...row, runId: 'run-b', at: 9_500 }, { ...row, userId: '789', at: 9_600 }]);
});
