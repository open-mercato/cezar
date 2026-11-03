import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { TelegramInbound } from './service.ts';
import type { PrivateReceiver } from '../webhooks/endpoints.ts';
import { TelegramApiError, type TelegramCall } from './client.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });

it('a restart forgets an unfinished setup: a bot with no grant does not poll', async () => {
  vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '1');
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'telegram-start-')));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const botId = String(randomInt(100000, 99999999));
  const receiver = { id: randomUUID(), revision: 1, deliveryRevision: 1, format: 'telegram.v1', telegramChatId: '456', state: 'active', lastTest: 'success',
    profile: 'standard', events: ['task.attention_required'], telegramSecret: { sha256: 'a'.repeat(64) } } as PrivateReceiver;
  let polls = 0;
  const call = vi.fn<TelegramCall>(async (method, _body, signal) => {
    if (method === 'getMe') return { id: Number(botId), username: 'test_bot', first_name: 'Test' };
    if (method === 'getUpdates') { polls++; return new Promise(resolve => signal?.addEventListener('abort', () => resolve([]), { once: true })); }
    return {};
  });
  const options = { projectId: 'project', root: directory, installationId: randomUUID(), directory, mode: 'local' as const,
    receivers: () => [receiver], call: () => call, context: vi.fn(), deliver: vi.fn(), episode: () => undefined, changed() {}, now: () => Date.now() };
  const first = new TelegramInbound(options);
  const begun = await first.beginSetup({ receiverId: receiver.id, expectedRevision: first.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  await first.dispose();
  polls = 0;
  const restarted = new TelegramInbound(options);
  cleanups.push(() => restarted.dispose());
  await restarted.load(); await restarted.start();
  expect(polls).toBe(0);
  expect(() => restarted.setupStatus(begun.setupId)).toThrow(expect.objectContaining({ code: 'pairing_expired' }));
});

/** A completed pairing, restarted with getMe answering 429 Retry-After 120 s. */
async function rateLimitedRestart() {
  vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '1');
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'telegram-start-')));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const botId = String(randomInt(100000, 99999999));
  const receiver = { id: randomUUID(), revision: 1, deliveryRevision: 1, format: 'telegram.v1', telegramChatId: '456', state: 'active', lastTest: 'success',
    profile: 'standard', events: ['task.attention_required'], telegramSecret: { sha256: 'a'.repeat(64) } } as PrivateReceiver;
  let limited = false, polls = 0, getMe = 0;
  const call = vi.fn<TelegramCall>(async (method, _body, signal) => {
    if (method === 'getMe') { getMe++; if (limited) throw new TelegramApiError('http', 429, 120); return { id: Number(botId), username: 'test_bot', first_name: 'Test' }; }
    if (method === 'getUpdates') { polls++; return new Promise(resolve => signal?.addEventListener('abort', () => resolve([]), { once: true })); }
    return {};
  });
  const options = { projectId: 'project', root: directory, installationId: randomUUID(), directory, mode: 'local' as const,
    receivers: () => [receiver], call: () => call, context: vi.fn(), deliver: vi.fn(), episode: () => undefined, changed() {}, now: () => Date.now() };
  const first = new TelegramInbound(options);
  const begun = await first.beginSetup({ receiverId: receiver.id, expectedRevision: first.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  first.pairings.accept(botId, 'test_bot', { message_id: 1, date: Math.ceil(Date.now() / 1000), chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false },
    text: `/start ${new URL(begun.deepLink).searchParams.get('start')}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  await first.activateSetup(begun.setupId, { activate: true, expectedRevision: first.setupStatus(begun.setupId).inboundRevision, candidateUserId: '456', permissions: ['respond'] });
  await first.dispose();
  limited = true; getMe = 0; polls = 0;
  const restarted = new TelegramInbound(options);
  cleanups.push(() => restarted.dispose());
  await restarted.load(); await restarted.start();
  await vi.waitFor(() => expect(getMe).toBe(1));
  return { restarted, receiver, getMe: () => getMe, polls: () => polls, unlimit: () => { limited = false; } };
}

it('leaves a startup waiting out Retry-After alone when discovery calls start() again', async () => {
  const x = await rateLimitedRestart();
  for (let tick = 0; tick < 3; tick++) await x.restarted.start();
  expect(x.getMe()).toBe(1);
});

it('still restarts a startup waiting out Retry-After at once on an explicit enable', async () => {
  const x = await rateLimitedRestart();
  x.unlimit();
  await x.restarted.setEnabled(x.receiver.id, { expectedRevision: x.restarted.list().receivers[0]!.inboundRevision, enabled: true });
  await vi.waitFor(() => expect(x.polls()).toBeGreaterThan(0));
});
