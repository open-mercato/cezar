import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { WebhookScheduler } from './scheduler.ts';
import { WebhookService } from './service.ts';
import type { SendResult } from './transport.ts';

const roots: string[] = [], services: WebhookService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

async function fixture(result: SendResult) {
  vi.stubEnv('CEZ_WEBHOOKS', '1');
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'endpoint-capacity-')); roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  const dataDir = join(root, '.ai/cezar');
  const send = vi.fn(async () => result);
  const options = { root, dataDir, projectId: 'fixture', mode: 'local' as const, serverPorts: () => [],
    scheduler: new WebhookScheduler(), now: () => Date.parse('2026-10-20T12:00:00Z'), send };
  const open = async () => { const service = (await WebhookService.open(options))!; services.push(service); return service; };
  const service = await open();
  const { receiver } = await service.create({ name: 'Receiver', url: 'https://example.com' });
  await service.activate(receiver.id, 1);
  await service.test(receiver.id, { expectedRevision: 2, deliveryRevision: 1, operationId: 'test' });
  await service.dispose();
  const path = join(dataDir, 'webhooks/endpoints.json');
  const state = JSON.parse(readFileSync(path, 'utf8'));
  state.receivers[0].consecutiveFailures = 9;
  // A valid legacy installation, accepted by the old 1MiB serialized-state budget.
  const target = 1024 * 1024 - 10;
  let size = Buffer.byteLength(JSON.stringify(state));
  while (size < target) {
    const row = { ...state.receivers[0], id: randomUUID(), name: 'x'.repeat(100) };
    state.receivers.push(row); size += Buffer.byteLength(JSON.stringify(row)) + 1;
  }
  let extra = size - target;
  for (let i = state.receivers.length - 1; extra > 0; i--) {
    const row = state.receivers[i], trim = Math.min(extra, row.name.length - 1);
    row.name = row.name.slice(trim); extra -= trim;
  }
  expect(Buffer.byteLength(JSON.stringify(state))).toBe(target);
  writeFileSync(path, JSON.stringify(state));
  return { open, send, path, id: receiver.id, count: state.receivers.length };
}

it.each([204, 410, 503, 'policy'] as const)('recovers mandatory %s effects in a legacy full registry and remains manageable across reopens', async status => {
  const x = await fixture(status === 'policy' ? { kind: 'policy', reason: 'private_address' } : { kind: 'http', status });
  const service = await x.open();
  // Crash after durable result publication but before its mandatory registry effect.
  vi.spyOn(service.endpoints, 'deliveryResult').mockRejectedValueOnce(new Error('interrupted effect'));
  await expect(service.tick()).rejects.toThrow('interrupted effect');
  expect(service.deliveries(x.id)[0]!.resultEffects).toBeDefined();
  await service.dispose();
  for (let attempt = 0; attempt < 3; attempt++) {
    const reopened = await x.open();
    const receiver = reopened.endpoints.privateReceiver(x.id)!;
    expect(receiver.state).toBe(status === 410 ? 'disabled' : status === 503 ? 'suspended' : 'active');
    expect(receiver.lastResult).toBeDefined();
    expect(receiver.consecutiveFailures).toBe(status === 204 ? 0 : status === 503 ? 10 : 9);
    expect(receiver.activationBlocked).toBe(status === 410 || status === 'policy');
    expect(reopened.deliveries(x.id)[0]!.resultEffects).toBeUndefined();
    expect(reopened.list().receivers).toHaveLength(x.count);
    await reopened.endpoints.acknowledge(reopened.list().changeSequence);
    await reopened.endpoints.update(x.id, { expectedRevision: receiver.revision,
      // Full settings submission, without the registry's private/runtime fields.
      ...settings(receiver), name: `Renamed ${attempt}` });
    await reopened.dispose();
  }
  const reopened = await x.open();
  const receiver = reopened.endpoints.privateReceiver(x.id)!;
  await reopened.endpoints.rotate(x.id, receiver.revision, 'graceful');
  await reopened.delete(x.id, receiver.revision + 1);
  expect(reopened.list().receivers).toHaveLength(x.count - 1);
  expect(x.send).toHaveBeenCalledTimes(1);
  expect(Buffer.byteLength(readFileSync(x.path))).toBeLessThanOrEqual(1024 * 1024 + (x.count - 1) * 4096 + 8192 + 1);
});

function settings(receiver: ReturnType<WebhookService['endpoints']['live']>[number]) {
  const { name, url, format, profile, preset, events, includeScheduledFailures, scope, graceSeconds, allowLocalNetwork } = receiver;
  return { name, url, format, profile, preset, events, includeScheduledFailures, scope, graceSeconds, allowLocalNetwork };
}

it('rejects definition growth at capacity while result recovery, deletion and replacement still fit', async () => {
  const x = await fixture({ kind: 'http', status: 410 });
  const state = JSON.parse(readFileSync(x.path, 'utf8'));
  const definitions = { version: state.version, receivers: state.receivers.map((row: Parameters<typeof settings>[0]) => ({ id: row.id, ...settings(row) })), history: state.history };
  let remaining = 1024 * 1024 - 10 - Buffer.byteLength(JSON.stringify(definitions));
  for (const row of state.receivers) {
    const added = Math.min(remaining, 2048 - row.url.length);
    if (added > 0) row.url += '/' + 'x'.repeat(added - 1);
    remaining -= added;
  }
  expect(remaining).toBe(0);
  writeFileSync(x.path, JSON.stringify(state));
  const service = await x.open();
  const before = readFileSync(x.path, 'utf8');
  await expect(service.create({ name: 'Cannot use operational reserve', url: 'https://example.com' })).rejects.toThrow('Receiver storage capacity exhausted');
  const receiver = service.endpoints.privateReceiver(x.id)!;
  await expect(service.endpoints.update(x.id, { ...settings(receiver), name: 'a'.repeat(100), expectedRevision: receiver.revision })).rejects.toThrow('Receiver storage capacity exhausted');
  expect(readFileSync(x.path, 'utf8')).toBe(before);
  await service.tick();
  expect(service.endpoints.privateReceiver(x.id)!.state).toBe('disabled');
  expect(service.deliveries(x.id)[0]!.resultEffects).toBeUndefined();
  await service.dispose();
  const reopened = await x.open();
  await reopened.delete(x.id, reopened.endpoints.privateReceiver(x.id)!.revision);
  const replacement = await reopened.create({ name: 'Replacement', url: 'https://example.com' });
  await reopened.activate(replacement.receiver.id, 1);
  await reopened.endpoints.pause(replacement.receiver.id, 2);
  await reopened.dispose();
  const final = await x.open();
  expect(final.endpoints.privateReceiver(replacement.receiver.id)!.state).toBe('paused');
  expect(final.list().receivers).toHaveLength(x.count);
  expect(Buffer.byteLength(readFileSync(x.path))).toBeLessThanOrEqual(1024 * 1024 + x.count * 4096 + 8192 + 1);
});
