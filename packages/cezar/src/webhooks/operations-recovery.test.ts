import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AdmissionRepository } from './admission.ts';
import { WebhookStateError } from './endpoints.ts';
import { WebhookScheduler } from './scheduler.ts';
import { WebhookService } from './service.ts';

const roots: string[] = [], services: WebhookService[] = [];
const now = Date.parse('2026-10-13T12:00:00Z');
const at = new Date(now).toISOString();
afterEach(async () => {
  vi.restoreAllMocks();
  for (const service of services.splice(0)) await service.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
async function setup(action: 'test' | 'retry' | 'replay' = 'test') {
  vi.stubEnv('CEZ_WEBHOOKS', '1');
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-recovery-')); roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  const dataDir = join(root, '.ai/cezar'), directory = join(dataDir, 'webhooks');
  const send = vi.fn(async () => ({ kind: 'http' as const, status: 204 }));
  const options = { root, dataDir, projectId: 'fixture', mode: 'local' as const, serverPorts: () => [], scheduler: new WebhookScheduler(), now: () => now, send };
  const open = async () => { const service = (await WebhookService.open(options))!; services.push(service); return service; };
  const service = await open();
  const { receiver } = await service.create({ name: 'Fixture', url: 'https://receiver.invalid' });
  if (action !== 'test') await service.activate(receiver.id, 1);
  await service.dispose();
  const id = randomUUID();
  if (action !== 'test') {
    // Seed a retained delivery; the operation and all subsequent mutations use the service.
    const admissions = await AdmissionRepository.open(directory, { now: () => now });
    await admissions.insert({ version: 1, id: `evt_${randomUUID()}`, createdAt: at, control: false, deliveries: [{
      id, receiverId: receiver.id, deliveryRevision: 1, admittedRevision: 2, profile: 'minimal', eventType: 'task.finished',
      destination: 'https://receiver.invalid', createdAt: at, notBefore: at, expiresAt: new Date(now + 86400000).toISOString(),
      status: action === 'retry' ? 'retrying' : 'delivered', attempts: 1, body: '{"frozen":"original bytes"}',
      ...(action === 'retry' ? { nextAttemptAt: at } : { completedAt: at }),
    }] });
  }
  const input = { expectedRevision: action === 'test' ? 1 : 2, deliveryRevision: 1, operationId: 'x'.repeat(128) };
  const invoke = (service: WebhookService, value = input) => action === 'test' ? service.test(receiver.id, value) : service[action](id, value);
  const read = async () => (await AdmissionRepository.open(directory, { now: () => now })).all();
  return { directory, open, receiver, input, invoke, read, send };
}
function failNextRegistryReceipt(service: WebhookService) {
  // Operational headroom now makes a near-1MiB registry writable. Inject the
  // partial-commit boundary directly; real capacity recovery is covered separately.
  vi.spyOn(service.endpoints, 'recordOperation').mockRejectedValueOnce(new WebhookStateError(503, 'Receiver storage capacity exhausted'));
}

it.each(['test', 'retry', 'replay'] as const)('recovers partial %s admission after deletion on repeated reopen', async action => {
  const x = await setup(action);
  let service = await x.open(); failNextRegistryReceipt(service);
  await expect(x.invoke(service)).rejects.toMatchObject({ status: 503, message: 'Receiver storage capacity exhausted' });
  expect(service.needsRecovery).toBe(false);
  const before = await x.read(), receipt = before[0]!.operations![0]!;
  expect(receipt.applied).toBe(false);
  expect(before[0]!.deliveries.find(d => d.id === receipt.deliveryId)!.status).toBe('pending');
  await service.delete(x.receiver.id, x.input.expectedRevision);
  await service.dispose();
  for (let i = 0; i < 2; i++) {
    service = await x.open();
    expect(service.needsRecovery).toBe(false);
    expect(service.list().receivers).toHaveLength(0);
    const record = (await x.read())[0]!;
    expect(record.operations![0]).toEqual({ ...receipt, applied: true });
    expect(record.deliveries.find(d => d.id === receipt.deliveryId)).toMatchObject({ status: 'cancelled', body: before[0]!.deliveries.find(d => d.id === receipt.deliveryId)!.body });
    await expect(x.invoke(service)).rejects.toMatchObject({ status: 404 });
    await expect(x.invoke(service, { ...x.input, deliveryRevision: 2 })).rejects.toThrow('Operation ID');
    await service.tick(); await service.dispose();
  }
  expect(x.send).not.toHaveBeenCalled();
});

// The 'test' fixture stays Inactive, which cannot be paused (409), so that pairing does not exist.
it.each((['test', 'retry', 'replay'] as const).flatMap(action =>
  (['rename', 'configuration', 'pause', 'rotate'] as const).filter(mutation => action !== 'test' || mutation !== 'pause')
    .map(mutation => ({ action, mutation }))))('settles partial $action admission after a later $mutation without replaying consent', async ({ action, mutation }) => {
  const x = await setup(action);
  let service = await x.open(); failNextRegistryReceipt(service);
  await expect(x.invoke(service)).rejects.toMatchObject({ status: 503 });
  const before = (await x.read())[0]!, receipt = before.operations![0]!;
  if (mutation === 'rename' || mutation === 'configuration') {
    await service.update(x.receiver.id, { expectedRevision: x.input.expectedRevision, name: 'F', profile: 'minimal', preset: 'attention', events: [], includeScheduledFailures: false, scope: 'main_and_questions', graceSeconds: 180, allowLocalNetwork: false,
      ...(mutation === 'configuration' ? { url: 'https://new.invalid' } : {}) });
  } else if (mutation === 'pause') await service.pause(x.receiver.id, x.input.expectedRevision);
  else await service.rotate(x.receiver.id, x.input.expectedRevision, 'revoke_now');
  const changed = service.list().receivers[0]!;
  await service.dispose();
  for (let i = 0; i < 2; i++) {
    service = await x.open();
    expect(service.list().receivers[0]).toMatchObject({ revision: changed.revision, deliveryRevision: changed.deliveryRevision, state: changed.state, lastTest: 'none' });
    expect(await x.invoke(service)).toEqual({ deliveryId: receipt.deliveryId });
    const record = (await x.read())[0]!;
    expect(record.operations![0]).toEqual({ ...receipt, applied: true });
    expect(record.deliveries.find(d => d.id === receipt.deliveryId)).toMatchObject({ status: ['configuration', 'pause'].includes(mutation) ? 'cancelled' : 'superseded', body: before.deliveries.find(d => d.id === receipt.deliveryId)!.body });
    await service.tick(); await service.dispose();
  }
  expect(x.send).not.toHaveBeenCalled();
});

it.each(['test', 'retry', 'replay'] as const)('keeps transiently unacknowledged %s retryable with identical identity and bytes', async action => {
  const x = await setup(action); let service = await x.open();
  const failure = vi.spyOn(service.endpoints, 'recordOperation').mockRejectedValueOnce(new Error('temporary write failure'));
  await expect(x.invoke(service)).rejects.toThrow('temporary write failure'); failure.mockRestore();
  const before = (await x.read())[0]!, receipt = before.operations![0]!;
  expect(receipt.applied).toBe(false);
  expect(service.needsRecovery).toBe(true);
  await service.dispose(); service = await x.open();
  expect(await x.invoke(service)).toEqual({ deliveryId: receipt.deliveryId });
  expect(service.list().receivers[0]!.revision).toBe(x.input.expectedRevision + 1);
  expect((await x.read())[0]!.deliveries).toEqual(before.deliveries);
  expect((await x.read())[0]!.operations).toEqual([{ ...receipt, applied: true }]);
  await expect(x.invoke(service, { ...x.input, expectedRevision: x.input.expectedRevision + 1 })).rejects.toThrow('Operation ID');
});

it('does not settle a still-valid receipt when recovery itself fails transiently', async () => {
  const x = await setup(); let service = await x.open();
  const fail = vi.spyOn(service.endpoints, 'recordOperation').mockRejectedValueOnce(new WebhookStateError(503, 'temporary capacity'));
  await expect(x.invoke(service)).rejects.toThrow('temporary capacity'); fail.mockRestore();
  const before = await x.read(); await service.dispose();
  // A second failure during startup is not evidence that the operation was superseded.
  const { EndpointRegistry } = await import('./endpoints.ts');
  const recovery = vi.spyOn(EndpointRegistry.prototype, 'recordOperation').mockRejectedValueOnce(new Error('temporary storage'));
  await expect(x.open()).rejects.toThrow('temporary storage'); recovery.mockRestore();
  expect(await x.read()).toEqual(before);
  service = await x.open();
  expect(await x.invoke(service)).toEqual({ deliveryId: before[0]!.operations![0]!.deliveryId });
  expect((await x.read())[0]!.operations![0]!.applied).toBe(true);
});

it('does not supersede a newer successful retry of the same delivery', async () => {
  const x = await setup('retry'); let service = await x.open();
  const failure = vi.spyOn(service.endpoints, 'recordOperation').mockRejectedValueOnce(new WebhookStateError(503, 'temporary capacity'));
  await expect(x.invoke(service)).rejects.toThrow('temporary capacity'); failure.mockRestore();
  const later = await x.invoke(service, { ...x.input, operationId: 'later-retry' });
  const before = (await x.read())[0]!;
  expect(before.operations!.map(o => o.applied)).toEqual([false, true]);
  await service.dispose(); service = await x.open();
  const record = (await x.read())[0]!;
  expect(record.operations!.map(o => o.applied)).toEqual([true, true]);
  expect(record.deliveries).toEqual(before.deliveries);
  expect(await x.invoke(service)).toEqual(later);
  expect(await x.invoke(service, { ...x.input, operationId: 'later-retry' })).toEqual(later);
});

it('recognizes a committed acknowledgement after receipt publication failed and a later rename', async () => {
  const x = await setup(); let service = await x.open();
  const failure = vi.spyOn(AdmissionRepository.prototype, 'update').mockRejectedValueOnce(new WebhookStateError(503, 'temporary admission write'));
  await expect(x.invoke(service)).rejects.toThrow('temporary admission write'); failure.mockRestore();
  const before = (await x.read())[0]!;
  expect(before.operations![0]!.applied).toBe(false);
  await service.update(x.receiver.id, { expectedRevision: 2, name: 'Renamed', profile: 'minimal', preset: 'attention', events: [], includeScheduledFailures: false, scope: 'main_and_questions', graceSeconds: 180, allowLocalNetwork: false });
  await service.dispose(); service = await x.open();
  expect(service.list().receivers[0]!.revision).toBe(3);
  expect((await x.read())[0]!.deliveries).toEqual(before.deliveries);
  expect(await x.invoke(service)).toEqual({ deliveryId: before.deliveries[0]!.id });
  await service.tick(); expect(x.send).toHaveBeenCalledTimes(1);
  await service.dispose(); service = await x.open();
  expect(await x.invoke(service)).toEqual({ deliveryId: before.deliveries[0]!.id });
  await service.tick(); expect(x.send).toHaveBeenCalledTimes(1);
});

it('retries interrupted supersession without losing the receipt or its frozen bytes', async () => {
  const x = await setup();
  let service = await x.open(); failNextRegistryReceipt(service);
  await expect(x.invoke(service)).rejects.toMatchObject({ status: 503 });
  await service.rotate(x.receiver.id, 1, 'revoke_now');
  await service.dispose(); const before = await x.read();
  const failure = vi.spyOn(AdmissionRepository.prototype, 'update').mockRejectedValueOnce(new Error('temporary settlement failure'));
  await expect(x.open()).rejects.toThrow('temporary settlement failure'); failure.mockRestore();
  expect(await x.read()).toEqual(before);
  service = await x.open();
  expect((await x.read())[0]!.operations![0]!.applied).toBe(true);
  expect((await x.read())[0]!.deliveries[0]).toMatchObject({ status: 'superseded', body: before[0]!.deliveries[0]!.body });
  await service.tick(); expect(x.send).not.toHaveBeenCalled();
});
