import { TelegramSendBudget, clearSharedTelegramCooldowns } from '../telegram/send-budget.ts';
import { SecretStore } from '../workspace/secrets.ts';
import { TelegramSecrets } from './telegram-secrets.ts';
import { execFileSync } from 'node:child_process';
import { realpathSync, existsSync, mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WebhookScheduler } from './scheduler.ts';
import * as module from './service.ts';
import { EndpointRegistry } from './endpoints.ts';
import { AdmissionRepository } from './admission.ts';
import { WebhookHistory } from './history.ts';
import type { WebhookSend, SendResult } from './transport.ts';
const roots: string[] = [];
const services: module.WebhookService[] = [];
const stores: RunStore[] = [];
async function setup() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-service-')); roots.push(root); execFileSync('git', ['init', '-q'], { cwd: root });
  const dataDir = join(root, '.ai/cezar'); let now = Date.parse('2026-10-13T12:00:00Z');
  const send = vi.fn(async (_input: WebhookSend): Promise<SendResult> => ({ kind: 'http', status: 200 }));
  const options = { root, dataDir, projectId: 'project', mode: 'local' as const, serverPorts: () => [4317], scheduler: new WebhookScheduler(), now: () => now, send };
  return { root, dataDir, send, options, time: (value: number) => { now = value; } };
}
afterEach(async () => { clearSharedTelegramCooldowns(); for (const service of services.splice(0)) await service.dispose(); for (const store of stores.splice(0)) store.flush(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
describe('project webhook lifecycle service', () => {
  it.each(['transient', 'policy', 'rate_limited'] as const)('manual test is one-shot after %s and cannot recover Suspended later', async kind => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup(); const service = (await module.WebhookService.open(x.options))!; services.push(service);
    const { receiver } = await service.create({ name: 'Ops', url: 'https://example.com' }); await service.activate(receiver.id, 1);
    for (let i = 0; i < 10; i++) await service.endpoints.deliveryResult(receiver.id, 2, 1, 'transient', false);
    const current = service.list().receivers[0]!;
    await service.test(receiver.id, { expectedRevision: current.revision, deliveryRevision: 1, operationId: 'one-test' });
    x.send.mockResolvedValueOnce(kind === 'rate_limited' ? { kind: 'http', status: 429 } : { kind, reason: 'fixture' });
    await service.tick(); x.time(x.options.now() + 16 * 60000); await service.tick();
    expect(x.send).toHaveBeenCalledTimes(1); expect(service.list().receivers[0]!.state).toBe('suspended');
    expect(service.deliveries(receiver.id)[0]).toMatchObject({ status: 'failed', attempts: 1 });
    await service.test(receiver.id, { expectedRevision: service.list().receivers[0]!.revision, deliveryRevision: 1, operationId: 'explicit-recovery' });
    await service.tick(); expect(service.list().receivers[0]!.state).toBe('active');
  }, 20000);
  it.each([60000, 4 * 86400000])('terminates an interrupted manual claim as unknown after %i ms without resending', async delay => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup(); let service = (await module.WebhookService.open(x.options))!; services.push(service);
    const { receiver } = await service.create({ name: 'Ops', url: 'https://example.com' });
    await service.test(receiver.id, { expectedRevision: 1, deliveryRevision: 1, operationId: 'interrupted' });
    vi.spyOn(service as unknown as { complete(): Promise<void> }, 'complete').mockRejectedValueOnce(new Error('crash'));
    await expect(service.tick()).rejects.toThrow('crash'); await service.dispose();
    service = (await module.WebhookService.open(x.options))!; services.push(service);
    x.time(x.options.now() + delay); await service.tick();
    expect(x.send).toHaveBeenCalledTimes(1);
    expect(service.deliveries(receiver.id)[0]).toMatchObject({ status: 'failed', reason: 'outcome_unknown' });
  });
  it.each(['missing', 'corrupt', 'outbox'] as const)('safely resets %s identity integrity preserving inactive definitions', async fault => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup(); let service = (await module.WebhookService.open(x.options))!; services.push(service);
    const { receiver } = await service.create({ name: 'Ops', url: 'https://example.com' }); await service.activate(receiver.id, 1);
    const store = RunStore.open(x.dataDir); stores.push(store); service.attach(store, { isActive: () => false }, true);
    const old = store.createRun({ title: 'old', task: 'old', workflow: 'w', steps: [] }); store.updateRun(old.id, { status: 'done' });
    await service.dispose();
    const path = join(x.dataDir, 'webhooks', fault === 'outbox' ? 'outbox.ndjson' : 'identity.json');
    if (fault === 'missing') rmSync(path); else writeFileSync(path, '{broken');
    service = (await module.WebhookService.open(x.options))!; services.push(service); service.attach(store, { isActive: () => false }, true);
    expect(service.list().receivers[0]).toMatchObject({ id: receiver.id, state: 'inactive' });
    await service.tick(); expect(x.send).not.toHaveBeenCalled();
    await service.activate(receiver.id, service.list().receivers[0]!.revision);
    const fresh = store.createRun({ title: 'fresh', task: 'fresh', workflow: 'w', steps: [] }); store.updateRun(fresh.id, { status: 'done' });
    await service.tick(); expect(x.send).toHaveBeenCalledTimes(1);
    await service.dispose(); service = (await module.WebhookService.open(x.options))!; services.push(service);
    expect(service.list().receivers[0]!.state).toBe('active');
  });
  it('keeps masked notice identity after deletion', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup(); const service = (await module.WebhookService.open(x.options))!; services.push(service);
    const { receiver } = await service.create({ name: 'Ops', url: 'https://example.com/private?token=fixture' });
    await service.delete(receiver.id, 1);
    expect(service.list().notice).toMatchObject({ receiverId: receiver.id, receiverName: 'Ops', destination: 'https://example.com/…', source: 'cockpit/api' });
    expect(JSON.stringify(service.list().notice)).not.toContain('fixture');
  });
  it('expires a beyond-lifetime Retry-After before constructing its date', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup(); const service = (await module.WebhookService.open(x.options))!; services.push(service);
    const store = RunStore.open(x.dataDir); stores.push(store); service.attach(store, { isActive: () => false }, true);
    const { receiver } = await service.create({ name: 'Ops', url: 'https://example.com', graceSeconds: 0 }); await service.activate(receiver.id, 1);
    const run = store.createRun({ title: 'task', task: 'task', workflow: 'w', steps: [] }); store.updateRun(run.id, { status: 'done' });
    x.send.mockResolvedValueOnce({ kind: 'http', status: 429, retryAfter: '9'.repeat(100) });
    await service.tick(); expect(service.deliveries(receiver.id)[0]).toMatchObject({ status: 'failed', reason: 'expired' });
    expect(service.list().webhookHealth.status).toBe('ready');
  });
  it('projects payload retention separately from retry expiry and refreshes task availability', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup(); const service = (await module.WebhookService.open(x.options))!; services.push(service);
    const store = RunStore.open(x.dataDir); stores.push(store); service.attach(store, { isActive: () => false }, true);
    const { receiver } = await service.create({ name: 'Ops', url: 'https://example.com', graceSeconds: 0 }); await service.activate(receiver.id, 1);
    const run = store.createRun({ title: 'task', task: 'task', workflow: 'w', steps: [] }); store.updateRun(run.id, { status: 'done' }); await service.tick();
    const row = () => service.deliveryPage(receiver.id, { limit: 100 }).items[0]!;
    expect(row()).toMatchObject({ payloadAvailability: 'retained', taskAvailability: 'available', payloadRetainedUntil: '2026-10-20T12:00:00.000Z' });
    expect(row().payloadRetainedUntil).not.toBe(row().expiresAt);
    const health = vi.spyOn(store, 'getIndexReadHealth').mockReturnValue({ state: 'unavailable', omittedRuns: 0 });
    expect(row().taskAvailability).toBe('unknown'); health.mockRestore();
    store.deleteRun(run.id); expect(row().taskAvailability).toBe('deleted');
    expect(row().replayAllowed).toBe(true); // Terminal event bytes remain eligible without a live task link.
    x.time(x.options.now() + 8 * 86400000); await service.tick();
    expect(row()).toMatchObject({ payloadAvailability: 'expired', replayUnavailableReason: 'payload_expired', replayAllowed: false });
  });
  it('resumes an interrupted integrity reset and cancels pending bodies without changing bytes', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup(); let service = (await module.WebhookService.open(x.options))!; services.push(service);
    const { receiver } = await service.create({ name: 'Ops', url: 'https://example.com' }); await service.activate(receiver.id, 1);
    await service.test(receiver.id, { expectedRevision: 2, deliveryRevision: 1, operationId: 'queued' });
    const body = service.deliveries(receiver.id)[0]!.body;
    await service.dispose(); rmSync(join(x.dataDir, 'webhooks/identity.json'));
    const original = EndpointRegistry.prototype.resetIntegrity;
    const spy = vi.spyOn(EndpointRegistry.prototype, 'resetIntegrity').mockImplementationOnce(async function (this: EndpointRegistry) { await original.call(this); throw new Error('reset crash'); });
    await expect(module.WebhookService.open(x.options)).rejects.toThrow('reset crash'); spy.mockRestore();
    expect(JSON.parse(readFileSync(join(x.dataDir, 'webhooks/identity.json'), 'utf8')).resetPending).toBe(true);
    service = (await module.WebhookService.open(x.options))!; services.push(service);
    expect(service.deliveries(receiver.id)[0]).toMatchObject({ status: 'cancelled', reason: 'integrity_reset', body });
    await service.tick(); expect(x.send).not.toHaveBeenCalled();
  });
  it('does not overwrite corrupt receiver definitions while resetting missing identity', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup(); const service = (await module.WebhookService.open(x.options))!; services.push(service);
    await service.create({ name: 'Ops', url: 'https://example.com' }); await service.dispose();
    rmSync(join(x.dataDir, 'webhooks/identity.json')); writeFileSync(join(x.dataDir, 'webhooks/endpoints.json'), '{broken');
    await expect(module.WebhookService.open(x.options)).rejects.toThrow('Invalid webhook state: endpoints.json');
    expect(readFileSync(join(x.dataDir, 'webhooks/endpoints.json'), 'utf8')).toBe('{broken');
  });
  it('exposes retained saturation and task-filterable compact drops without source text', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup(); const service = (await module.WebhookService.open(x.options))!; services.push(service);
    const admissions = (service as unknown as { admissions: AdmissionRepository }).admissions;
    (admissions as unknown as { limits: { retainedBytes: number } }).limits.retainedBytes = 12000;
    const store = RunStore.open(x.dataDir); stores.push(store); service.attach(store, { isActive: () => false }, true);
    const { receiver } = await service.create({ name: 'Ops', url: 'https://example.com', graceSeconds: 0 }); await service.activate(receiver.id, 1);
    const run = store.createRun({ title: 'first', task: 'first', workflow: 'w', steps: [] }); store.updateRun(run.id, { status: 'done' }); await service.tick();
    const lost = store.createRun({ title: 'private title', task: 'private prompt', workflow: 'w', steps: [] }); store.updateRun(lost.id, { status: 'done' }); await service.tick();
    expect(service.list().webhookHealth).toMatchObject({ status: 'degraded', saturation: { retained: true, pending: false, dropped: 1 } });
    expect(service.deliveryPage(receiver.id, { limit: 100, taskId: lost.id }).items).toMatchObject([{ taskId: lost.id, reason: 'retained_capacity', payloadAvailability: 'not_created' }]);
  });
  it.each(['history', 'endpoint', 'after_endpoint'])('recovers persisted result effects after a crash at %s', async (boundary) => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup();
    let service = (await module.WebhookService.open(x.options))!; services.push(service);
    const store = RunStore.open(x.dataDir); stores.push(store); service.attach(store, { isActive: () => false }, true);
    const { receiver } = await service.create({ name: 'Ops', url: 'https://example.com', graceSeconds: 0 }); await service.activate(receiver.id, 1);
    x.send.mockResolvedValue({ kind: 'http', status: boundary === 'history' ? 200 : 410 });
    const run = store.createRun({ title: 'task', task: 'task', workflow: 'w', steps: [] }); store.updateRun(run.id, { status: 'done' });
    if (boundary === 'history') vi.spyOn(service as unknown as { recordHistory(): Promise<void> }, 'recordHistory').mockRejectedValueOnce(new Error('crash'));
    else {
      const original = service.endpoints.deliveryResult.bind(service.endpoints);
      vi.spyOn(service.endpoints, 'deliveryResult').mockImplementationOnce(async (...args) => { if (boundary === 'after_endpoint') await original(...args); throw new Error('crash'); });
    }
    await expect(service.tick()).rejects.toThrow('crash'); await service.dispose();
    service = (await module.WebhookService.open(x.options))!; services.push(service); service.attach(store, { isActive: () => false }, true);
    if (boundary !== 'history') expect(service.list().receivers[0]!.state).toBe('disabled');
    x.time(Date.parse('2026-10-21T12:00:00Z')); await service.tick();
    expect(service.deliveryPage(receiver.id, { limit: 100 }).items).toHaveLength(1);
    expect(x.send).toHaveBeenCalledTimes(1);
  });
  it.each([400, 429, 302])('waits another fifteen minutes after a failed suspended probe (%i)', async (status) => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup(); const service = (await module.WebhookService.open(x.options))!; services.push(service);
    const store = RunStore.open(x.dataDir); stores.push(store); service.attach(store, { isActive: () => false }, true);
    const { receiver } = await service.create({ name: 'Ops', url: 'https://example.com', graceSeconds: 0 }); await service.activate(receiver.id, 1);
    for (let i = 0; i < 10; i++) await service.endpoints.deliveryResult(receiver.id, 2, 1, 'transient', false);
    for (let i = 0; i < 2; i++) { const run = store.createRun({ title: 'task', task: 'task', workflow: 'w', steps: [] }); store.updateRun(run.id, { status: 'done' }); }
    x.send.mockResolvedValue({ kind: 'http', status }); x.time(Date.parse('2026-10-13T12:15:01Z'));
    await service.tick(); await service.tick(); expect(x.send).toHaveBeenCalledTimes(1);
    expect(service.list().receivers[0]!.nextProbeAt).toBe('2026-10-13T12:30:01.000Z');
  });
  it('records changed configuration field names without their private values', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup(); const service = (await module.WebhookService.open(x.options))!; services.push(service);
    const { receiver } = await service.create({ name: 'Ops', url: 'https://example.com/private' });
    const old = service.endpoints.privateReceiver(receiver.id)!;
    await service.update(receiver.id, { name: old.name, url: 'https://example.com/secret-path', profile: 'standard', preset: old.preset, events: old.events, scope: old.scope, graceSeconds: old.graceSeconds, allowLocalNetwork: old.allowLocalNetwork, includeScheduledFailures: old.includeScheduledFailures, expectedRevision: 1 });
    const row = service.activityPage(receiver.id).items.find(item => item.action === 'configuration_changed')!;
    expect(row.fields).toEqual(['url', 'profile']); expect(row.revision).toBe(2);
    expect(JSON.stringify(row)).not.toContain('secret-path');
  });
  it('does not rewrite completed history on every restart', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup();
    const service = (await module.WebhookService.open(x.options))!; services.push(service);
    const store = RunStore.open(x.dataDir); stores.push(store); service.attach(store, { isActive: () => false }, true);
    const { receiver } = await service.create({ name: 'Ops', url: 'https://example.com', graceSeconds: 0 }); await service.activate(receiver.id, 1);
    const run = store.createRun({ title: 'task', task: 'task', workflow: 'w', steps: [] }); store.updateRun(run.id, { status: 'done' });
    await service.tick(); await service.dispose();
    const spy = vi.spyOn(WebhookHistory.prototype, 'upsert');
    try { const reopened = (await module.WebhookService.open(x.options))!; services.push(reopened); expect(spy).not.toHaveBeenCalled(); }
    finally { spy.mockRestore(); }
  });
  it('does not create storage or a service unless the exact flag is enabled', async () => {
    const x = await setup(); vi.stubEnv('CEZ_WEBHOOKS', 'true');
    expect(await module.WebhookService.open(x.options)).toBeUndefined();
    expect(existsSync(x.dataDir)).toBe(false);
  });
  it('captures only post-activation transitions and sends signed-body input outside task mutation', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup(); const service = (await module.WebhookService.open(x.options))!; services.push(service);
    const store = RunStore.open(x.dataDir); stores.push(store); service.attach(store, { isActive: () => false }, true);
    const old = store.createRun({ title: 'earlier', task: 'private prompt', workflow: 'w', steps: [] }); store.updateRun(old.id, { status: 'done' });
    const receiver = await service.create({ name: 'Ops', url: 'https://example.com', graceSeconds: 0 }); await service.activate(receiver.receiver.id, 1);
    const run = store.createRun({ title: 'now', task: 'private prompt', workflow: 'w', steps: [] }); store.updateRun(run.id, { status: 'done', completionReason: 'completed' });
    expect(x.send).not.toHaveBeenCalled();
    await service.tick();
    expect(x.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(x.send.mock.calls[0]![0].body)).toMatchObject({ type: 'task.finished', task: { id: run.id }, data: { resolution: 'completed' } });
    expect(x.send.mock.calls[0]![0].body).not.toContain('private prompt');
    expect(service.deliveries(receiver.receiver.id)[0]!.status).toBe('delivered');
  });
  it('suppresses replied questions during grace and defers failures while active', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup(); const service = (await module.WebhookService.open(x.options))!; services.push(service);
    const store = RunStore.open(x.dataDir); stores.push(store); let active = false; service.attach(store, { isActive: () => active }, true);
    const receiver = await service.create({ name: 'Ops', url: 'https://example.com' }); await service.activate(receiver.receiver.id, 1);
    const run = store.createRun({ title: 'task', task: 'task', workflow: 'w', steps: [] });
    store.updateRun(run.id, { status: 'waiting' }); store.updateRun(run.id, { status: 'running' });
    await service.tick(); expect(service.deliveries(receiver.receiver.id)[0]!.status).toBe('superseded');
    active = true; store.updateRun(run.id, { status: 'failed' }); x.time(Date.parse('2026-10-13T12:01:00Z'));
    await service.tick(); expect(x.send).not.toHaveBeenCalled();
    active = false; await service.tick(); expect(x.send).toHaveBeenCalledTimes(1);
  });
  it('keeps failure disposition dedupe after restart and does not create a second manual alert', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup(); let service = (await module.WebhookService.open(x.options))!; services.push(service);
    const store = RunStore.open(x.dataDir); stores.push(store); service.attach(store, { isActive: () => false }, true);
    const receiver = await service.create({ name: 'Ops', url: 'https://example.com' }); await service.activate(receiver.receiver.id, 1);
    const run = store.createRun({ title: 'task', task: 'task', workflow: 'w', steps: [] }); store.updateRun(run.id, { status: 'failed' }); x.time(Date.parse('2026-10-13T12:01:00Z'));
    await service.tick(); await service.dispose(); services.pop();
    service = (await module.WebhookService.open(x.options))!; services.push(service); service.attach(store, { isActive: () => false }, true);
    store.updateRun(run.id, { autoResumeAt: '2026-10-13T12:02:00Z' }); store.updateRun(run.id, { autoResumeAt: undefined });
    x.time(Date.parse('2026-10-13T12:01:31Z')); await service.tick();
    expect(x.send).toHaveBeenCalledTimes(1);
  });
  it('retains current failure identity beyond payload and history retention', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup(); let service = (await module.WebhookService.open(x.options))!; services.push(service);
    const store = RunStore.open(x.dataDir); stores.push(store); service.attach(store, { isActive: () => false }, true);
    const receiver = await service.create({ name: 'Ops', url: 'https://example.com' }); await service.activate(receiver.receiver.id, 1);
    const run = store.createRun({ title: 'task', task: 'task', workflow: 'w', steps: [] }); store.updateRun(run.id, { status: 'failed' });
    x.time(Date.parse('2026-10-13T12:01:00Z')); await service.tick();
    x.time(Date.parse('2026-11-22T12:01:00Z')); await service.tick();
    expect(service.deliveries(receiver.receiver.id)).toHaveLength(0);
    await service.dispose(); services.pop();
    service = (await module.WebhookService.open(x.options))!; services.push(service); service.attach(store, { isActive: () => false }, true);
    store.updateRun(run.id, { autoResumeAt: '2026-11-22T12:02:00Z' }); store.updateRun(run.id, { autoResumeAt: undefined }); await service.tick();
    expect(x.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(join(x.dataDir, 'webhooks/failure-episodes.json'), 'utf8')).episodes[run.id]).toBeDefined();
  });
  it('keeps the newest failure episode when several transitions precede admission', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup(); const service = (await module.WebhookService.open(x.options))!; services.push(service);
    const store = RunStore.open(x.dataDir); stores.push(store); service.attach(store, { isActive: () => false }, true);
    const receiver = await service.create({ name: 'Ops', url: 'https://example.com' }); await service.activate(receiver.receiver.id, 1);
    const run = store.createRun({ title: 'task', task: 'task', workflow: 'w', steps: [] });
    store.updateRun(run.id, { status: 'failed' }); store.updateRun(run.id, { status: 'running' }); store.updateRun(run.id, { status: 'failed' });
    x.time(Date.parse('2026-10-13T12:01:00Z')); await service.tick(); await service.tick();
    expect(x.send).toHaveBeenCalledTimes(1);
    expect(service.deliveries(receiver.receiver.id).map(item => item.status)).toEqual(['superseded', 'delivered']);
  });
  it('does not resurrect an old waiting episode while draining the outbox', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup(); const service = (await module.WebhookService.open(x.options))!; services.push(service);
    const store = RunStore.open(x.dataDir); stores.push(store); service.attach(store, { isActive: () => false }, true);
    const receiver = await service.create({ name: 'Ops', url: 'https://example.com', graceSeconds: 0 }); await service.activate(receiver.receiver.id, 1);
    const run = store.createRun({ title: 'task', task: 'task', workflow: 'w', steps: [] });
    store.updateRun(run.id, { status: 'waiting' }); store.updateRun(run.id, { status: 'running' });
    await service.pause(receiver.receiver.id, 2);
    store.updateRun(run.id, { status: 'waiting' });
    await service.resume(receiver.receiver.id, 3); await service.tick();
    expect(x.send).not.toHaveBeenCalled();
  });

  it('tests inactive receivers once and exposes a read-only deleted history', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup(); const service = (await module.WebhookService.open(x.options))!; services.push(service);
    const receiver = await service.create({ name: 'Ops', url: 'https://example.com' });
    const input = { expectedRevision: 1, deliveryRevision: 1, operationId: 'same-click' };
    const first = await service.test(receiver.receiver.id, input);
    expect(await service.test(receiver.receiver.id, input)).toEqual(first);
    await service.tick(); expect(x.send).toHaveBeenCalledTimes(1);
    expect(service.list().receivers[0]!.state).toBe('inactive');
    await service.delete(receiver.receiver.id, service.list().receivers[0]!.revision);
    const page = service.deliveryPage(receiver.receiver.id, { limit: 100 });
    expect(page.receiver.kind).toBe('history'); expect(page.items).toHaveLength(1);
    expect(page.items[0]!.replayAllowed).toBe(false);
    expect(service.activityPage(receiver.receiver.id).items.some(row => row.action === 'test')).toBe(true);
  });
  it('replays retained terminal bytes once per operation with the same event ID', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup(); const service = (await module.WebhookService.open(x.options))!; services.push(service);
    const store = RunStore.open(x.dataDir); stores.push(store); service.attach(store, { isActive: () => false }, true);
    const receiver = await service.create({ name: 'Ops', url: 'https://example.com' }); await service.activate(receiver.receiver.id, 1);
    const run = store.createRun({ title: 'task', task: 'task', workflow: 'w', steps: [] }); store.updateRun(run.id, { status: 'done' }); await service.tick();
    const original = service.deliveries(receiver.receiver.id)[0]!;
    x.time(Date.parse('2026-10-14T12:00:00Z'));
    const input = { expectedRevision: service.list().receivers[0]!.revision, deliveryRevision: 1, operationId: 'replay-click' };
    const replay = await service.replay(original.id, input); expect(await service.replay(original.id, input)).toEqual(replay);
    await service.tick(); expect(x.send).toHaveBeenCalledTimes(2);
    expect(x.send.mock.calls[1]![0].body).toBe(x.send.mock.calls[0]![0].body);
    expect(x.send.mock.calls[1]![0].eventId).toBe(x.send.mock.calls[0]![0].eventId);
    expect(replay.deliveryId).not.toBe(original.id);
  });

  it('rejects a fourth queued test for the same host while an idempotent retry remains free', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup(); const service = (await module.WebhookService.open(x.options))!; services.push(service);
    const receiver = await service.create({ name: 'Ops', url: 'https://example.com' });
    const first = { expectedRevision: 1, deliveryRevision: 1, operationId: 'one' };
    const result = await service.test(receiver.receiver.id, first);
    await service.test(receiver.receiver.id, { ...first, expectedRevision: 2, operationId: 'two' });
    await service.test(receiver.receiver.id, { ...first, expectedRevision: 3, operationId: 'three' });
    await expect(service.test(receiver.receiver.id, { ...first, expectedRevision: 4, operationId: 'four' })).rejects.toMatchObject({ status: 429 });
    expect(await service.test(receiver.receiver.id, first)).toEqual(result);
  });

  it('retains hosted activation policy after restarting in local mode', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup(); let service = (await module.WebhookService.open({ ...x.options, mode: 'hosted' }))!; services.push(service);
    const receiver = await service.create({ name: 'Ops', url: 'https://example.com' }); await service.activate(receiver.receiver.id, 1);
    await service.dispose(); services.pop();
    service = (await module.WebhookService.open(x.options))!; services.push(service);
    const store = RunStore.open(x.dataDir); stores.push(store); service.attach(store, { isActive: () => false }, true);
    const run = store.createRun({ title: 'task', task: 'task', workflow: 'w', steps: [] }); store.updateRun(run.id, { status: 'done' }); await service.tick();
    expect(x.send.mock.calls[0]![0].policy.mode).toBe('hosted');
  });

  it('retires failure identities on archival and when a restarted owner sees a completed task', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup(); let service = (await module.WebhookService.open(x.options))!; services.push(service);
    const store = RunStore.open(x.dataDir); stores.push(store); service.attach(store, { isActive: () => false }, true);
    const receiver = await service.create({ name: 'Ops', url: 'https://example.com' }); await service.activate(receiver.receiver.id, 1);
    const run = store.createRun({ title: 'task', task: 'task', workflow: 'w', steps: [] }); store.updateRun(run.id, { status: 'failed' });
    x.time(Date.parse('2026-10-13T12:01:00Z')); await service.tick();
    const index = () => JSON.parse(readFileSync(join(x.dataDir, 'webhooks/failure-episodes.json'), 'utf8')).episodes;
    expect(index()[run.id]).toBeDefined();
    store.setArchived(run.id, true); await service.tick(); expect(index()[run.id]).toBeUndefined();
    store.setArchived(run.id, false); store.updateRun(run.id, { status: 'running' }); store.updateRun(run.id, { status: 'failed' });
    x.time(Date.parse('2026-10-13T12:02:00Z')); await service.tick(); expect(index()[run.id]).toBeDefined();
    await service.dispose(); services.pop(); store.updateRun(run.id, { status: 'done' });
    service = (await module.WebhookService.open(x.options))!; services.push(service); service.attach(store, { isActive: () => false }, true);
    await service.tick(); expect(index()[run.id]).toBeUndefined();
  });

  it('resets a copied project without using its inherited receivers, keys or live-owner lock', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const a = await setup(); const original = (await module.WebhookService.open(a.options))!; services.push(original);
    const created = await original.create({ name: 'Original', url: 'https://example.com' }); await original.activate(created.receiver.id, 1);
    const b = await setup(); cpSync(a.dataDir, b.dataDir, { recursive: true });
    const copy = (await module.WebhookService.open(b.options))!; services.push(copy);
    expect(copy.list().receivers).toHaveLength(0); expect(copy.list().webhookHealth.reason).toContain('copied');
    expect(original.list().receivers[0]!.state).toBe('active');
    await copy.tick(); expect(b.send).not.toHaveBeenCalled();
  });

});

