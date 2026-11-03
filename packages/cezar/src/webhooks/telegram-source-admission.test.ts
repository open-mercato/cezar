import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { clearSharedTelegramCooldowns } from '../telegram/send-budget.ts';
import { SecretStore } from '../workspace/secrets.ts';
import { WebhookScheduler } from './scheduler.ts';
import { WebhookService } from './service.ts';
import { TelegramSecrets } from './telegram-secrets.ts';
import type { SendResult, WebhookSend } from './transport.ts';

const roots: string[] = [], services: WebhookService[] = [], stores: RunStore[] = [];
afterEach(async () => {
  clearSharedTelegramCooldowns();
  for (const service of services.splice(0)) await service.dispose();
  for (const store of stores.splice(0)) store.flush();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const token = `123456789:${'T'.repeat(35)}`;
const telegramUrl = `https://api.telegram.org/bot${token}/sendMessage`;

async function harness() {
  vi.stubEnv('CEZ_WEBHOOKS', '1');
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'telegram-source-admission-')); roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  const dataDir = join(root, '.ai/cezar'), now = Date.parse('2026-10-13T12:00:00Z');
  const send = vi.fn(async (_input: WebhookSend): Promise<SendResult> => ({ kind: 'http', status: 200 }));
  const vault = new SecretStore({ ...process.env, CEZ_HOME: join(root, 'vault-home') }, { keychain: async () => null });
  const service = (await WebhookService.open({ root, dataDir, projectId: 'project', mode: 'local', serverPorts: () => [4317],
    scheduler: new WebhookScheduler(), now: () => now, send,
    telegramSecrets: new TelegramSecrets({ kind: 'project', projectId: 'project', root }, vault) }))!;
  services.push(service);
  const store = RunStore.open(dataDir); stores.push(store); service.attach(store, { isActive: () => false }, true);
  const telegram = (await service.create({ name: 'Telegram', format: 'telegram.v1', url: telegramUrl, telegramChatId: '42', graceSeconds: 0, preset: 'all' })).receiver;
  const custom = (await service.create({ name: 'Custom', url: 'https://example.com', graceSeconds: 0, preset: 'all' })).receiver;
  for (const receiver of [telegram, custom]) {
    await service.endpoints.testResult(receiver.id, 1, 1, 'success'); await service.activate(receiver.id, 1);
  }
  const drain = async () => { for (let index = 0; index < 5; index++) await service.tick(); };
  const sentTo = (url: string) => send.mock.calls.filter(([input]) => input.url === url).length;
  return { service, store, telegram, custom, send, drain, sentTo };
}

const sourceFor = (receiverId: string, runId: string) => ({ id: randomUUID(), botId: '123456789', epoch: randomUUID(), projectId: 'project', receiverId,
  grantId: randomUUID(), grantGeneration: randomUUID(), enableGeneration: randomUUID(), chatId: '42', userId: '42', sourceMessageId: 1, updateId: 1,
  episodeId: randomUUID(), requestId: randomUUID(), runId, state: 'finished' as const, createdAt: 1, updatedAt: 1 });

describe('webhook admission of a task started from Telegram', () => {
  it('notifies the source chat through webhook admission when no bot runtime will deliver (G1)', async () => {
    const x = await harness();
    const runId = randomUUID();
    const run = x.store.createRun({ id: runId, title: 'from telegram', task: 'task', workflow: 'w', steps: [], telegramSource: sourceFor(x.telegram.id, runId) });
    x.store.updateRun(run.id, { status: 'done', completionReason: 'completed' });
    await x.drain();
    // Two-way replies are off (no CEZ_CHAT_INBOUND), so silence here would lose the final notice.
    expect(x.sentTo(telegramUrl)).toBe(1);
    expect(x.sentTo('https://example.com')).toBe(1);
  });

  it('leaves the source chat to a runtime that owns its delivery', async () => {
    const x = await harness();
    const owns = vi.spyOn(x.service.telegram, 'ownsSourceDelivery').mockReturnValue(true);
    const runId = randomUUID();
    const run = x.store.createRun({ id: runId, title: 'from telegram', task: 'task', workflow: 'w', steps: [], telegramSource: sourceFor(x.telegram.id, runId) });
    x.store.updateRun(run.id, { status: 'done', completionReason: 'completed' });
    await x.drain();
    expect(owns).toHaveBeenCalled();
    expect(x.sentTo(telegramUrl)).toBe(0);
    // Every other receiver keeps today's path.
    expect(x.sentTo('https://example.com')).toBe(1);
  });

  it('still notifies the Telegram receiver about a task that was not started from it', async () => {
    const x = await harness();
    const run = x.store.createRun({ title: 'from the cockpit', task: 'task', workflow: 'w', steps: [] });
    x.store.updateRun(run.id, { status: 'done', completionReason: 'completed' });
    await x.drain();
    expect(x.sentTo(telegramUrl)).toBe(1);
    expect(x.sentTo('https://example.com')).toBe(1);
  });
});
