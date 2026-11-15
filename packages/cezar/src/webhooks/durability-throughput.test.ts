import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as runIndex from '../runs/run-index.ts';
import { RunStore } from '../runs/store.ts';
import * as storage from './storage.ts';
import { ProjectLimits } from './limits.ts';
import { AdmissionRepository } from './admission.ts';
import { privateReceiverSchema } from './endpoints.ts';
import { WebhookScheduler } from './scheduler.ts';
import { WebhookService, type WebhookServiceOptions } from './service.ts';
import type { WebhookSource } from './source.ts';
import type { SendResult, WebhookSend } from './transport.ts';

// Counts disk reads of the run index without changing what they return.
vi.mock('../runs/run-index.ts', async original => {
  const actual = await original<typeof import('../runs/run-index.ts')>();
  return { ...actual, readRunIndexDiagnostic: vi.fn(actual.readRunIndexDiagnostic) };
});

const roots: string[] = [];
const services: WebhookService[] = [];
const stores: RunStore[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  for (const store of stores.splice(0)) store.flush();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs(); vi.restoreAllMocks();
});

async function setup(extra: Partial<WebhookServiceOptions> = {}) {
  vi.stubEnv('CEZ_WEBHOOKS', '1');
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-durability-')); roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  const dataDir = join(root, '.ai/cezar');
  let now = Date.parse('2026-10-13T12:00:00Z');
  const send = vi.fn(async (_input: WebhookSend): Promise<SendResult> => ({ kind: 'http', status: 200 }));
  const options: WebhookServiceOptions = { root, dataDir, projectId: 'project', mode: 'local', serverPorts: () => [4317], scheduler: new WebhookScheduler(), now: () => now, send, ...extra };
  const open = async () => { const service = (await WebhookService.open(options))!; services.push(service); return service; };
  const close = async (service: WebhookService) => { services.splice(services.indexOf(service), 1); await service.dispose(); };
  const attach = (service: WebhookService) => { const store = RunStore.open(dataDir); stores.push(store); service.attach(store, { isActive: () => false }, true); return store; };
  return { dataDir, dir: join(dataDir, 'webhooks'), send, open, close, attach, now: () => now, advance: (ms: number) => { now += ms; } };
}
const finish = (store: RunStore, status: 'done' | 'review' | 'failed' | 'waiting', title = 'task') => {
  const run = store.createRun({ title, task: 't', workflow: 'w', steps: [] }); store.updateRun(run.id, { status }); return run;
};

describe('corrupt or unrelated low-value state degrades instead of failing open', () => {
  it('quarantines an unreadable limits.json and restarts with an empty bucket', async () => {
    const x = await setup();
    await x.close(await x.open());
    writeFileSync(join(x.dir, 'limits.json'), '{"version":1,');
    const service = await x.open();
    expect(readdirSync(x.dir).filter(name => name.startsWith('limits.json.corrupt-'))).toHaveLength(1);
    // Never more permissive than a full bucket: the restarted budget starts empty and the
    // manual-failure window full, then refills on its normal schedule.
    const limits = JSON.parse(readFileSync(join(x.dir, 'limits.json'), 'utf8'));
    expect(limits).toMatchObject({ tokens: 0, at: x.now() });
    expect(limits.failures).toHaveLength(10);
    expect(service.list().webhookHealth).toMatchObject({ status: 'degraded', reason: expect.stringContaining('rate-limit') });
    const budget = await ProjectLimits.open(x.dir, x.now);
    expect(await budget.take({ host: 'example.com', test: true }, x.now() + 5000)).toEqual({ allowed: false, retryAt: x.now() + 60000 });
    expect(await budget.take({ host: 'example.com', test: true }, x.now() + 60000)).toEqual({ allowed: true });
  });

  it('keeps the corrupt limiter at its original path if publishing the reset fails', async () => {
    const x = await setup();
    await x.close(await x.open());
    writeFileSync(join(x.dir, 'limits.json'), '{broken');
    const write = vi.spyOn(storage, 'atomicWrite');
    write.mockRejectedValueOnce(new Error('simulated disk full'));
    await expect(ProjectLimits.open(x.dir, x.now)).rejects.toThrow('simulated disk full');
    expect(readFileSync(join(x.dir, 'limits.json'), 'utf8')).toBe('{broken');
    write.mockRestore();
    const recovered = await ProjectLimits.open(x.dir, x.now);
    expect(await recovered.take({ host: 'example.com' }, x.now())).toEqual({ allowed: false, retryAt: x.now() + 500 });
    expect(await recovered.take({ host: 'example.com', test: true }, x.now() + 5000)).toEqual({ allowed: false, retryAt: x.now() + 60000 });
  });

  it('ignores a stray non-admission file in events/', async () => {
    const x = await setup();
    let service = await x.open();
    const { receiver } = await service.create({ name: 'Ops', url: 'https://example.com' });
    await service.test(receiver.id, { expectedRevision: 1, deliveryRevision: 1, operationId: 'op' });
    await x.close(service);
    writeFileSync(join(x.dir, 'events', '.DS_Store'), 'x');
    service = await x.open();
    expect(existsSync(join(x.dir, 'events', '.DS_Store'))).toBe(true);
    expect(service.list().webhookHealth.status).toBe('ready');
    await service.tick();
    expect(x.send).toHaveBeenCalledTimes(1);
  });

  it('quarantines an unreadable admission and safely resets instead of sending what it cannot account for', async () => {
    const x = await setup();
    let service = await x.open(); let store = x.attach(service);
    const { receiver } = await service.create({ name: 'Ops', url: 'https://example.com', graceSeconds: 600, preset: 'all' }); await service.activate(receiver.id, 1);
    finish(store, 'waiting', 'a'); finish(store, 'waiting', 'b');
    await service.tick();
    expect(service.deliveries(receiver.id).filter(item => item.status === 'pending')).toHaveLength(2);
    await x.close(service); store.flush();
    const names = readdirSync(join(x.dir, 'events'));
    writeFileSync(join(x.dir, 'events', names[0]!), '');
    service = await x.open(); store = x.attach(service);
    expect(readdirSync(join(x.dir, 'events')).filter(name => name.includes('.corrupt-'))).toHaveLength(1);
    const list = service.list();
    expect(list.receivers[0]!.state).toBe('inactive');
    expect(list.webhookHealth).toMatchObject({ status: 'degraded', reason: expect.stringContaining('quarantined') });
    expect(service.deliveries(receiver.id).map(item => [item.status, item.reason])).toEqual([['cancelled', 'integrity_reset']]);
    x.advance(3600_000); await service.tick();
    expect(x.send).not.toHaveBeenCalled();
    // The quarantine is not an admission: the next open neither fails nor resets again.
    await x.close(service);
    service = await x.open();
    expect(service.list().webhookHealth.reason).not.toContain('quarantined');
  });
});