describe('native chat delivery pipeline', () => {
  const slack = 'https://hooks.slack.com/services/T1/B1/test';
  const discord = `https://discord.com/api/webhooks/123456789012345678/${'x'.repeat(68)}`;
  it.each([['slack.v1', slack], ['discord.v1', discord]] as const)('renders test and task notifications for %s, retaining cezar JSON and retry snapshots', async (format, url) => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup();
    const service = (await module.WebhookService.open(x.options))!; services.push(service);
    const { receiver } = await service.create({ name: 'Team', format, url, preset: 'all', graceSeconds: 0 });
    await service.test(receiver.id, { expectedRevision: 1, deliveryRevision: 1, operationId: 'chat-test' });
    await service.tick();
    expect(x.send.mock.calls[0]![0]).toMatchObject({ format, secrets: [] });
    expect(x.send.mock.calls[0]![0].body).toContain('cezar is connected to this channel');
    expect(x.send.mock.calls[0]![0].body).toContain('Team');
    await service.activate(receiver.id, service.list().receivers[0]!.revision);
    const store = RunStore.open(x.dataDir); stores.push(store); service.attach(store, { isActive: () => false }, true);
    const run = store.createRun({ title: 'PRIVATE TITLE', task: 'PRIVATE PROMPT', workflow: 'w', steps: [] });
    store.updateRun(run.id, { status: 'done' });
    x.send.mockResolvedValueOnce({ kind: 'http', status: 429, retryAfter: '60' });
    await service.tick();
    const first = x.send.mock.calls.at(-1)![0];
    expect(first.body).toContain('Task finished');
    expect(first.body).not.toContain('PRIVATE');
    const admission = (await AdmissionRepository.open(join(x.dataDir, 'webhooks'), { now: x.options.now })).all().find(item => item.source?.snapshot.id === run.id)!;
    expect(admission.deliveries[0]).toMatchObject({ format, status: 'retrying' });
    expect(JSON.parse(admission.deliveries[0]!.body!).type).toBe('task.finished');
    x.time(x.options.now() + 61000); await service.tick();
    expect(x.send.mock.calls.at(-1)![0].body).toBe(first.body);
    expect(service.deliveryPage(receiver.id, { limit: 100 }).items.find(item => item.taskId === run.id)?.status).toBe('delivered');
    expect(JSON.stringify(service.deliveryPage(receiver.id, { limit: 100 }))).not.toContain(url);
  });
  it.each([[404, 10015, 'disabled'], [401, 50027, 'disabled'], [400, undefined, 'active'], [404, undefined, 'active']] as const)('maps Discord %i/%s to %s', async (status, providerCode, state) => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup();
    const service = (await module.WebhookService.open(x.options))!; services.push(service);
    const { receiver } = await service.create({ name: 'Discord', format: 'discord.v1', url: discord });
    const active = await service.activate(receiver.id, 1);
    await service.test(receiver.id, { expectedRevision: active.revision, deliveryRevision: 1, operationId: 'gone-test' });
    x.send.mockResolvedValueOnce({ kind: 'http', status, ...(providerCode ? { providerCode } : {}) });
    await service.tick();
    expect(service.list().receivers[0]).toMatchObject({ state, activationBlocked: true });
  });
});

