import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WebhookScheduler } from './scheduler.ts';
import { WebhookService } from './service.ts';
import type { SendResult, WebhookSend } from './transport.ts';

const roots: string[] = [], services: WebhookService[] = [], stores: RunStore[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  for (const store of stores.splice(0)) store.flush();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
async function setup() {
  vi.stubEnv('CEZ_WEBHOOKS', '1');
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-excerpt-service-')); roots.push(root); execFileSync('git', ['init', '-q'], { cwd: root });
  const dataDir = join(root, '.ai/cezar');
  const send = vi.fn(async (_input: WebhookSend): Promise<SendResult> => ({ kind: 'http', status: 200 }));
  const service = (await WebhookService.open({ root, dataDir, projectId: 'project', mode: 'local', serverPorts: () => [4317], scheduler: new WebhookScheduler(), now: () => Date.now(), send }))!;
  services.push(service);
  const store = RunStore.open(dataDir); stores.push(store); service.attach(store, { isActive: () => false }, true);
  return { service, store, send, root };
}

describe('agent excerpt in task.attention_required', () => {
  it('sends the redacted last agent message only to the consenting Standard receiver', async () => {
    vi.stubEnv('CEZ_REDACT_SECRETS', '0');
    vi.stubEnv('TEST_WEBHOOK_SECRET', 'syntheticEnvironmentSecretValue123456');
    const { service, store, send } = await setup();
    const consented = await service.create({ name: 'Excerpt', url: 'https://example.com/a', profile: 'standard', includeAgentExcerpt: true, graceSeconds: 0 });
    const plain = await service.create({ name: 'Plain', url: 'https://example.com/b', profile: 'standard', graceSeconds: 0 });
    expect(consented.receiver.includeAgentExcerpt).toBe(true);
    expect(plain.receiver).not.toHaveProperty('includeAgentExcerpt');
    await service.activate(consented.receiver.id, 1); await service.activate(plain.receiver.id, 1);
    const run = store.createRun({ title: 'task', task: 'task', workflow: 'w', steps: [] });
    store.updateRun(run.id, { status: 'running' });
    store.appendEvent(run.id, { type: 'user-message', text: 'go' });
    store.appendEvent(run.id, { type: 'item.completed', item: { kind: 'message', id: 'item_1', role: 'assistant', text: 'Key syntheticEnvironmentSecretValue123456 is set. Should I deploy?' } });
    store.updateRun(run.id, { status: 'waiting' });
    await service.tick(); await service.tick();
    const bodies = new Map(send.mock.calls.map(([input]) => [input.url, JSON.parse(input.body) as { data: Record<string, unknown> }]));
    expect(bodies.get('https://example.com/a')!.data.agentExcerpt).toMatch(/Should I deploy\?$/);
    expect(JSON.stringify(bodies.get('https://example.com/a'))).not.toContain('syntheticEnvironmentSecretValue123456');
    expect(bodies.get('https://example.com/b')!.data).not.toHaveProperty('agentExcerpt');
  });
  it('turning consent off clears it and changes the delivery revision', async () => {
    const { service, root } = await setup();
    const created = await service.create({ name: 'Excerpt', url: 'https://example.com/a', profile: 'standard', includeAgentExcerpt: true });
    const updated = await service.update(created.receiver.id, { name: 'Excerpt', profile: 'standard', expectedRevision: 1 });
    expect(updated).not.toHaveProperty('includeAgentExcerpt');
    expect(updated.deliveryRevision).toBe(2);
    const renamed = await service.update(created.receiver.id, { name: 'Renamed', profile: 'standard', expectedRevision: 2 });
    expect(renamed.deliveryRevision).toBe(2);
    // Absent, not `false`: an older cezar's strict registry schema still reads the file.
    expect(readFileSync(join(root, '.ai/cezar/webhooks/endpoints.json'), 'utf8')).not.toContain('includeAgentExcerpt');
  });
});