describe('control space and empty decisions', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  const source = (sequence: number, type: WebhookSource['type'] = 'task.review_ready'): WebhookSource => ({ version: 1, id: `evt_00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`, sequence, installationId: 'inst_test', projectId: 'project', previousStatus: 'running', episodeId: `task-${sequence}-${sequence}`, type, occurredAt: new Date(now).toISOString(), mode: 'local', snapshot: { id: `task-${sequence}`, status: type === 'task.failed' ? 'failed' : 'review', archived: false, continuation: 0 } });
  const receiver = privateReceiverSchema.parse({ name: 'Ops', url: 'https://example.com', preset: 'custom', events: ['task.failed'], id: '00000000-0000-4000-8000-000000000001', state: 'active', revision: 1, deliveryRevision: 1, secret: 'synthetic-fixture', activation: { installationId: 'inst_test', sequence: 0 }, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), consecutiveFailures: 0, activationBlocked: false, lastTest: 'none' });

  it('retires an empty decision as soon as its source is compacted, not seven days later', async () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-control-')); roots.push(dir);
    const repository = await AdmissionRepository.open(dir, { now: () => now, limits: { controlObjects: 3 } });
    for (let sequence = 1; sequence <= 3; sequence++) expect(await repository.admit(source(sequence), [receiver])).toBeDefined();
    expect(await repository.admit(source(4), [receiver])).toBeUndefined();
    await repository.prune(2);
    expect(await repository.admit(source(4), [receiver])).toBeDefined();
    expect(repository.saturation().control).toBe(false);
    // A decision whose source could still be reprocessed is never retired.
    expect(repository.all().map(record => record.sourceSequence).sort()).toEqual([3, 4]);
  });

  it('a stream of non-selected transitions never holds a selected failure behind full control space', async () => {
    const x = await setup({ admissionLimits: { controlObjects: 3 } });
    const service = await x.open(); const store = x.attach(service);
    const { receiver } = await service.create({ name: 'Ops', url: 'https://example.com', preset: 'custom', events: ['task.failed'] });
    await service.activate(receiver.id, 1);
    for (let i = 0; i < 8; i++) finish(store, 'review', `review ${i}`);
    finish(store, 'failed', 'broken');
    await service.tick();
    x.advance(31_000); await service.tick();
    expect(x.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(x.send.mock.calls[0]![0].body)).toMatchObject({ type: 'task.failed' });
    expect(service.list().webhookHealth.saturation?.control).toBe(false);
  });
});