it('settles corrupt chat payloads without publishing a claim or sending', async () => {
  vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup();
  let service = (await module.WebhookService.open(x.options))!; services.push(service);
  const { receiver } = await service.create({ name: 'Slack', format: 'slack.v1', url: 'https://hooks.slack.com/services/T1/B1/test' });
  await service.test(receiver.id, { expectedRevision: 1, deliveryRevision: 1, operationId: 'corrupt-chat' });
  await service.dispose();
  const admissions = await AdmissionRepository.open(join(x.dataDir, 'webhooks'), { now: x.options.now });
  const admission = admissions.all()[0]!;
  admission.deliveries[0]!.body = '{}';
  writeFileSync(join(x.dataDir, 'webhooks', 'events', `${admission.id}.json`), JSON.stringify(admission));
  service = (await module.WebhookService.open(x.options))!; services.push(service);
  await service.tick();
  expect(x.send).not.toHaveBeenCalled();
  expect(service.deliveries(receiver.id)[0]).toMatchObject({ status: 'failed', reason: 'payload_invalid', attempts: 0 });
  expect(service.deliveries(receiver.id)[0]!.claim).toBeUndefined();
});

describe('legacy invalid hostname isolation', () => {
  it.each([false, true])('drains healthy receivers across reopen (persisted admission: %s)', async pending => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup();
    let clock = x.options.now(); x.options.now = () => clock++;
    let service = (await module.WebhookService.open(x.options))!; services.push(service);
    const bad = await service.create({ name: 'bad', url: 'https://bad.example.com', preset: 'all' });
    await service.activate(bad.receiver.id, 1);
    const good = await service.create({ name: 'good', url: 'https://example.com', preset: 'all' });
    await service.activate(good.receiver.id, 1);
    if (pending) await service.test(bad.receiver.id, { expectedRevision: 2, deliveryRevision: 1, operationId: 'legacy' });
    await service.dispose();
    const path = join(x.dataDir, 'webhooks', 'endpoints.json');
    const registry = JSON.parse(readFileSync(path, 'utf8'));
    registry.receivers.find((r: { id: string }) => r.id === bad.receiver.id).url = 'https://' + Array(5).fill('a'.repeat(60)).join('.');
    writeFileSync(path, JSON.stringify(registry));
    const store = RunStore.open(x.dataDir); stores.push(store);
    for (let cycle = 0; cycle < 2; cycle++) {
      service = (await module.WebhookService.open(x.options))!; services.push(service);
      expect(service.list().receivers).toHaveLength(2);
      service.attach(store, { isActive: () => false }, true);
      const run = store.createRun({ title: 'task', task: 'task', workflow: 'w', steps: [] });
      store.updateRun(run.id, { status: 'done' });
      await expect(service.tick()).resolves.toBeUndefined();
      expect(service.needsRecovery).toBe(false);
      expect(service.deliveries(good.receiver.id).every(d => d.status === 'delivered')).toBe(true);
      expect(service.deliveries(bad.receiver.id).every(d => d.status === 'failed' && d.reason === 'invalid_destination_host')).toBe(true);
      expect(x.send).toHaveBeenCalledTimes(cycle + 1);
      await expect(service.test(bad.receiver.id, { expectedRevision: service.list().receivers.find(r => r.id === bad.receiver.id)!.revision, deliveryRevision: 1, operationId: 'invalid-' + cycle })).rejects.toThrow('Invalid destination host');
      expect(service.needsRecovery).toBe(false);
      await service.dispose();
    }
  });
});

