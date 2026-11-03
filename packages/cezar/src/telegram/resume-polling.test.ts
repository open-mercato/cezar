import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { SecretStore } from '../workspace/secrets.ts';
import { WebhookService } from '../webhooks/service.ts';
import { WebhookScheduler } from '../webhooks/scheduler.ts';
import { TelegramSecrets } from '../webhooks/telegram-secrets.ts';
import type { SendResult } from '../webhooks/transport.ts';
import type { TelegramCall } from './client.ts';
import type { TelegramUpdate } from './protocol.ts';
import type { InboundStateStore } from './state.ts';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });
function transport(botId: string) {
  let poll: ((value: unknown) => void) | undefined;
  const updates: TelegramUpdate[] = [];
  const call: TelegramCall = vi.fn(async (method, _body, signal) => {
    if (method === 'getMe') return { id: Number(botId), username: 'test_bot' };
    if (method !== 'getUpdates') return {};
    if (updates.length) return updates.splice(0);
    return new Promise(resolve => {
      poll = resolve;
      const abort = () => { if (poll === resolve) poll = undefined; resolve([]); };
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    });
  });
  return { call, push(update: TelegramUpdate) { if (poll) { const current = poll; poll = undefined; current([update]); } else updates.push(update); } };
}
async function paired() {
  vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '1');
  const root = await mkdtemp(join(tmpdir(), 'telegram-resume-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const botId = String(randomInt(100000, 99999999)), token = `${botId}:${'A'.repeat(35)}`, bot = transport(botId);
  const scope = { kind: 'project' as const, projectId: 'project', root };
  const vault = new SecretStore({ ...process.env, CEZ_HOME: join(root, 'vault') }, { keychain: async () => null });
  const send = vi.fn(async (): Promise<SendResult> => ({ kind: 'http', status: 200, response: '{"ok":true,"result":{"message_id":1,"chat":{"id":42}}}' }));
  const webhooks = (await WebhookService.open({ root, dataDir: join(root, '.ai/cezar'), projectId: 'project', mode: 'local',
    serverPorts: () => [], scheduler: new WebhookScheduler(), send, telegramSecrets: new TelegramSecrets(scope, vault), now: Date.now }))!;
  cleanups.push(() => webhooks.dispose());
  const service = webhooks.telegram;
  const deps = (service as unknown as { deps: { callToken(token: string): TelegramCall; call(id: string): TelegramCall } }).deps;
  deps.callToken = () => bot.call; deps.call = () => bot.call;
  let updateId = 1;
  const message = (text: string, chat = 42) => ({ update_id: updateId++, message: { message_id: updateId, date: Math.ceil(Date.now() / 1000),
    chat: { id: chat, type: 'private' as const }, from: { id: chat, is_bot: false, first_name: 'Person' }, text,
    ...(text.startsWith('/') ? { entities: [{ type: 'bot_command' as const, offset: 0, length: 6 }] } : {}) } });
  const begun = await service.beginSetup({ token, dedicatedBot: true });
  bot.push(message(`/start ${new URL(begun.deepLink).searchParams.get('start')}`));
  await vi.waitFor(() => expect(service.setupStatus(begun.setupId).status).toBe('candidate'));
  await service.activateSetup(begun.setupId, { activate: true, expectedRevision: service.setupStatus(begun.setupId).inboundRevision, candidateUserId: '42', permissions: ['respond'] });
  const health = () => service.list().bots[0]?.health.state;
  await vi.waitFor(() => expect(health()).toBe('polling'), { timeout: 3000 });
  const receiver = () => webhooks.list().receivers[0]!;
  const options = (profile: 'minimal' | 'standard') => ({ name: receiver().name, format: 'telegram.v1' as const, telegramChatId: '42', profile,
    preset: 'attention' as const, events: ['task.attention_required' as const], graceSeconds: 0 as const, expectedRevision: receiver().revision });
  const stopped = async () => {
    // A pending long poll ends with an update, as Telegram's timeout would end it.
    bot.push(message('hi', 99));
    await vi.waitFor(() => expect(health()).not.toBe('polling'), { timeout: 3000 });
  };
  const state = () => (service as unknown as { bots: Map<string, { state: InboundStateStore }> }).bots.get(botId)!.state;
  return { webhooks, receiver, options, stopped, health, state };
}

it('polls again after Pause then Resume, without a restart', { timeout: 20000 }, async () => {
  const x = await paired();
  await x.webhooks.pause(x.receiver().id, x.receiver().revision); await x.stopped();
  await x.webhooks.resume(x.receiver().id, x.receiver().revision);
  await vi.waitFor(() => expect(x.health()).toBe('polling'), { timeout: 3000 });
});

it('polls again after Minimal then Standard, without a restart', { timeout: 20000 }, async () => {
  const x = await paired();
  await x.webhooks.update(x.receiver().id, x.options('minimal')); await x.stopped();
  await x.webhooks.update(x.receiver().id, x.options('standard'));
  await vi.waitFor(() => expect(x.health()).toBe('polling'), { timeout: 3000 });
});

it('keeps a conflict stopped on Resume until an explicit recovery', { timeout: 20000 }, async () => {
  const x = await paired();
  await x.webhooks.pause(x.receiver().id, x.receiver().revision); await x.stopped();
  await x.state().change(snapshot => { snapshot.fatalStop = 'conflict'; });
  await x.webhooks.resume(x.receiver().id, x.receiver().revision);
  await new Promise(resolve => setTimeout(resolve, 1500));
  expect(x.health()).not.toBe('polling');
  expect(x.state().snapshot().fatalStop).toBe('conflict');
});
