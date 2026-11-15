import { execFileSync } from 'node:child_process';
import { realpathSync, mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WebhookService } from './service.ts';
import { WebhookScheduler } from './scheduler.ts';
import type { SendResult, WebhookSend } from './transport.ts';
const uuidQueue = vi.hoisted(() => [] as string[]);
vi.mock('node:crypto', async original => {
  const real = await original<typeof import('node:crypto')>();
  return { ...real, randomUUID: () => uuidQueue.shift() ?? real.randomUUID() };
});
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
  uuidQueue.length = 0; vi.restoreAllMocks(); vi.unstubAllEnvs();
});
async function fixture() {
  vi.stubEnv('CEZ_WEBHOOKS', '1');
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-delivery-audit-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  let now = Date.parse('2026-10-15T12:00:00Z'); const dataDir = join(root, '.ai/cezar');
  const send = vi.fn(async (_: WebhookSend): Promise<SendResult> => ({ kind: 'http', status: 200 }));
  const options = { root, dataDir, projectId: 'test', mode: 'local' as const, serverPorts: () => [], scheduler: new WebhookScheduler(), now: () => now, send };
  const open = async () => { const service = (await WebhookService.open(options))!; cleanup.push(() => service.dispose()); return service; };
  const store = RunStore.open(dataDir); cleanup.push(() => store.flush());
  const service = await open(); service.attach(store, { isActive: () => false }, true);
  const { receiver } = await service.create({ name: 'Before', url: 'https://example.invalid/hook', graceSeconds: 0, preset: 'all', profile: 'standard' });
  await service.activate(receiver.id, 1);
  const capture = (status: 'done' | 'failed' = 'done', autoResumeAt?: string, eventUuid?: string, error?: string) => {
    const run = store.createRun({ title: 'Fixture', task: 'Fixture', workflow: 'w', steps: [] });
    if (eventUuid) uuidQueue.push(eventUuid);
    store.updateRun(run.id, { status, ...(autoResumeAt ? { autoResumeAt } : {}), ...(error ? { error } : {}) });
    return run.id;
  };
  const hold = () => {
    let release!: (result: SendResult) => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    send.mockImplementationOnce(async () => { entered(); return new Promise(resolve => { release = resolve; }); });
    return { started, release: (result: SendResult) => release(result) };
  };
  return { service, store, receiver, send, options, open, capture, hold, directory: join(dataDir, 'webhooks'), advance: (ms: number) => { now += ms; } };
}
it('D2: rename during HTTP 410 still disables the receiver and cancels queued work', async () => {
  const x = await fixture(); x.capture(); x.capture(); const held = x.hold();
  const flight = x.service.tick(); await held.started;
  for (const name of ['Renamed', 'Renamed again']) {
    await x.service.update(x.receiver.id, { events: [], includeScheduledFailures: false, scope: 'main_and_questions', allowLocalNetwork: false, name, preset: 'all', profile: 'standard', graceSeconds: 0, expectedRevision: x.service.list().receivers[0]!.revision });
  }
  held.release({ kind: 'http', status: 410 }); await flight; await x.service.tick();
  expect(x.service.list().receivers[0]!.state).toBe('disabled');
  expect(x.send).toHaveBeenCalledTimes(1);
  expect(x.service.deliveries(x.receiver.id).map(item => item.status).sort()).toEqual(['cancelled', 'failed']);
});
it.each(['pause', 'configuration', 'graceful', 'revoke_now'] as const)('D2 guard: rename does not erase the %s stale-result fence', async change => {
  const x = await fixture(); x.capture(); const held = x.hold();
  const flight = x.service.tick(); await held.started;
  if (change === 'pause') {
    await x.service.pause(x.receiver.id, 2); await x.service.resume(x.receiver.id, 3);
  } else if (change === 'configuration') {
    await x.service.update(x.receiver.id, { events: [], includeScheduledFailures: false, scope: 'main_and_questions', allowLocalNetwork: false, name: 'Config', preset: 'all', profile: 'standard', graceSeconds: 60, expectedRevision: 2 });
    await x.service.activate(x.receiver.id, 3);
  } else await x.service.rotate(x.receiver.id, 2, change);
  await x.service.update(x.receiver.id, { events: [], includeScheduledFailures: false, scope: 'main_and_questions', allowLocalNetwork: false, name: 'Renamed', preset: 'all', profile: 'standard', graceSeconds: change === 'configuration' ? 60 : 0, expectedRevision: x.service.list().receivers[0]!.revision });
  held.release({ kind: 'http', status: 410 }); await flight;
  expect(x.service.list().receivers[0]!.state).toBe('active');
});
it.each([false, true])('D1: pause cancels the old claim durably, resume before completion=%s', async resumeFirst => {
  const x = await fixture(); x.capture(); const held = x.hold();
  const flight = x.service.tick(); await held.started;
  await x.service.pause(x.receiver.id, 2);
  expect(x.send.mock.calls[0]![0].signal?.aborted).toBe(true);
  if (resumeFirst) await x.service.resume(x.receiver.id, 3);
  held.release({ kind: 'transient', reason: 'aborted' }); await flight;
  if (!resumeFirst) await x.service.resume(x.receiver.id, 3);
  x.advance(20000); await x.service.tick();
  expect(x.service.deliveries(x.receiver.id)[0]!.status).toBe('cancelled');
  expect(x.send).toHaveBeenCalledTimes(1);
  await x.service.dispose(); const restarted = await x.open(); restarted.attach(x.store, { isActive: () => false }, true);
  await restarted.tick(); expect(x.send).toHaveBeenCalledTimes(1);
  x.capture(); await restarted.tick(); expect(x.send).toHaveBeenCalledTimes(2);
});
it('D4: restart probes the oldest eligible suspended event, independent of filename order', async () => {
  const x = await fixture();
  for (let n = 0; n < 12; n++) x.capture('done', undefined, `00000000-0000-4000-8000-${String(100 - n).padStart(12, '0')}`);
  for (let n = 0; n < 10; n++) await x.service.endpoints.deliveryResult(x.receiver.id, 2, 1, 'transient', false);
  await x.service.tick(); expect(x.send).not.toHaveBeenCalled();
  await x.service.dispose(); x.advance(16 * 60000);
  const restarted = await x.open(); await restarted.tick();
  expect(JSON.parse(x.send.mock.calls[0]![0].body).sequence).toBe(1);
}, 15000);
it.each(['intact', 'missing', 'corrupt'] as const)('D3: failure identity %s after retention is diagnosed without inventing an event', async fault => {
  const x = await fixture(); x.service.attach(x.store, { isActive: () => false, hasScheduledAutoResume: () => true }, true);
  const task = x.capture('failed', new Date(x.options.now() + 86400000).toISOString());
  x.advance(31000); await x.service.tick();
  expect(JSON.parse(x.send.mock.calls[0]![0].body).data.disposition).toBe('scheduled');
  x.advance(40 * 86400000); await x.service.tick();
  expect(readdirSync(join(x.directory, 'events'))).toHaveLength(0);
  await x.service.dispose();
  const path = join(x.directory, 'failure-episodes.json');
  if (fault === 'missing') rmSync(path); else if (fault === 'corrupt') writeFileSync(path, '{broken');
  let restarted = await x.open(); restarted.attach(x.store, { isActive: () => false }, true);
  const calls = x.send.mock.calls.length; x.store.updateRun(task, { autoResumeAt: undefined });
  x.advance(31000); await restarted.tick();
  expect(x.send).toHaveBeenCalledTimes(calls + (fault === 'intact' ? 1 : 0));
  expect(restarted.list().webhookHealth.status).toBe(fault === 'intact' ? 'ready' : 'degraded');
  if (fault !== 'intact') expect(restarted.list().webhookHealth.reason).toMatch(/failure.*identity/i);
  await restarted.dispose(); restarted = await x.open();
  expect(restarted.list().webhookHealth.status).toBe(fault === 'intact' ? 'ready' : 'degraded');
});
it('D3: a lost index rebuilds an episode and disposition dedupe only from retained evidence', async () => {
  const x = await fixture(); x.service.attach(x.store, { isActive: () => false, hasScheduledAutoResume: () => true }, true);
  const task = x.capture('failed', new Date(x.options.now() + 86400000).toISOString());
  x.advance(31000); await x.service.tick();
  const episodeId = JSON.parse(x.send.mock.calls[0]![0].body).data.episodeId;
  await x.service.dispose(); rmSync(join(x.directory, 'failure-episodes.json'));
  const restarted = await x.open(); restarted.attach(x.store, { isActive: () => false }, true);
  x.store.updateRun(task, { autoResumeAt: undefined }); x.advance(31000); await restarted.tick();
  expect(x.send).toHaveBeenCalledTimes(2);
  expect(JSON.parse(x.send.mock.calls[1]![0].body).data).toMatchObject({ episodeId, disposition: 'manual' });
  const index = JSON.parse(readFileSync(join(x.directory, 'failure-episodes.json'), 'utf8'));
  expect(index.episodes[task].decisions[x.receiver.id].scheduled).toBeDefined();
  expect(index.episodes[task].decisions[x.receiver.id].manual).toBeDefined();
});
it('S2: delayed failure rendering redacts receivers added after capture', async () => {
  const x = await fixture(); const url = 'https://second.invalid/confidential-hook?token=hidden-credential';
  x.capture('failed', undefined, undefined, `Destination ${url} failed`);
  await x.service.tick(); expect(x.send).not.toHaveBeenCalled();
  await x.service.create({ name: 'Second', url });
  x.advance(31000); await x.service.tick();
  expect(x.send).toHaveBeenCalledTimes(1);
  const body = x.send.mock.calls[0]![0].body;
  expect(body).not.toContain(url); expect(body).not.toContain('hidden-credential');
  expect(JSON.parse(body).data.message).toContain('[REDACTED]');
});
it('D1: a crash after the pause write cannot revive an old claim after restart and resume', async () => {
  const x = await fixture(); x.capture();
  // Persist a real attempt, then simulate process loss before completion publication.
  vi.spyOn(x.service as unknown as { complete(): Promise<void> }, 'complete').mockRejectedValueOnce(new Error('crash'));
  await expect(x.service.tick()).rejects.toThrow('crash');
  // The endpoint write is durable, but the process stops before cancelUnsent runs.
  await x.service.endpoints.pause(x.receiver.id, 2); await x.service.dispose();
  const restarted = await x.open(); restarted.attach(x.store, { isActive: () => false }, true);
  await restarted.resume(x.receiver.id, 3); x.advance(20000); await restarted.tick();
  expect(x.send).toHaveBeenCalledTimes(1);
  expect(restarted.deliveries(x.receiver.id)[0]!.status).toBe('cancelled');
});
it('D1 guard: explicit replay after resume remains available without automatic backlog', async () => {
  const x = await fixture(); x.capture(); await x.service.tick();
  const delivered = x.service.deliveries(x.receiver.id)[0]!;
  await x.service.pause(x.receiver.id, 2); await x.service.resume(x.receiver.id, 3);
  await x.service.replay(delivered.id, { expectedRevision: 4, deliveryRevision: 1, operationId: 'explicit-after-resume' });
  await x.service.tick();
  expect(x.send).toHaveBeenCalledTimes(2);
  expect(x.send.mock.calls[1]![0].body).toBe(x.send.mock.calls[0]![0].body);
});
it('D2: rename result fence survives process restart before result recovery', async () => {
  const x = await fixture(); x.capture(); const held = x.hold();
  const flight = x.service.tick(); await held.started;
  await x.service.update(x.receiver.id, { name: 'Renamed', profile: 'standard', preset: 'all', events: [], includeScheduledFailures: false,
    scope: 'main_and_questions', graceSeconds: 0, allowLocalNetwork: false, expectedRevision: 2 });
  vi.spyOn(x.service.endpoints, 'deliveryResult').mockRejectedValueOnce(new Error('crash before endpoint effect'));
  held.release({ kind: 'http', status: 410 }); await expect(flight).rejects.toThrow('crash before endpoint effect');
  await x.service.dispose(); const restarted = await x.open();
  expect(restarted.list().receivers[0]!.state).toBe('disabled');
  expect(x.send).toHaveBeenCalledTimes(1);
});