describe('Telegram vault in the delivery pipeline', () => {
  const token = `123456789:${'T'.repeat(35)}`;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const input = { name: 'Telegram', format: 'telegram.v1' as const, url, telegramChatId: '42', graceSeconds: 0 as const };
  async function withVault() {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup();
    const vault = new SecretStore({ ...process.env, CEZ_HOME: join(x.root, 'vault-home') }, { keychain: async () => null });
    const scope = { kind: 'project' as const, projectId: 'project', root: x.root };
    const options = { ...x.options, telegramSecrets: new TelegramSecrets(scope, vault) };
    const open = async () => { const service = (await module.WebhookService.open(options))!; services.push(service); return service; };
    return { ...x, vault, scope, open };
  }
  it('sends using the vault after a restart and cancels queued tests on token rotation', async () => {
    const x = await withVault(); let service = await x.open();
    const { receiver } = await service.create(input);
    await service.dispose(); service = await x.open();
    await service.test(receiver.id, { expectedRevision: 1, deliveryRevision: 1, operationId: 'vault-test' });
    await service.tick();
    expect(x.send).toHaveBeenCalledWith(expect.objectContaining({ url, format: 'telegram.v1', diagnosticSecrets: expect.arrayContaining([token]) }));
    let current = service.list().receivers[0]!;
    expect(current.lastTest).toBe('success');
    await service.activate(current.id, current.revision);
    current = service.list().receivers[0]!;
    await service.test(current.id, { expectedRevision: current.revision, deliveryRevision: current.deliveryRevision, operationId: 'queued-before-rotation' });
    current = service.list().receivers[0]!;
    await service.update(current.id, { ...input, url: url.replaceAll('T', 'U'), expectedRevision: current.revision });
    await service.tick();
    expect(x.send).toHaveBeenCalledTimes(1);
    expect(service.deliveries(current.id).some(item => item.status === 'cancelled' && item.reason === 'receiver_changed')).toBe(true);
    expect(service.list().receivers[0]).toMatchObject({ state: 'inactive', lastTest: 'none', deliveryRevision: 2 });
    expect(readFileSync(join(x.dataDir, 'webhooks/endpoints.json'), 'utf8')).not.toContain(token);
  });
  it.each(['deleted', 'changed'] as const)('blocks %s vault tokens before network access, without blocking custom deliveries', async fault => {
    const x = await withVault(); const service = await x.open();
    const { receiver } = await service.create(input);
    await service.endpoints.testResult(receiver.id, 1, 1, 'success'); await service.activate(receiver.id, 1);
    const current = service.list().receivers[0]!;
    await service.test(receiver.id, { expectedRevision: current.revision, deliveryRevision: 1, operationId: 'missing-token' });
    const ref = service.endpoints.privateReceiver(receiver.id)!.telegramSecret!;
    if (fault === 'deleted') await x.vault.unset(x.scope, ref.name);
    else await x.vault.set(x.scope, ref.name, token.replaceAll('T', 'U'), ['cezar']);
    await service.tick();
    expect(x.send).not.toHaveBeenCalled();
    expect(service.deliveries(receiver.id)[0]).toMatchObject({ status: 'failed', reason: 'telegram_token_unavailable', attempts: 0 });
    expect(service.list().receivers[0]).toMatchObject({ state: 'disabled', lastTest: 'none' });
    expect(service.list().webhookHealth.status).toBe('degraded');
    const other = (await service.create({ name: 'Custom', url: 'https://example.com' })).receiver;
    await service.test(other.id, { expectedRevision: 1, deliveryRevision: 1, operationId: 'other-token' });
    await service.tick();
    expect(x.send).toHaveBeenCalledTimes(1);
    expect(x.send).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://example.com' }));
  });
  it.each(['rejected', 'skipped'] as const)('backs off a %s vault read without disabling the receiver', async fault => {
    const x = await withVault(); const service = await x.open();
    const store = RunStore.open(x.dataDir); stores.push(store); service.attach(store, { isActive: () => false }, true);
    const { receiver } = await service.create({ ...input, preset: 'all' });
    await service.endpoints.testResult(receiver.id, 1, 1, 'success'); await service.activate(receiver.id, 1);
    const run = store.createRun({ title: 'task', task: 'task', workflow: 'w', steps: [] }); store.updateRun(run.id, { status: 'done' });
    const read = fault === 'rejected' ? vi.spyOn(x.vault, 'read').mockRejectedValue(new Error('keychain locked'))
      : vi.spyOn(x.vault, 'read').mockResolvedValue({ values: {}, skipped: 'the data key is gone' });
    await service.tick();
    expect(x.send).not.toHaveBeenCalled();
    expect(service.list().receivers[0]).toMatchObject({ state: 'active' });
    expect(service.deliveries(receiver.id)[0]).toMatchObject({ attempts: 0 });
    expect(service.deliveries(receiver.id)[0]!.status).not.toBe('failed');
    read.mockRestore(); x.time(x.options.now() + 61_000); await service.tick();
    expect(x.send).toHaveBeenCalledTimes(1);
  });
  it('counts queued Telegram tests by host without parsing the chat display label as a URL', async () => {
    const x = await withVault(); const service = await x.open();
    const { receiver } = await service.create(input);
    for (let index = 0; index < 3; index++) {
      const current = service.list().receivers[0]!;
      await service.test(receiver.id, { expectedRevision: current.revision, deliveryRevision: 1, operationId: `queued-${index}` });
    }
    const current = service.list().receivers[0]!;
    await expect(service.test(receiver.id, { expectedRevision: current.revision, deliveryRevision: 1, operationId: 'too-many' })).rejects.toMatchObject({ status: 429 });
  });
});

