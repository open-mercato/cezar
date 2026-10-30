import { realpathSync, mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import * as module from './admission.ts';
import { privateReceiverSchema } from './endpoints.ts';
import type { WebhookSource } from './source.ts';
const dirs: string[] = [];
const now = Date.parse('2026-10-13T12:00:00Z');
const source = (sequence = 2): WebhookSource => ({ version: 1, id: `evt_00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`, sequence, installationId: 'inst_test', projectId: 'project', previousStatus: 'running', episodeId: `task-1-${sequence}`, type: 'task.finished', occurredAt: new Date(now).toISOString(), mode: 'local', snapshot: { id: 'task-1', status: 'done', archived: false, continuation: 0, completionReason: 'completed' } });
const receiver = (id = '00000000-0000-4000-8000-000000000001', fence = 1) => privateReceiverSchema.parse({ name: 'Ops', url: 'https://example.com', id, state: 'active', revision: 1, deliveryRevision: 1, secret: 'synthetic-fixture', activation: { installationId: 'inst_test', sequence: fence }, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), consecutiveFailures: 0, activationBlocked: false, lastTest: 'none' });
async function repo(limits = {}) { const dir = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-admission-')); dirs.push(dir); return { dir, repository: await module.AdmissionRepository.open(dir, { now: () => now, limits }) }; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('atomic webhook admission and retained capacity', () => {
  it.each(['pending', 'retained'] as const)('categorizes %s saturation with bounded task identity and clears after pruning', async category => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-saturation-')); dirs.push(dir); let clock = now;
    const limits = category === 'pending' ? { pendingCount: 1 } : { retainedBytes: 12000 };
    let repository = await module.AdmissionRepository.open(dir, { now: () => clock, limits });
    const accepted = (await repository.admit(source(2), [receiver()]))!;
    const dropped = (await repository.admit(source(3), [receiver()]))!;
    expect(dropped).toMatchObject({ taskId: 'task-1', deliveries: [{ reason: `${category}_capacity` }] });
    expect(dropped.source).toBeUndefined();
    expect(repository.saturation()).toMatchObject({ [category]: true, dropped: 1 });
    repository = await module.AdmissionRepository.open(dir, { now: () => clock, limits });
    expect(repository.saturation()).toMatchObject({ [category]: true });
    await repository.update(accepted.id, record => { record.deliveries[0]!.status = 'delivered'; record.deliveries[0]!.completedAt = new Date(clock).toISOString(); });
    expect(repository.saturation()[category]).toBe(category === 'retained');
    await repository.update(dropped.id, record => { record.deliveries[0]!.historyPending = undefined; });
    clock += 8 * 86400000; await repository.prune(100);
    expect(repository.saturation()).toMatchObject({ pending: false, retained: false, dropped: 0 });
  });
  it('rejects manual admission saturation with a recoverable service error', async () => {
    const { repository } = await repo({ retainedBytes: 1 });
    await expect(repository.insert({ version: 1, id: source().id, createdAt: new Date(now).toISOString(), deliveries: [], control: false })).rejects.toMatchObject({ status: 503 });
    expect(repository.all()).toHaveLength(0);
    expect(await repository.admit(source(), [])).toMatchObject({ decision: 'empty' });
  });
  it('uses strict sequence fences even with equal timestamps or wall clock rollback', async () => {
    const { repository } = await repo();
    expect((await repository.admit(source(1), [receiver()]))!.deliveries).toHaveLength(0);
    expect((await repository.admit({ ...source(2), occurredAt: new Date(now - 1000).toISOString() }, [receiver()]))!.deliveries).toHaveLength(1);
  });
  it('freezes all recipients and bytes in one admission; repeat admission always reuses it', async () => {
    const { repository, dir } = await repo();
    const a = await repository.admit(source(), [receiver(), receiver('00000000-0000-4000-8000-000000000002')]);
    expect(a!.deliveries).toHaveLength(2); expect(a!.deliveries.every(item => !!item.body)).toBe(true);
    expect(await repository.admit(source(), [])).toEqual(a);
    expect(readdirSync(join(dir, 'events')).filter(file => file.endsWith('.json'))).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, 'events', source().id + '.json'), 'utf8')).deliveries).toHaveLength(2);
  });
  it('defers failure rendering until a durable attempt can select disposition', async () => {
    const { repository } = await repo(); const failed = source(); failed.type = 'task.failed'; failed.snapshot.status = 'failed';
    const admission = await repository.admit(failed, [receiver()]);
    expect(admission!.deliveries[0]!.body).toBeUndefined();
    expect(admission!.deliveries[0]!.notBefore).toBe(new Date(now + 30_000).toISOString());
  });
  it('preserves an empty recipient decision across restart and later activation', async () => {
    const { repository, dir } = await repo(); const a = await repository.admit(source(), []);
    const reopened = await module.AdmissionRepository.open(dir, { now: () => now });
    expect(await reopened.admit(source(), [receiver()])).toEqual(a);
  });
  it('keeps delivered bodies charged to retained capacity even when no deliveries are pending', async () => {
    const { repository } = await repo({ retainedBytes: 12000 });
    const a = (await repository.admit(source(2), [receiver()]))!;
    await repository.update(a.id, item => { item.deliveries[0]!.status = 'delivered'; item.deliveries[0]!.completedAt = new Date(now).toISOString(); });
    const b = await repository.admit(source(3), [receiver()]);
    expect(b!.deliveries[0]!.status).toBe('dropped');
    expect(repository.get(a.id)!.deliveries[0]!.body).toBeDefined();
  });
  it('does not prune empty decisions before their source has been compacted', async () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-retention-')); dirs.push(dir);
    let clock = now;
    const repository = await module.AdmissionRepository.open(dir, { now: () => clock });
    const a = (await repository.admit(source(), []))!;
    clock += 8 * 86400000;
    await repository.prune(0);
    expect(repository.get(a.id)).toBeDefined();
    await repository.prune(2);
    expect(repository.get(a.id)).toBeUndefined();
  });
  it('records capacity drops using reserved control space and stops admission when that fills', async () => {
    const { repository } = await repo({ pendingCount: 0, controlBytes: 800 });
    const a = await repository.admit(source(2), [receiver()]);
    expect(a!.deliveries[0]!.status).toBe('dropped');
    expect(await repository.admit(source(3), [receiver()])).toBeUndefined();
  });
  it('reserves room for terminal diagnostics before admitting the first request', async () => {
    const { repository } = await repo({ retainedBytes: 12000 });
    const a = (await repository.admit(source(2), [receiver()]))!;
    expect(a.deliveries[0]!.status).toBe('pending');
    const b = (await repository.admit(source(3), [receiver()]))!;
    expect(b.deliveries[0]!.status).toBe('dropped');
    await repository.update(a.id, item => { const row = item.deliveries[0]!; row.status = 'failed'; row.completedAt = new Date(now).toISOString(); row.reason = 'x'.repeat(500); row.response = 'x'.repeat(4096); });
    expect(repository.get(a.id)!.deliveries[0]!.status).toBe('failed');
  });

});
