import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AdmissionRepository, type Admission, type DeliveryRecord } from './admission.ts';
const day = 86400000, start = Date.parse('2026-10-01T00:00:00Z');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const at = (days: number) => new Date(start + days * day).toISOString();
function delivery(overrides: Partial<DeliveryRecord> = {}): DeliveryRecord {
  return { id: randomUUID(), receiverId: randomUUID(), deliveryRevision: 1, admittedRevision: 1, profile: 'standard',
    eventType: 'task.finished', destination: 'https://receiver.invalid', createdAt: at(0), notBefore: at(0), expiresAt: at(3),
    status: 'delivered', completedAt: at(0), attempts: 1, body: 'frozen original', ...overrides };
}
async function fixture(old: DeliveryRecord) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-payload-retention-')); dirs.push(dir);
  let now = start;
  const deps = { now: () => now };
  const repo = await AdmissionRepository.open(dir, deps);
  const recent = delivery({ body: 'frozen replay', createdAt: at(6), completedAt: at(6) });
  const record: Admission = { version: 1, id: `evt_${randomUUID()}`, createdAt: at(0), sourceSequence: 1, control: false, deliveries: [old, recent] };
  await repo.insert(record);
  return { repo, record, recent, dir, deps, clock: (days: number) => { now = start + days * day; },
    disk: () => JSON.parse(readFileSync(join(dir, 'events', `${record.id}.json`), 'utf8')) as Admission };
}
it.each(['delivered', 'failed', 'superseded', 'cancelled', 'dropped'] as const)('expires %s bytes independently while retaining cycle metadata and enforcing frozen updates', async status => {
  const old = delivery({ status }); const x = await fixture(old);
  x.clock(7); await x.repo.prune(1);
  expect(x.disk().deliveries[0]).toEqual({ ...old, body: undefined });
  expect(x.disk().deliveries[1]).toEqual(x.recent);
  const reopened = await AdmissionRepository.open(x.dir, x.deps);
  expect(reopened.get(x.record.id)).toEqual(x.disk());
  await expect(reopened.update(x.record.id, record => { record.deliveries[1]!.body = 'changed'; })).rejects.toThrow('Frozen webhook bytes');
  x.clock(30); await reopened.prune(1);
  expect(reopened.get(x.record.id)).toBeUndefined();
});
it.each(['source', 'operation', 'claim', 'history', 'effects', 'pending', 'missingCompletion'] as const)('preserves payloads guarded by %s until the obligation clears', async guard => {
  const old = delivery(); const x = await fixture(old);
  await x.repo.update(x.record.id, record => {
    const row = record.deliveries[0]!;
    if (guard === 'operation') record.operations = [{ operationId: 'pending-op', fingerprint: 'test', receiverId: row.receiverId, expectedRevision: 1, deliveryId: row.id, action: 'replay', applied: false }];
    if (guard === 'claim') row.claim = { token: randomUUID(), revision: 1, until: at(9) };
    if (guard === 'history') row.historyPending = true;
    if (guard === 'effects') row.resultEffects = { token: randomUUID(), revision: 1, at: at(0), outcome: 'success' };
    if (guard === 'pending') row.status = 'retrying';
    if (guard === 'missingCompletion') delete row.completedAt;
  });
  x.clock(8); await x.repo.prune(guard === 'source' ? 0 : 1);
  expect(x.disk().deliveries[0]!.body).toBe(old.body);
  const reopened = await AdmissionRepository.open(x.dir, x.deps);
  expect(reopened.get(x.record.id)!.deliveries[0]!.body).toBe(old.body);
  await reopened.update(x.record.id, record => {
    const row = record.deliveries[0]!;
    delete row.claim; delete row.historyPending; delete row.resultEffects;
    row.status = 'delivered'; row.completedAt = at(0);
    for (const operation of record.operations ?? []) operation.applied = true;
  });
  await reopened.prune(1);
  expect(x.disk().deliveries[0]!.body).toBeUndefined();
  expect(x.disk().deliveries[1]).toEqual(x.recent);
});
it('releases expired failure payload capacity without reserving another deferred body, including after restart', async () => {
  const old = delivery({ eventType: 'task.failed', status: 'failed', body: 'x'.repeat(60000) });
  const x = await fixture(old);
  x.clock(7); await x.repo.prune(1);
  // Two metadata reservations plus the tiny current replay fit below 20 KiB;
  // the old payload or a spurious 128 KiB deferred reservation does not.
  const reopened = await AdmissionRepository.open(x.dir, { ...x.deps, limits: { retainedBytes: 20000 } });
  expect(reopened.get(x.record.id)!.deliveries[0]!.body).toBeUndefined();
  // A subsequent write checks the live accounting as well as reconstructed usage.
  await x.repo.update(x.record.id, record => { record.deliveries[0]!.reason = 'retained metadata'; });
  expect(Reflect.get(x.repo, 'usage').retainedBytes).toBeLessThan(20000);
  // Unrendered failures still reserve their body while pending.
  await expect(reopened.insert({ ...x.record, id: `evt_${randomUUID()}`, deliveries: [delivery({ eventType: 'task.failed', status: 'pending', body: undefined, completedAt: undefined })] })).rejects.toThrow('capacity');
});
it('does not spend the single-admission payload budget on terminal failures with no body', async () => {
  const x = await fixture(delivery());
  const terminal = Array.from({ length: 65 }, () => delivery({ eventType: 'task.failed', status: 'failed', body: undefined }));
  const record = { ...x.record, id: `evt_${randomUUID()}`, deliveries: terminal };
  await expect(x.repo.insert(record)).resolves.toEqual(record);
  // The same number of deferred pending bodies really does exceed the 8 MiB file budget.
  await expect(x.repo.insert({ ...record, id: `evt_${randomUUID()}`, deliveries: terminal.map(row => ({ ...row, status: 'pending' as const, completedAt: undefined })) })).rejects.toThrow('capacity');
});