it('opening webhook storage and starting outbound never starts inbound or recovers a project', async () => {
  vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '1');
  const x = await setup();
  const call = vi.fn(async () => { throw new Error('unexpected network'); });
  const service = (await module.WebhookService.open({ ...x.options, telegramCall: () => call }))!; services.push(service);
  expect(service.telegram.list().available).toBe(true);
  const start = vi.spyOn(service.telegram, 'start');
  service.start(); await service.tick();
  expect(start).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled();
  await service.startTelegram(); expect(start).toHaveBeenCalledTimes(1);
});

describe('shared Telegram delivery budget', () => {
  async function fixture() {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup();
    const vault = new SecretStore({ ...process.env, CEZ_HOME: join(x.root, 'vault-home') }, { keychain: async () => null });
    const options = { ...x.options, telegramSecrets: new TelegramSecrets({ kind: 'project', projectId: 'project', root: x.root }, vault) };
    const service = (await module.WebhookService.open(options))!;
    services.push(service);
    const budget = new TelegramSendBudget(x.options.now);
    vi.spyOn(service.telegram, 'sendBudget').mockImplementation(receiver => receiver.format === 'telegram.v1' ? budget : undefined);
    const add = async (chat: string) => {
      const { receiver } = await service.create({ name: `Chat ${chat}`, format: 'telegram.v1', url: `https://api.telegram.org/bot123456789:${'T'.repeat(35)}/sendMessage`, telegramChatId: chat, graceSeconds: 0, preset: 'all' });
      await service.endpoints.deliveryResult(receiver.id, receiver.revision, receiver.deliveryRevision, 'success', true);
      await service.activate(receiver.id, service.list().receivers.find(row => row.id === receiver.id)!.revision); return receiver;
    };
    const store = RunStore.open(x.dataDir); stores.push(store); service.attach(store, { isActive: () => false }, true);
    const event = () => { const run = store.createRun({ title: 'task', task: 'task', workflow: 'w', steps: [] }); store.updateRun(run.id, { status: 'done' }); };
    /** A recovered service: a fresh budget object for the same bot. */
    const reopen = async () => {
      await service.dispose(); const next = (await module.WebhookService.open(options))!; services.push(next);
      const fresh = new TelegramSendBudget(x.options.now);
      vi.spyOn(next.telegram, 'sendBudget').mockImplementation(receiver => receiver.format === 'telegram.v1' ? fresh : undefined);
      next.attach(store, { isActive: () => false }, true); return next;
    };
    return { ...x, service, budget, add, event, reopen, store };
  }
  type Internals = { telegramTickets: Map<string, TelegramSendBudget>; telegramWakeTimer?: unknown; scheduleTelegramWake(): void };
  it('marks the service broken instead of leaking an unhandled rejection from a wake tick', async () => {
    const x = await fixture(); const internals = x.service as unknown as Internals;
    internals.telegramTickets.set('ticket', x.budget);
    vi.spyOn(x.service, 'tick').mockRejectedValue(new Error('wake failed'));
    internals.scheduleTelegramWake();
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(x.service.needsRecovery).toBe(true);
  });
  it('wakes on reservation release instead of polling while a send is in flight', async () => {
    const x = await fixture(); const internals = x.service as unknown as Internals;
    x.budget.offer({ id: 'other', chat: 'z', readyAt: 0, expiresAt: x.options.now() + 60_000, valid: () => true });
    const reservation = x.budget.reserve('other')!;
    internals.telegramTickets.set('ticket', x.budget); internals.scheduleTelegramWake();
    expect(internals.telegramWakeTimer).toBeUndefined();
    reservation.release(); expect(internals.telegramWakeTimer).toBeDefined();
  });
  it('schedules a budget wake when the reservation is refused after choosing', async () => {
    const x = await fixture(); await x.add('1'); x.event();
    vi.spyOn(x.budget, 'reserve').mockReturnValueOnce(undefined);
    await x.service.tick();
    expect(x.send).not.toHaveBeenCalled();
    expect((x.service as unknown as Internals).telegramWakeTimer).toBeDefined();
  });
  // Guard: one ticket offer serves the scan and the post-send re-offer; a retry waits for the probe its send scheduled.
  it('re-offers a retry behind the probe of the receiver its send just suspended', async () => {
    const x = await fixture(); const receiver = await x.add('1');
    for (let i = 0; i < 9; i++) await x.service.endpoints.deliveryResult(receiver.id, 2, 1, 'transient', false);
    x.event(); x.send.mockResolvedValueOnce({ kind: 'http', status: 500 });
    await x.service.tick(); expect(x.send).toHaveBeenCalledTimes(1);
    const view = x.service.list().receivers[0]!, retry = x.service.deliveries(receiver.id).find(row => row.status === 'retrying')!;
    expect(view.state).toBe('suspended');
    expect(Date.parse(retry.nextAttemptAt!)).toBeLessThan(Date.parse(view.nextProbeAt!));
    x.time(Date.parse(retry.nextAttemptAt!) + 1);
    expect(x.budget.winner()).toBeUndefined();
  });
  it('lets a younger due delivery pass a fresh head that is still waiting in the same chat', async () => {
    const x = await fixture(); const waiting = await x.add('1');
    for (let i = 0; i < 10; i++) await x.service.endpoints.deliveryResult(waiting.id, 2, 1, 'transient', false);
    expect(x.service.list().receivers[0]!.state).toBe('suspended');
    x.event(); await x.service.tick(); expect(x.send).not.toHaveBeenCalled();
    x.time(x.options.now() + 1000); const ready = await x.add('1'); x.event();
    await x.service.tick();
    expect(x.send).toHaveBeenCalledTimes(1);
    expect(x.service.deliveries(ready.id).some(row => row.status === 'delivered')).toBe(true);
    expect(x.service.deliveries(waiting.id).every(row => row.attempts === 0)).toBe(true);
  });
  it('resolves the Telegram budget once per receiver per selection pass', async () => {
    const x = await fixture(); await x.add('1');
    for (let i = 0; i < 30; i++) x.event();
    x.budget.cooldown(x.options.now() + 10_000);
    await x.service.tick();
    const resolve = vi.mocked(x.service.telegram.sendBudget); resolve.mockClear();
    await x.service.tick();
    expect(x.send).not.toHaveBeenCalled();
    expect(resolve.mock.calls.length).toBeLessThan(10);
  });
  it('keeps a bot 429 cooldown across a recovered service', async () => {
    const x = await fixture(); await x.add('1'); x.event();
    x.send.mockResolvedValueOnce({ kind: 'http', status: 429, retryAfter: '60' });
    await x.service.tick(); expect(x.send).toHaveBeenCalledTimes(1);
    const service = await x.reopen();
    const { receiver } = await service.create({ name: 'Chat 2', format: 'telegram.v1', url: `https://api.telegram.org/bot123456789:${'T'.repeat(35)}/sendMessage`, telegramChatId: '2', graceSeconds: 0, preset: 'all' });
    await service.endpoints.deliveryResult(receiver.id, receiver.revision, receiver.deliveryRevision, 'success', true);
    await service.activate(receiver.id, service.list().receivers.find(row => row.id === receiver.id)!.revision);
    x.event(); x.time(x.options.now() + 1000); await service.tick();
    expect(x.send).toHaveBeenCalledTimes(1);
    // Chat 1's retry may take the first slot after the cooldown; chat 2 follows after bot spacing.
    x.time(x.options.now() + 60_000); await service.tick(); x.time(x.options.now() + 200); await service.tick();
    expect(x.send.mock.calls.slice(1).some(([request]) => JSON.parse(request.body).chat_id === '2')).toBe(true);
  });
  it('rotates all ready chats and does not claim or occupy scheduler capacity during cooldown', async () => {
    const x = await fixture(); const a = await x.add('1'); x.event(); x.event();
    await x.add('2'); await x.add('3'); x.event();
    const acquire = vi.spyOn(x.options.scheduler, 'acquire');
    await x.service.tick(); expect(x.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(x.send.mock.calls[0]![0].body).chat_id).toBe('1');
    const count = acquire.mock.calls.length;
    await x.service.tick(); expect(acquire).toHaveBeenCalledTimes(count);
    expect(x.service.deliveries(a.id).filter(row => row.status !== 'delivered').every(row => row.attempts === 0)).toBe(true);
    x.time(x.options.now() + 2000); await x.service.tick();
    expect(['2', '3']).toContain(JSON.parse(x.send.mock.calls[1]![0].body).chat_id);
    x.time(x.options.now() + 2000); await x.service.tick();
    expect(new Set(x.send.mock.calls.slice(1).map(([request]) => JSON.parse(request.body).chat_id))).toEqual(new Set(['2', '3']));
  });
  it('does not stall replies while an unrelated older webhook send is in flight', async () => {
    const x = await fixture();
    const { receiver: json } = await x.service.create({ name: 'Ops', url: 'https://example.com', graceSeconds: 0, preset: 'all' });
    await x.service.endpoints.deliveryResult(json.id, json.revision, json.deliveryRevision, 'success', true);
    await x.service.activate(json.id, x.service.list().receivers.find(row => row.id === json.id)!.revision);
    x.event(); x.time(x.options.now() + 1000); await x.add('1'); x.event();
    let finish!: (result: SendResult) => void;
    x.send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const tick = x.service.tick();
    await vi.waitFor(() => expect(x.send).toHaveBeenCalledTimes(1));
    expect(x.send.mock.calls[0]![0].url).toBe('https://example.com');
    x.budget.offer({ id: 'reply', chat: '9', readyAt: 0, expiresAt: x.options.now() + 60_000, valid: () => true });
    expect(x.budget.take('reply')).toBe(true);
    finish({ kind: 'http', status: 200 }); await tick;
    x.time(x.options.now() + 200); await x.service.tick();
    expect(x.send.mock.calls.map(([request]) => request.url).filter(url => url.includes('api.telegram.org'))).toHaveLength(1);
  });
  it('does not stall replies while a ready webhook waits for scheduler capacity', async () => {
    const x = await fixture(); const receiver = await x.add('1'); x.event();
    const other = (await x.options.scheduler.acquire('other-project', 'api.telegram.org'))!;
    const tick = x.service.tick();
    await vi.waitFor(() => expect((x.service as unknown as { inFlight: boolean }).inFlight).toBe(true));
    x.budget.offer({ id: 'reply', chat: '9', readyAt: 0, expiresAt: x.options.now() + 60_000, valid: () => true });
    expect(x.budget.take('reply')).toBe(true);
    other(); await tick;
    expect(x.send).not.toHaveBeenCalled();
    x.time(x.options.now() + 200); await x.service.tick();
    expect(x.send).toHaveBeenCalledTimes(1);
    expect(x.service.deliveries(receiver.id).some(row => row.status === 'delivered')).toBe(true);
  });
  it('advertises only chat heads so a backlog larger than the ticket cap cannot starve replies or other chats', async () => {
    const x = await fixture(); await x.add('1');
    for (let i = 0; i < 205; i++) x.event();
    await x.add('2'); x.event();
    x.budget.cooldown(x.options.now() + 10_000);
    // Admission drains at most 100 source events per pass.
    for (let i = 0; i < 3; i++) await x.service.tick();
    expect(x.send).not.toHaveBeenCalled();
    expect(x.budget.offer({ id: 'reply', chat: '3', readyAt: 0, expiresAt: x.options.now() + 60_000, valid: () => true })).toBe(true);
    x.time(x.options.now() + 10_000); await x.service.tick();
    x.time(x.options.now() + 1000); await x.service.tick();
    expect(x.send.mock.calls.map(([request]) => JSON.parse(request.body).chat_id)).toEqual(['1', '2']);
    x.time(x.options.now() + 100); expect(x.budget.take('reply')).toBe(true);
  }, 20_000);
  it('keeps an unsent chat head during retry backoff and cancels waiting work without attempts', async () => {
    const x = await fixture(); const receiver = await x.add('1'); x.event(); x.event();
    x.send.mockResolvedValueOnce({ kind: 'http', status: 500 });
    await x.service.tick(); expect(x.send).toHaveBeenCalledTimes(1);
    x.time(x.options.now() + 1000); await x.service.tick(); expect(x.send).toHaveBeenCalledTimes(1);
    x.time(x.options.now() + 6000); await x.service.tick(); expect(x.send).toHaveBeenCalledTimes(2);
    expect(x.send.mock.calls[0]![0].eventId).toBe(x.send.mock.calls[1]![0].eventId);
    await x.service.pause(receiver.id, x.service.list().receivers[0]!.revision);
    x.time(x.options.now() + 1000); await x.service.tick(); expect(x.send).toHaveBeenCalledTimes(2);
    expect(x.service.deliveries(receiver.id).find(row => row.status === 'cancelled')).toMatchObject({ attempts: 0 });
  });
  it('shares webhook 429 with replies and lets unrelated JSON deliver while Telegram waits', async () => {
    const x = await fixture(); await x.add('1');
    const { receiver } = await x.service.create({ name: 'JSON', url: 'https://example.com', graceSeconds: 0, preset: 'all' });
    await x.service.activate(receiver.id, receiver.revision);
    x.event(); x.send.mockImplementation(async request => request.format === 'telegram.v1' ? { kind: 'http', status: 429, retryAfter: '60' } : { kind: 'http', status: 200 });
    await x.service.tick(); expect(x.send).toHaveBeenCalledTimes(2);
    x.budget.offer({ id: 'reply', chat: '2', readyAt: 0, expiresAt: x.options.now() + 120_000, valid: () => true });
    x.time(x.options.now() + 1000); expect(x.budget.take('reply')).toBe(false);
    x.send.mockResolvedValue({ kind: 'http', status: 200 });
    x.time(x.options.now() + 60_000); await x.service.tick();
    x.time(x.options.now() + 100); expect(x.budget.take('reply')).toBe(true);
  });
});
