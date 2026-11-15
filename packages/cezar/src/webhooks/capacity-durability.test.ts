import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { AdmissionRepository } from './admission.ts';
import { WebhookScheduler } from './scheduler.ts';
import { WebhookService } from './service.ts';
import type { SendResult } from './transport.ts';

const roots: string[] = [], services: WebhookService[] = [], stores: RunStore[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  for (const store of stores.splice(0)) store.flush();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});
async function fixture() {
  vi.stubEnv('CEZ_WEBHOOKS', '1');
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-capacity-')); roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  const dataDir = join(root, '.ai/cezar'), directory = join(dataDir, 'webhooks');
  let now = Date.parse('2026-10-15T12:00:00Z');
  const send = vi.fn(async (): Promise<SendResult> => ({ kind: 'http', status: 200 }));
  const options = { root, dataDir, projectId: 'fixture', mode: 'local' as const, serverPorts: () => [], scheduler: new WebhookScheduler(), now: () => now, send };
  const open = async () => { const service = (await WebhookService.open(options))!; services.push(service); return service; };
  const service = await open(), store = RunStore.open(dataDir); stores.push(store);
  const { receiver } = await service.create({ name: 'Fixture', url: 'https://receiver.invalid', graceSeconds: 0 });
  await service.activate(receiver.id, 1);
  const capture = (status: 'done' | 'failed') => {
    const run = store.createRun({ title: 'fixture', task: 'fixture', workflow: 'w', steps: [] });
    store.updateRun(run.id, { status }); return run.id;
  };
  return { service, store, receiver, directory, dataDir, open, send, capture, advance: (ms: number) => { now += ms; } };
}

it.each([200, 410])('publishes HTTP %i and its endpoint effect at capacity despite escaped diagnostics', async status => {
  const x = await fixture(); x.service.attach(x.store, { isActive: () => false }, true);
  // Representative remaining retained capacity: admission fits, 24KiB JSON diagnostics do not.
  const admissions = (x.service as unknown as { admissions: AdmissionRepository }).admissions;
  (admissions as unknown as { limits: { retainedBytes: number } }).limits.retainedBytes = 12000;
  x.send.mockResolvedValue({ kind: 'http', status, response: '\u0000'.repeat(4096) });
  x.capture('done');
  await x.service.tick();
  expect(x.service.deliveries(x.receiver.id)[0]).toMatchObject({ status: status === 200 ? 'delivered' : 'failed', httpStatus: status, attempts: 1 });
  expect(x.service.deliveries(x.receiver.id)[0]!.response).toBeUndefined();
  expect(x.service.list().receivers[0]!.state).toBe(status === 200 ? 'active' : 'disabled');
  await x.service.dispose(); const reopened = await x.open(); reopened.attach(x.store, { isActive: () => false }, true);
  x.advance(11000); await reopened.tick();
  expect(x.send).toHaveBeenCalledTimes(1);
  expect(reopened.deliveries(x.receiver.id)[0]!.resultEffects).toBeUndefined();
});
it('retains complete diagnostics that fit the serialized reservation', async () => {
  const x = await fixture(); x.service.attach(x.store, { isActive: () => false }, true);
  const response = 'a'.repeat(4096); x.send.mockResolvedValue({ kind: 'http', status: 200, response });
  x.capture('done'); await x.service.tick();
  expect(x.service.deliveries(x.receiver.id)[0]!.response).toBe(response);
});

async function saturated() {
  const x = await fixture(); await x.service.dispose();
  const episodes: Record<string, unknown> = {}, index = { version: 1, identityGap: true, episodes };
  let size = Buffer.byteLength(JSON.stringify(index)), sequence = 0;
  while (true) {
    const id = randomUUID(); sequence++;
    const episode = { episodeId: `${id}-${sequence}`, sequence, continuation: 0, since: '2026-10-15T12:00:00.000Z', decisions: { [x.receiver.id]: { manual: randomUUID() } } };
    const delta = Buffer.byteLength(JSON.stringify(id) + ':' + JSON.stringify(episode)) + (sequence > 1 ? 1 : 0);
    if (size + delta > 2 * 1024 * 1024) break;
    episodes[id] = episode; size += delta;
  }
  expect(size).toBeGreaterThan(2 * 1024 * 1024 - 300);
  writeFileSync(join(x.directory, 'failure-episodes.json'), JSON.stringify(index));
  for (const name of ['identity.json', 'outbox.ndjson']) {
    const path = join(x.directory, name), value = JSON.parse(readFileSync(path, 'utf8'));
    value.highWater = sequence; writeFileSync(path, JSON.stringify(value) + '\n');
  }
  // Missing disk evidence must not retire identities before the attached index is healthy.
  rmSync(join(x.dataDir, 'runs.json'), { force: true });
  const service = await x.open();
  const health = vi.spyOn(x.store, 'getIndexReadHealth').mockReturnValue({ state: 'unavailable', omittedRuns: 0 });
  service.attach(x.store, { isActive: () => false }, true);
  const ids = Array.from({ length: 4 }, () => x.capture('failed'));
  await expect(service.tick()).rejects.toThrow('failure identity capacity exhausted');
  health.mockRestore();
  for (const id of ids.slice(1)) x.store.updateRun(id, { status: 'done' });
  x.store.flush(); await service.dispose();
  return { ...x, ids };
}
it('reconciles ended identities before enforcing the real 2MiB cap on every reopen', async () => {
  const x = await saturated();
  for (let attempt = 0; attempt < 2; attempt++) {
    const service = await x.open();
    const index = JSON.parse(readFileSync(join(x.directory, 'failure-episodes.json'), 'utf8'));
    expect(Object.keys(index.episodes)).toEqual([x.ids[0]]);
    expect(index.identityGap).toBe(true);
    expect(service.list().webhookHealth.reason).toMatch(/failure identity/);
    await service.dispose();
  }
});
it.each(['missing', 'unreadable', 'partial'] as const)('does not retire saturated identities with %s run-index evidence', async fault => {
  const x = await saturated(), path = join(x.dataDir, 'runs.json');
  if (fault === 'missing') rmSync(path);
  else if (fault === 'unreadable') writeFileSync(path, '{broken');
  else writeFileSync(path, JSON.stringify([...JSON.parse(readFileSync(path, 'utf8')), { invalid: true }]));
  const before = readFileSync(join(x.directory, 'failure-episodes.json'), 'utf8');
  await expect(x.open()).rejects.toThrow('failure identity capacity exhausted');
  expect(readFileSync(join(x.directory, 'failure-episodes.json'), 'utf8')).toBe(before);
});
