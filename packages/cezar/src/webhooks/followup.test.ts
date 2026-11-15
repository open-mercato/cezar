import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WebhookService } from './service.ts';
import { WebhookCoordinator } from './coordinator.ts';
import { WebhookScheduler } from './scheduler.ts';
import { AdmissionRepository } from './admission.ts';
import { EndpointRegistry } from './endpoints.ts';
import { Outbox } from './outbox.ts';
import type { SendResult } from './transport.ts';
import * as ownership from './ownership.ts';

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });
async function fixture() {
  vi.stubEnv('CEZ_WEBHOOKS', '1');
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-followup-')); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  let now = Date.parse('2026-10-13T12:00:00Z');
  const dataDir = join(root, '.ai/cezar'), directory = join(dataDir, 'webhooks');
  const send = vi.fn(async (): Promise<SendResult> => ({ kind: 'http', status: 200, response: 'legacy synthetic_token_12345' }));
  const options = { root, dataDir, projectId: 'fixture', mode: 'local' as const, serverPorts: () => [], scheduler: new WebhookScheduler(), now: () => now, send };
  const open = async () => { const service = (await WebhookService.open(options))!; cleanups.push(() => service.dispose()); return service; };
  const service = await open();
  const store = RunStore.open(dataDir); cleanups.push(() => store.flush()); service.attach(store, { isActive: () => false }, true);
  const { receiver } = await service.create({ name: 'Fixture', url: 'https://example.invalid/hook?token=synthetic_token_12345', graceSeconds: 0 });
  await service.activate(receiver.id, 1);
  const capture = () => { const run = store.createRun({ title: 'Fixture', task: 'Fixture', workflow: 'w', steps: [] }); store.updateRun(run.id, { status: 'done' }); };
  return { root, directory, service, store, receiver, capture, send, open, advance: (days: number) => { now += days * 86400000; } };
}
const repository = (service: WebhookService) => (service as unknown as { admissions: AdmissionRepository }).admissions;

it.each(['none', 'pending', 'admission', 'outbox'] as const)('R1 retires reset sequence fences without capture/restart, interrupted at %s', async boundary => {
  const x = await fixture();
  x.send.mockResolvedValue(boundary === 'pending' ? { kind: 'transient', reason: 'fixture retry' } : { kind: 'http', status: 200 });
  x.capture(); await x.service.tick();
  const old = repository(x.service).all()[0]!;
  // Force a source-less capacity decision with a sequence higher than the retained body.
  (repository(x.service) as unknown as { limits: { retainedBytes: number } }).limits.retainedBytes = 12000;
  x.capture(); await x.service.tick();
  const capacity = repository(x.service).all().find(row => row.control && row.decision === 'retained_capacity')!;
  expect(capacity.source).toBeUndefined(); expect(capacity.sourceSequence).toBeGreaterThan(old.sourceSequence!);
  await x.service.dispose(); rmSync(join(x.directory, 'identity.json'));
  if (boundary === 'admission') {
    const original = AdmissionRepository.prototype.update;
    vi.spyOn(AdmissionRepository.prototype, 'update').mockImplementationOnce(async function (this: AdmissionRepository, ...args) { await original.apply(this, args); throw new Error('reset interrupted'); });
  } else if (boundary === 'outbox') {
    const original = Outbox.open;
    vi.spyOn(Outbox, 'open').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('reset interrupted'); });
  }
  if (boundary === 'admission' || boundary === 'outbox') {
    await expect(x.open()).rejects.toThrow('reset interrupted'); vi.restoreAllMocks();
    expect(JSON.parse(readFileSync(join(x.directory, 'identity.json'), 'utf8')).resetPending).toBe(true);
  }
  const repaired = await x.open();
  expect(repository(repaired).get(old.id)?.deliveries[0]?.body).toBe(old.deliveries[0]!.body);
  expect(repository(repaired).get(old.id)?.id).toBe(old.id);
  expect(repaired.list().receivers[0]!.state).toBe('inactive');
  x.advance(8); await repaired.tick();
  expect(repository(repaired).all()).toEqual([]);
  expect(existsSync(join(x.directory, 'events', `${old.id}.json`))).toBe(false);
  expect(existsSync(join(x.directory, 'events', `${capacity.id}.json`))).toBe(false);
  expect(repaired.deliveryPage(x.receiver.id, { limit: 100 }).items).toHaveLength(2);
  x.advance(23); await repaired.tick();
  expect(repaired.deliveryPage(x.receiver.id, { limit: 100 }).items).toEqual([]);
  expect(x.send).toHaveBeenCalledTimes(1);
}, 20000);

