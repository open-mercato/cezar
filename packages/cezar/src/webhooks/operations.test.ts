import { realpathSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AdmissionRepository } from './admission.ts';
import { EndpointRegistry } from './endpoints.ts';
import { ManualOperations } from './operations.ts';
const dirs: string[] = [];
const now = Date.parse('2026-10-13T12:00:00Z');
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function setup() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-operations-')); dirs.push(dir);
  const dependencies = { installationId: 'test', highWater: () => 0, now: () => now, assertOwner() {} };
  const endpoints = await EndpointRegistry.open(dir, dependencies);
  const admissions = await AdmissionRepository.open(dir, { now: () => now });
  const created = await endpoints.create({ name: 'Never send this text', url: 'https://example.com' });
  const operations = new ManualOperations(endpoints, admissions, () => now, () => ({ kind: 'ready' }));
  return { dir, endpoints, admissions, operations, id: created.receiver.id, dependencies };
}
describe('durable manual webhook operations', () => {
  it('deduplicates lost test responses even after the receiver revision advanced and a restart', async () => {
    const x = await setup(); const input = { expectedRevision: 1, deliveryRevision: 1, operationId: 'test-click' };
    const first = await x.operations.test(x.id, input);
    expect(x.endpoints.list().receivers[0]!.revision).toBe(2);
    const endpoints = await EndpointRegistry.open(x.dir, x.dependencies);
    const admissions = await AdmissionRepository.open(x.dir, { now: () => now });
    const reopened = new ManualOperations(endpoints, admissions, () => now, () => ({ kind: 'ready' }));
    expect(await reopened.test(x.id, input)).toEqual(first);
    const record = admissions.all()[0]!;
    expect(record.deliveries).toHaveLength(1);
    expect(JSON.parse(record.deliveries[0]!.body!)).toEqual({ id: record.id, type: 'webhook.test', schemaVersion: 1, occurredAt: new Date(now).toISOString(), data: { test: true, format: 'cezar.json.v1' } });
    await expect(reopened.test(x.id, { ...input, expectedRevision: 2 })).rejects.toThrow('Operation ID');
  });
  it('repairs the atomic admission / endpoint acknowledgement crash boundary without a second test', async () => {
    const x = await setup(); const input = { expectedRevision: 1, deliveryRevision: 1, operationId: 'crash-click' };
    const first = await x.operations.test(x.id, input);
    const event = x.admissions.all()[0]!;
    await x.admissions.update(event.id, value => { value.operations![0]!.applied = false; });
    await x.operations.recover();
    expect(await x.operations.test(x.id, input)).toEqual(first);
    expect(x.endpoints.list().receivers[0]!.revision).toBe(2);
  });
  it('rejects operations for deleted receivers and cross-configuration delivery revisions', async () => {
    const x = await setup();
    await expect(x.operations.test(x.id, { expectedRevision: 1, deliveryRevision: 2, operationId: 'x' })).rejects.toThrow('revision');
    await x.endpoints.delete(x.id, 1);
    await expect(x.operations.test(x.id, { expectedRevision: 1, deliveryRevision: 1, operationId: 'x' })).rejects.toThrow('not found');
  });
});
