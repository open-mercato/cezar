import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AdmissionRepository, type Admission } from './admission.ts';
import { privateReceiverSchema } from './endpoints.ts';
import { redactSource } from './payload.ts';

const now = Date.parse('2026-10-20T12:00:00Z'), at = new Date(now).toISOString();
const cap = 8 * 1024 * 1024;
const dirs: string[] = [];
function directory() { const dir = mkdtempSync(join(realpathSync(tmpdir()), 'admission-capacity-')); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function nearCap(): Admission {
  const record: Admission = { version: 1, id: `evt_${randomUUID()}`, createdAt: at, control: false, deliveries: Array.from({ length: 170 }, () => ({
    id: randomUUID(), receiverId: randomUUID(), deliveryRevision: 1, admittedRevision: 1, profile: 'standard', eventType: 'task.finished',
    destination: 'https://example.com', createdAt: at, notBefore: at, expiresAt: new Date(now + 72 * 3600000).toISOString(), status: 'pending', attempts: 0, body: 'x'.repeat(48000),
  })) };
  let remaining = cap - 256 - Buffer.byteLength(JSON.stringify(record));
  for (const row of record.deliveries) { const add = Math.min(remaining, 65536 - row.body!.length); row.body += 'x'.repeat(add); remaining -= add; }
  expect(Buffer.byteLength(JSON.stringify(record))).toBe(cap - 256);
  return record;
}
it.each(['insert', 'legacy disk'] as const)('publishes near-cap claims and results with frozen bytes and recovery (%s)', async mode => {
  const dir = directory(), original = nearCap();
  if (mode === 'legacy disk') { mkdirSync(join(dir, 'events')); writeFileSync(join(dir, 'events', `${original.id}.json`), JSON.stringify(original) + '\n'); }
  let repository = await AdmissionRepository.open(dir, { now: () => now });
  if (mode === 'insert') await repository.insert(original);
  const token = randomUUID();
  await repository.update(original.id, record => { const row = record.deliveries[0]!; row.status = 'in_flight'; row.attempts = 1; row.claim = { token, revision: 1, until: at }; });
  repository = await AdmissionRepository.open(dir, { now: () => now });
  await repository.update(original.id, record => { for (const row of record.deliveries) {
    row.status = 'delivered'; delete row.claim; row.completedAt = at; row.httpStatus = 200; row.response = 'x'.repeat(4000);
    row.historyPending = true; row.resultEffects = { token, revision: 1, at, outcome: 'success' };
  } });
  repository = await AdmissionRepository.open(dir, { now: () => now });
  const saved = repository.get(original.id)!;
  expect(saved.deliveries.every(row => row.status === 'delivered' && row.resultEffects?.token === token && row.historyPending)).toBe(true);
  expect(saved.deliveries.map(row => row.body)).toEqual(original.deliveries.map(row => row.body));
  expect(Buffer.byteLength(readFileSync(join(dir, 'events', `${original.id}.json`)))).toBeGreaterThan(cap);
  await expect(repository.update(original.id, record => { record.deliveries[0]!.body = 'changed'; })).rejects.toThrow('Frozen webhook bytes');
});
it('reports oversized fanout as retained saturation across restart, until its decision is pruned', async () => {
  const dir = directory(); let clock = now;
  let repository = await AdmissionRepository.open(dir, { now: () => clock });
  const receivers = Array.from({ length: 200 }, () => privateReceiverSchema.parse({ id: randomUUID(), name: 'Ops', url: 'https://example.com', profile: 'standard', state: 'active', revision: 1, deliveryRevision: 1, secret: 'synthetic', activation: { installationId: 'inst_test', sequence: 1 }, createdAt: at, updatedAt: at, consecutiveFailures: 0, activationBlocked: false, lastTest: 'none', graceSeconds: 0 }));
  const source = redactSource({ version: 1, id: `evt_${randomUUID()}`, sequence: 2, installationId: 'inst_test', projectId: 'project', previousStatus: 'running', episodeId: 'task-2', type: 'task.attention_required', occurredAt: at, mode: 'local', snapshot: { id: 'task', status: 'waiting', archived: false, continuation: 0, attentionRequest: { requestId: 'ask', askedAt: at, questions: Array.from({ length: 20 }, () => ({ question: 'q'.repeat(1900), options: [{ label: 'Choose', description: 'd'.repeat(400) }] })) } } }, []);
  const record = (await repository.admit(source, receivers))!;
  expect(record.deliveries).toHaveLength(200);
  expect(record.deliveries.every(row => row.status === 'dropped' && row.reason === 'retained_capacity')).toBe(true);
  expect(repository.saturation()).toEqual({ retained: true, pending: false, control: false, dropped: 200 });
  repository = await AdmissionRepository.open(dir, { now: () => clock });
  expect(repository.saturation().retained).toBe(true);
  expect(await repository.admit(source, [])).toEqual(record);
  await repository.update(record.id, next => { for (const row of next.deliveries) delete row.historyPending; });
  clock += 31 * 86400000; await repository.prune(2);
  expect(repository.saturation()).toEqual({ retained: false, pending: false, control: false, dropped: 0 });
});
it('does not spend aggregate retained reservation twice for large records', async () => {
  const repository = await AdmissionRepository.open(directory(), { now: () => now, limits: { retainedBytes: 11 * 1024 * 1024 } });
  await repository.insert(nearCap());
  await expect(repository.insert(nearCap())).rejects.toMatchObject({ status: 503 });
});

it('drains legacy deferred-body reservations without admitting new oversized failure fanout', async () => {
  const dir = directory(), record = nearCap();
  for (const row of record.deliveries) { row.eventType = 'task.failed'; delete row.body; }
  mkdirSync(join(dir, 'events')); writeFileSync(join(dir, 'events', `${record.id}.json`), JSON.stringify(record) + '\n');
  let repository = await AdmissionRepository.open(dir, { now: () => now });
  await expect(repository.insert({ ...record, id: `evt_${randomUUID()}` })).rejects.toMatchObject({ status: 503 });
  await repository.update(record.id, next => { for (const row of next.deliveries) {
    row.body = 'x'.repeat(65536); row.status = 'delivered'; row.completedAt = at;
    row.resultEffects = { token: randomUUID(), revision: 1, at, outcome: 'success' };
  } });
  repository = await AdmissionRepository.open(dir, { now: () => now });
  expect(repository.get(record.id)!.deliveries.every(row => row.body?.length === 65536 && row.resultEffects)).toBe(true);
  await expect(repository.update(record.id, next => { next.deliveries.push({ ...next.deliveries[0]!, id: randomUUID(), body: 'x'.repeat(65536) }); })).rejects.toMatchObject({ status: 503 });
});
it('keeps old oversized fanout decisions visibly saturated after reopening', async () => {
  const dir = directory(), record = nearCap();
  record.control = true; record.decision = 'pending_capacity';
  record.capacityNeed = { retainedBytes: 12 * 1024 * 1024, retainedObjects: 201, pendingBytes: 10 * 1024 * 1024, pendingCount: 200 };
  for (const row of record.deliveries) { delete row.body; row.status = 'dropped'; row.reason = 'pending_capacity'; row.completedAt = at; }
  mkdirSync(join(dir, 'events')); writeFileSync(join(dir, 'events', `${record.id}.json`), JSON.stringify(record) + '\n');
  const repository = await AdmissionRepository.open(dir, { now: () => now });
  expect(repository.saturation()).toMatchObject({ retained: true, pending: false });
});
