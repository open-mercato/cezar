import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { clearSharedChatCooldowns } from '../chat/send-budget.ts';
import { WebhookScheduler } from './scheduler.ts';
import { WebhookService } from './service.ts';
import { EndpointRegistry } from './endpoints.ts';
import type { SendResult, WebhookSend } from './transport.ts';

const roots: string[] = [], services: WebhookService[] = [], stores: RunStore[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  for (const store of stores.splice(0)) store.flush();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  clearSharedChatCooldowns(); vi.restoreAllMocks(); vi.unstubAllEnvs();
});
const providers = [
  { format: 'telegram.v1', url: `https://api.telegram.org/bot123456789:${'T'.repeat(35)}/sendMessage`, chatId: '42', botId: '123456789' },
  { format: 'slack.v1', url: 'https://hooks.slack.com/services/TA/BB/old', destination: 'https://slack.com/api/chat.postMessage', chatId: 'private:TTEAM:UBOT:DCHAN', botId: 'TTEAM:UBOT' },
  { format: 'discord.v1', url: `https://discord.com/api/webhooks/123456789012345678/${'x'.repeat(60)}`, destination: 'https://discord.com/api/v10', chatId: 'discord:dm:123', botId: '456' },
] as const;
async function setup(provider: typeof providers[number], graceSeconds: 0 | 60) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'bot-payload-')); roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root, timeout: 10000 });
  vi.stubEnv('CEZ_HOME', join(root, 'home')); vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '0'); vi.stubEnv('CEZ_EXTENSIONS', '0');
  let now = Date.now();
  const send = vi.fn(async (_input: WebhookSend): Promise<SendResult> => ({ kind: 'http', status: 200 }));
  const dataDir = join(root, '.ai/cezar');
  const service = (await WebhookService.open({ root, dataDir, projectId: 'policy', mode: 'local', serverPorts: () => [], scheduler: new WebhookScheduler(), now: () => now, send }))!;
  services.push(service);
  // Replace only the wire; exercise real bot rendering, admission, claims and persistence.
  vi.spyOn(service.chat, 'send').mockImplementation((_receiver, request) => send(request));
  const store = RunStore.open(dataDir); stores.push(store); service.attach(store, { isActive: () => false }, true);
  let receiver = (await service.create({ name: 'Bot', format: provider.format, url: provider.url, ...(provider.format === 'telegram.v1' ? { chatId: provider.chatId } : {}), profile: 'standard', includeAgentExcerpt: true, graceSeconds })).receiver;
  if ('destination' in provider) await service.endpoints.attachChat({ receiverId: receiver.id, expectedRevision: receiver.revision, format: provider.format, url: provider.destination, chatId: provider.chatId, botId: provider.botId, credential: 'fixture-credential' });
  receiver = service.list().receivers[0]!;
  await service.endpoints.deliveryResult(receiver.id, receiver.revision, receiver.deliveryRevision, 'success', true);
  receiver = await service.activate(receiver.id, service.list().receivers[0]!.revision);
  const queue = () => {
    const run = store.createRun({ title: 'PRIVATE TITLE', task: 'task', workflow: 'w', steps: [] });
    store.updateRun(run.id, { status: 'running' });
    store.appendEvent(run.id, { type: 'item.completed', item: { kind: 'message', id: randomUUID(), role: 'assistant', text: 'CONFIDENTIAL EXCERPT' } });
    now = Math.max(now, Date.now()) + 10;
    store.updateRun(run.id, { status: 'waiting' });
  };
  const settings = () => {
    const current = service.list().receivers[0]!;
    return { name: current.name, format: current.format, chatId: current.chatId, profile: current.profile, includeAgentExcerpt: current.includeAgentExcerpt, preset: current.preset, events: current.events, scope: current.scope, graceSeconds: current.graceSeconds, expectedRevision: current.revision };
  };
  return { service, send, queue, settings, receiver, dataDir, advance: () => { now += 120000; } };
}
for (const provider of providers) {
  for (const change of ['optout', 'minimal', 'filter'] as const) {
    for (const phase of ['grace', 'retry', 'replay'] as const) {
      it(`${provider.format} fences ${phase} payload after ${change}, preserving tested destination`, async () => {
        const x = await setup(provider, phase === 'grace' ? 60 : 0);
        if (phase === 'retry') x.send.mockResolvedValue({ kind: 'http', status: 500 });
        x.queue(); await x.service.tick(); await x.service.tick();
        const old = x.service.deliveries(x.receiver.id)[0]!;
        expect(old).toBeDefined();
        if (phase === 'grace') expect(x.send).not.toHaveBeenCalled();
        else { expect(x.send).toHaveBeenCalledTimes(1); expect(x.send.mock.calls[0]![0].body).toContain('CONFIDENTIAL EXCERPT'); }
        expect(old.status).toBe(phase === 'replay' ? 'delivered' : phase === 'retry' ? 'retrying' : 'pending');
        if (phase === 'replay') {
          const current = x.service.list().receivers[0]!;
          await x.service.replay(old.id, { expectedRevision: current.revision, deliveryRevision: current.deliveryRevision, operationId: randomUUID() });
        }
        const patch = change === 'optout' ? { includeAgentExcerpt: undefined } : change === 'minimal' ? { profile: 'minimal' as const, includeAgentExcerpt: undefined } : { preset: 'custom' as const, events: ['task.finished' as const] };
        const updated = await x.service.update(x.receiver.id, { ...x.settings(), ...patch });
        expect(updated).toMatchObject({ state: 'active', lastTest: 'success', deliveryRevision: x.receiver.deliveryRevision });
        x.send.mockClear(); x.advance(); await x.service.tick();
        expect(x.send).not.toHaveBeenCalled();
        const row = x.service.deliveryPage(x.receiver.id, { limit: 100 }).items.find(row => row.deliveryId === old.id)!;
        expect(row.retryAllowed).toBe(false); expect(row.replayAllowed).toBe(false);
        const operation = { expectedRevision: updated.revision, deliveryRevision: updated.deliveryRevision, operationId: randomUUID() };
        await expect(x.service.replay(old.id, operation)).rejects.toThrow();
        await expect(x.service.retry(old.id, { ...operation, operationId: randomUUID() })).rejects.toThrow();
        // New occurrences still work using the current policy without retesting.
        x.send.mockResolvedValue({ kind: 'http', status: 200 }); x.queue(); await x.service.tick(); x.advance(); await x.service.tick();
        if (change === 'filter') expect(x.send).not.toHaveBeenCalled();
        else { expect(x.send).toHaveBeenCalledTimes(1); expect(x.send.mock.calls[0]![0].body).not.toContain('CONFIDENTIAL EXCERPT'); }
      });
    }
  }
  it(`${provider.format} persists the fence before best-effort cancellation`, async () => {
    const x = await setup(provider, 60); x.queue(); await x.service.tick();
    const old = x.service.deliveries(x.receiver.id)[0]!;
    // Simulate a crash/write failure after the registry commit, before cancelUnsent.
    const updated = await x.service.endpoints.update(x.receiver.id, { ...x.settings(), includeAgentExcerpt: undefined });
    const reopened = await EndpointRegistry.open(join(x.dataDir, 'webhooks'), { installationId: 'policy', highWater: () => 0, now: Date.now, assertOwner() {} });
    expect(reopened.privateReceiver(x.receiver.id)?.payloadSinceRevision).toBe(updated.revision);
    expect(updated).not.toHaveProperty('payloadSinceRevision');
    expect(x.service.deliveries(x.receiver.id)[0]!.status).toBe('pending');
    x.advance();
    await expect(x.service.retry(old.id, { expectedRevision: updated.revision, deliveryRevision: updated.deliveryRevision, operationId: randomUUID() })).rejects.toThrow('no longer eligible');
    await x.service.tick();
    expect(x.send).not.toHaveBeenCalled();
    expect(x.service.deliveries(x.receiver.id)[0]!.status).toBe('cancelled');
  });
  it(`${provider.format} rename preserves queued payload and replay`, async () => {
    const x = await setup(provider, 60); x.queue(); await x.service.tick();
    await x.service.update(x.receiver.id, { ...x.settings(), name: 'Renamed' });
    x.advance(); await x.service.tick();
    expect(x.send).toHaveBeenCalledTimes(1); expect(x.send.mock.calls[0]![0].body).toContain('CONFIDENTIAL EXCERPT');
    expect(x.service.deliveryPage(x.receiver.id, { limit: 100 }).items[0]!.replayAllowed).toBe(true);
  });
}