it.each([false, true])('R2 retries failed-construction token release after repair (replacement token %s)', async replaced => {
  const x = await fixture(); await x.service.dispose();
  const coordinator = new WebhookCoordinator({ mode: () => 'local', ports: () => [], projects: async () => [], singleProject: true });
  cleanups.push(() => coordinator.dispose());
  const acquire = ownership.acquireOwnership; let owner: ownership.WebhookOwnership | undefined;
  let fail = true;
  vi.spyOn(ownership, 'acquireOwnership').mockImplementation(async (...args) => {
    const acquired = await acquire(...args);
    if (!acquired) return undefined;
    owner = acquired;
    if (owner) { const release = owner.release.bind(owner); owner.release = async () => { if (fail) throw new Error('release EACCES'); await release(); }; cleanups.push(() => release()); }
    return owner;
  });
  vi.spyOn(EndpointRegistry, 'open').mockRejectedValueOnce(new Error('initial EIO'));
  await expect(coordinator.get('fixture', x.root)).rejects.toThrow('initial EIO');
  const lock = join(x.directory, 'owner.lock'), original = readFileSync(lock, 'utf8');
  expect(JSON.parse(original).pid).toBe(process.pid);
  await expect(coordinator.get('fixture', x.root)).rejects.toThrow();
  expect(readFileSync(lock, 'utf8')).toBe(original); // Repeated failed release cannot evict its handle.
  fail = false; vi.restoreAllMocks();
  // Failed first opens now wait for the recovery cooldown before retrying cleanup.
  let retryAt = Date.now() + 15000;
  vi.spyOn(Date, 'now').mockImplementation(() => retryAt);
  if (replaced) {
    const replacement = JSON.stringify({ ...JSON.parse(original), token: randomUUID() }); writeFileSync(lock, replacement);
    await expect(coordinator.get('fixture', x.root)).rejects.toThrow('Another process owns');
    expect(readFileSync(lock, 'utf8')).toBe(replacement);
    writeFileSync(lock, original); await owner!.release();
    retryAt += 15000;
  }
  const repaired = await coordinator.get('fixture', x.root);
  expect(repaired.list().receivers).toHaveLength(1);
  expect(coordinator.count()).toBe(1);
});

it.each(['admission', 'deleted', 'history_only', 'recovered_result'] as const)('R3 removes legacy responses durably before projection/recovery: %s', async kind => {
  const x = await fixture(); x.capture();
  if (kind === 'recovered_result') {
    vi.spyOn(x.service as unknown as { recordHistory(): Promise<void> }, 'recordHistory').mockRejectedValueOnce(new Error('result interrupted'));
    await expect(x.service.tick()).rejects.toThrow('result interrupted');
  } else await x.service.tick();
  const old = repository(x.service).all()[0]!;
  if (kind === 'history_only') { x.advance(8); await x.service.tick(); expect(repository(x.service).all()).toEqual([]); }
  if (kind === 'deleted' || kind === 'history_only') await x.service.delete(x.receiver.id, x.service.list().receivers[0]!.revision);
  await x.service.dispose();
  const repaired = await x.open();
  const row = repaired.deliveryPage(x.receiver.id, { limit: 100 }).items[0]!;
  expect(row.response).toBeUndefined(); expect(row.eventId).toBe(old.id); expect(row.deliveryId).toBe(old.deliveries[0]!.id);
  const path = join(x.directory, 'events', `${old.id}.json`), history = join(x.directory, 'deliveries.ndjson');
  expect(readFileSync(history, 'utf8')).not.toContain('synthetic_token_12345');
  if (kind !== 'history_only') {
    const disk = JSON.parse(readFileSync(path, 'utf8'));
    expect(disk.deliveries[0].response).toBeUndefined(); expect(disk.deliveries[0].body).toBe(old.deliveries[0]!.body);
    expect(disk.deliveries[0].historyPending).toBeUndefined(); expect(disk.deliveries[0].resultEffects).toBeUndefined();
  }
  await repaired.dispose();
  const files = [history, ...(existsSync(path) ? [path] : [])];
  const before = files.map(file => ({ bytes: readFileSync(file, 'utf8'), inode: statSync(file).ino }));
  const again = await x.open();
  expect(files.map(file => ({ bytes: readFileSync(file, 'utf8'), inode: statSync(file).ino }))).toEqual(before);
  expect(again.deliveryPage(x.receiver.id, { limit: 100 }).items[0]!.response).toBeUndefined();
  expect(x.send).toHaveBeenCalledTimes(1);
});

it('R3 resumes a partially persisted cleanup and never migrates under another live owner', async () => {
  const x = await fixture(); x.capture(); await x.service.tick();
  const old = repository(x.service).all()[0]!, path = join(x.directory, 'events', `${old.id}.json`), history = join(x.directory, 'deliveries.ndjson');
  const files = [path, history], before = files.map(file => readFileSync(file, 'utf8'));
  // Opening alongside the existing live owner must leave even unsafe legacy metadata alone.
  await expect(x.open()).rejects.toThrow('Another process owns');
  expect(files.map(file => readFileSync(file, 'utf8'))).toEqual(before);
  await x.service.dispose();
  // Fail after one sanitized admission was published, before history can be cleaned.
  const original = AdmissionRepository.prototype.update;
  vi.spyOn(AdmissionRepository.prototype, 'update').mockImplementationOnce(async function (this: AdmissionRepository, ...args) { await original.apply(this, args); throw new Error('cleanup interrupted'); });
  await expect(x.open()).rejects.toThrow('cleanup interrupted'); vi.restoreAllMocks();
  expect(JSON.parse(readFileSync(path, 'utf8')).deliveries[0].response).toBeUndefined();
  expect(readFileSync(history, 'utf8')).toContain('synthetic_token_12345');
  const inode = statSync(path).ino;
  const repaired = await x.open();
  expect(statSync(path).ino).toBe(inode); // Already-clean admissions are not republished on retry.
  expect(readFileSync(history, 'utf8')).not.toContain('synthetic_token_12345');
  expect(repository(repaired).get(old.id)?.deliveries[0]?.body).toBe(old.deliveries[0]!.body);
  expect(repaired.deliveryPage(x.receiver.id, { limit: 100 }).items[0]?.response).toBeUndefined();
});