it.each(['known-before-capture', 'late-short', 'late-crossing-boundary'])('integration URL privacy: %s', async variant => {
  const x = await fixture();
  const url = 'https://second.invalid/private-capability-' + 'a'.repeat(90);
  if (variant === 'known-before-capture') await x.service.create({ name: 'Second', url });
  x.capture('failed', undefined, undefined, 'x'.repeat(variant === 'late-short' ? 20 : 3930) + ' ' + url);
  await x.service.tick(); expect(x.send).not.toHaveBeenCalled();
  if (variant !== 'known-before-capture') await x.service.create({ name: 'Second', url });
  x.advance(31000); await x.service.tick();
  expect(x.send).toHaveBeenCalledTimes(1);
  const message = JSON.parse(x.send.mock.calls[0]![0].body).data.message as string;
  expect(message).not.toContain('private-capability-');
});

it.each(["'", '"', '<', '>', '`'].flatMap(mark => [20, 3930].map(prefix => ({ mark, prefix }))))(
  'S2: preserve accepted URL punctuation until redaction ($mark, prefix $prefix)', async ({ mark, prefix }) => {
    const x = await fixture();
    const url = 'https://second.invalid/private-capability' + mark + '/' + 'a'.repeat(150);
    x.capture('failed', undefined, undefined, 'x'.repeat(prefix) + ' ' + url);
    await x.service.tick(); expect(x.send).not.toHaveBeenCalled();
    await x.service.create({ name: 'Second', url });
    x.advance(31000); await x.service.tick();
    expect(x.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(x.send.mock.calls[0]![0].body).data.message).not.toContain('private-capability');
  },
);