describe('throughput and idle cost', () => {
  it('an idle service does not rewrite its state files every maintenance window', async () => {
    const x = await setup();
    const service = await x.open(); const store = x.attach(service);
    const { receiver } = await service.create({ name: 'Ops', url: 'https://example.com', graceSeconds: 0 }); await service.activate(receiver.id, 1);
    finish(store, 'done');
    await service.tick(); expect(x.send).toHaveBeenCalledTimes(1);
    x.advance(31_000); await service.tick(); // compacts the consumed source once
    const fingerprint = () => ['outbox.ndjson', 'cursor.json', 'deliveries.ndjson', 'activity.ndjson', 'identity.json', 'endpoints.json']
      .map(name => `${name}:${statSync(join(x.dir, name)).ino}:${statSync(join(x.dir, name)).mtimeMs}`).join(' ');
    const before = fingerprint();
    for (let i = 0; i < 3; i++) { x.advance(31_000); await service.tick(); }
    expect(fingerprint()).toBe(before);
  });

  it('one tick drains every ready delivery, and the project budget still stops the drain', async () => {
    const x = await setup();
    const service = await x.open(); const store = x.attach(service);
    const { receiver } = await service.create({ name: 'Ops', url: 'https://example.com', graceSeconds: 0 }); await service.activate(receiver.id, 1);
    for (let i = 0; i < 5; i++) finish(store, 'done', `t${i}`);
    await service.tick();
    expect(x.send).toHaveBeenCalledTimes(5);
    for (let i = 0; i < 15; i++) finish(store, 'done', `u${i}`);
    await service.tick();
    // 10-token bucket: five already spent, five left; the rest wait for refill, not for 5 s ticks.
    expect(x.send).toHaveBeenCalledTimes(10);
    expect(service.deliveries(receiver.id).filter(item => item.reason === 'rate_limited')).toHaveLength(1);
  });

  it('an unopened project parses runs.json once per change, not once per held delivery', async () => {
    const x = await setup();
    let service = await x.open(); const store = x.attach(service);
    const { receiver } = await service.create({ name: 'Ops', url: 'https://example.com', graceSeconds: 0 }); await service.activate(receiver.id, 1);
    for (let i = 0; i < 10; i++) await service.endpoints.deliveryResult(receiver.id, 2, 1, 'transient', false);
    expect(service.list().receivers[0]!.state).toBe('suspended');
    for (let i = 0; i < 20; i++) finish(store, 'done', `t${i}`);
    await service.tick();
    await x.close(service); store.flush();
    service = await x.open(); // no store attached: disk-only freshness
    expect(service.deliveries(receiver.id).filter(item => item.status === 'pending')).toHaveLength(20);
    const reads = vi.mocked(runIndex.readRunIndexDiagnostic); reads.mockClear();
    await service.tick(); await service.tick(); service.list();
    expect(reads.mock.calls.length).toBeLessThanOrEqual(1);
    store.updateRun(store.listRuns()[0]!.id, { title: 'renamed' }); store.flush();
    await service.tick();
    expect(reads.mock.calls.length).toBe(2);
  });

  it('retries a transient index read failure without waiting for the file to change', async () => {
    const x = await setup();
    let service = await x.open(); const store = x.attach(service);
    const { receiver } = await service.create({ name: 'Ops', url: 'https://example.com', graceSeconds: 0 });
    await service.activate(receiver.id, 1);
    finish(store, 'done'); await service.tick();
    await x.close(service); store.flush();
    service = await x.open();
    vi.mocked(runIndex.readRunIndexDiagnostic).mockReturnValueOnce({
      runs: [], state: 'unavailable', omittedRuns: 0, reason: 'Transient read error',
    });
    service.deliveryPage(receiver.id, { limit: 100 });
    const page = service.deliveryPage(receiver.id, { limit: 100 });
    expect(page.items[0]!.taskAvailability).toBe('available');
  });

  it('pausing a receiver with queued deliveries commits the registry and history once', async () => {
    const x = await setup();
    const service = await x.open(); const store = x.attach(service);
    const { receiver } = await service.create({ name: 'Ops', url: 'https://example.com', graceSeconds: 180, preset: 'all' }); await service.activate(receiver.id, 1);
    for (let i = 0; i < 30; i++) finish(store, 'waiting', `t${i}`);
    await service.tick();
    expect(service.deliveries(receiver.id).filter(item => item.status === 'pending')).toHaveLength(30);
    const before = service.list().changeSequence;
    const history = vi.spyOn(storage, 'prepareText');
    await service.pause(receiver.id, service.list().receivers[0]!.revision);
    expect(service.list().changeSequence - before).toBeLessThanOrEqual(3);
    expect(history.mock.calls.filter(([, name]) => name === 'deliveries.ndjson')).toHaveLength(1);
    expect(service.deliveries(receiver.id).every(item => item.status === 'cancelled' && item.reason === 'receiver_changed' && !item.historyPending)).toBe(true);
    expect(service.deliveryPage(receiver.id, { limit: 100 }).total).toBe(30);
  });
});


describe('policy health', () => {
  it('reports blocked lifecycle deliveries and clears the warning after policy repair', async () => {
    const x = await setup();
    const service = await x.open(); const store = x.attach(service);
    const { receiver } = await service.create({ name: 'Ops', url: 'https://example.com', graceSeconds: 0 });
    await service.activate(receiver.id, 1);
    x.send.mockResolvedValueOnce({ kind: 'policy', reason: 'local_network_consent_required' });
    finish(store, 'done');
    await service.tick();
    expect(service.deliveries(receiver.id)[0]!.status).toBe('blocked_policy');
    expect(service.list().webhookHealth).toMatchObject({ status: 'degraded', reason: expect.stringContaining('destination policy') });
    x.advance(900000); await service.tick();
    expect(service.deliveries(receiver.id)[0]!.status).toBe('delivered');
    expect(service.list().webhookHealth.status).toBe('ready');
  });
});
