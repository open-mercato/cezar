import { afterEach, expect, it, vi } from 'vitest';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { TelegramInbound } from './service.ts';
import type { PrivateReceiver } from '../webhooks/endpoints.ts';
import type { TelegramCall } from './client.ts';
import type { InboundStateStore } from './state.ts';
import { botDirectory } from './ownership.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.unstubAllEnvs(); });
const pending = (signal?: AbortSignal) => new Promise(resolve => signal?.addEventListener('abort', () => resolve([]), { once: true }));
const command = { type: 'bot_command', offset: 0, length: 6 };

/** A project with no receivers yet: the bot token is pasted into the wizard. */
async function fixture({ inbound = '1', forum = false }: { inbound?: '0' | '1'; forum?: boolean } = {}) {
  let now = 10_000;
  vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', inbound);
  const directory = await mkdtemp(join(tmpdir(), 'telegram-setup-'));
  const botId = String(randomInt(100000, 99999999)), token = `${botId}:${'A'.repeat(35)}`;
  const receivers: PrivateReceiver[] = [];
  const call = vi.fn<TelegramCall>(async (method, body, signal) => {
    if (method === 'getMe') return { id: Number(botId), username: 'test_bot' };
    if (method === 'getUpdates') return pending(signal);
    if (method === 'getChat') return { id: Number((body as { chat_id: string }).chat_id), type: 'supergroup', ...(forum ? { is_forum: true } : {}) };
    if (method === 'getChatMember') return { user: { id: (body as { user_id: number }).user_id }, status: 'member' };
    return {};
  });
  const created: PrivateReceiver[] = [];
  const createReceiverFromToken = vi.fn(async (secret: string, name: string | undefined, chatId: string, existingId?: string) => {
    const existing = receivers.find(receiver => receiver.id === existingId);
    // Like the real store, a reused receiver takes the pasted token.
    if (existing) return Object.assign(existing, { url: `https://api.telegram.org/bot${secret}/sendMessage`,
      telegramSecret: { sha256: createHash('sha256').update(secret).digest('hex') } });
    const receiver = { id: randomUUID(), name: name ?? 'Telegram', revision: 3, deliveryRevision: 1, format: 'telegram.v1', telegramChatId: chatId, state: 'active',
      lastTest: 'success', profile: 'standard', preset: 'attention', events: ['task.attention_required'], url: `https://api.telegram.org/bot${secret}/sendMessage`,
      telegramSecret: { sha256: createHash('sha256').update(secret).digest('hex') } } as PrivateReceiver;
    receivers.push(receiver); created.push(receiver); return receiver;
  });
  const removeBotReceivers = vi.fn(async () => undefined);
  const options = { projectId: 'project', root: directory, installationId: randomUUID(), directory, mode: 'local' as const,
    receivers: () => receivers, call: () => call, callToken: () => call, createReceiverFromToken, removeBotReceivers,
    context: vi.fn(), deliver: vi.fn(), episode: () => undefined, changed() {}, now: () => now };
  const service = new TelegramInbound(options as never);
  cleanups.push(async () => { await service.dispose(); await rm(directory, { recursive: true, force: true }); });
  /** Begin a token-led setup and press Start in `chatId`. */
  const started = async (chatId = 456, pasted = token) => {
    const begun = await service.beginSetup({ token: pasted, name: 'Phone', dedicatedBot: true });
    const code = new URL(begun.deepLink).searchParams.get('start');
    const chat = chatId < 0 ? { id: chatId, type: 'supergroup' as const, title: 'Release crew' } : { id: chatId, type: 'private' as const };
    expect(service.pairings.accept(botId, 'test_bot', { message_id: 1, date: 10, chat, from: { id: 456, is_bot: false, first_name: 'Person' },
      text: `/start ${code}`, entities: [command] })).toBe('candidate');
    return { begun, status: service.setupStatus(begun.setupId) };
  };
  const bindings = () => (service as unknown as { bots: Map<string, { state: InboundStateStore }> }).bots.get(botId)!.state.snapshot().receivers;
  const bound = () => access(join(botDirectory(botId), 'binding.json')).then(() => true, () => false);
  /** A fresh service over the same directory, as after a cezar restart. */
  const restarted = async () => {
    const next = new TelegramInbound(options as never); cleanups.unshift(() => next.dispose()); await next.load(); return next;
  };
  return { service, botId, token, receivers, created, call, createReceiverFromToken, removeBotReceivers, started, bindings, bound, restarted,
    setNow: (value: number) => { now = value; } };
}

it('a retried activation reuses the receiver it already created instead of adding another', async () => {
  const x = await fixture();
  const { begun, status } = await x.started();
  const confirm = vi.spyOn(x.service, 'confirm').mockRejectedValueOnce(new Error('network'));
  const activation = { activate: true as const, expectedRevision: status.inboundRevision, candidateUserId: '456', permissions: ['respond' as const] };
  await expect(x.service.activateSetup(begun.setupId, activation)).rejects.toThrow('network');
  confirm.mockRestore();
  const active = await x.service.activateSetup(begun.setupId, activation);
  expect(active.grant).toMatchObject({ receiverId: x.created[0]!.id });
  expect(x.created).toHaveLength(1);
  expect(x.createReceiverFromToken).toHaveBeenLastCalledWith(x.token, 'Phone', '456', x.created[0]!.id);
  expect(x.bindings().filter(row => row.chatId === '456')).toHaveLength(1);
});
it('a second setup for a chat this bot already serves reuses that receiver and its binding', async () => {
  const x = await fixture();
  const first = await x.started();
  await x.service.activateSetup(first.begun.setupId, { activate: true, taskControl: false, expectedRevision: first.status.inboundRevision, candidateUserId: '456' });
  const second = await x.started();
  await x.service.activateSetup(second.begun.setupId, { activate: true, taskControl: false, expectedRevision: second.status.inboundRevision, candidateUserId: '456' });
  expect(x.created).toHaveLength(1);
  expect(x.createReceiverFromToken).toHaveBeenLastCalledWith(x.token, 'Phone', '456', x.created[0]!.id);
  expect(x.bindings()).toEqual([expect.objectContaining({ receiverId: x.created[0]!.id, chatId: '456' })]);
});
it('a token-led group activation requires the group-visibility consent and a plain group, before any receiver exists', async () => {
  const x = await fixture();
  const { begun, status } = await x.started(-1001234567890);
  const notifications = { activate: true as const, taskControl: false, expectedRevision: status.inboundRevision, candidateUserId: '456' };
  await expect(x.service.activateSetup(begun.setupId, notifications)).rejects.toMatchObject({ status: 400, code: 'group_visibility_required' });
  expect(x.createReceiverFromToken).not.toHaveBeenCalled();
  await x.service.activateSetup(begun.setupId, { ...notifications, groupVisibilityAccepted: true });
  expect(x.call).toHaveBeenCalledWith('getChat', { chat_id: '-1001234567890' });
  expect(x.call).toHaveBeenCalledWith('getChatMember', { chat_id: '-1001234567890', user_id: Number(x.botId) });
  expect(x.created).toEqual([expect.objectContaining({ telegramChatId: '-1001234567890' })]);

  const forum = await fixture({ forum: true });
  const topic = await forum.started(-1009999999999);
  await expect(forum.service.activateSetup(topic.begun.setupId, { activate: true, taskControl: false, groupVisibilityAccepted: true,
    expectedRevision: topic.status.inboundRevision, candidateUserId: '456' })).rejects.toMatchObject({ code: 'group_ineligible' });
  expect(forum.createReceiverFromToken).not.toHaveBeenCalled();
});
it('sets up notifications with CEZ_WEBHOOKS=1 alone; task control still needs CEZ_CHAT_INBOUND=1', async () => {
  const x = await fixture({ inbound: '0' });
  expect(x.service.list()).toMatchObject({ available: false, reason: 'flag_off',
    notifications: { available: true }, taskControl: { available: false, reason: 'flag_off' } });
  const { begun, status } = await x.started();
  expect(status).toMatchObject({ status: 'candidate', candidate: { userId: '456' } });
  await expect(x.service.activateSetup(begun.setupId, { activate: true, expectedRevision: status.inboundRevision, candidateUserId: '456', permissions: ['respond'] }))
    .rejects.toMatchObject({ status: 503, code: 'flag_off' });
  expect(x.createReceiverFromToken).not.toHaveBeenCalled();
  const done = await x.service.activateSetup(begun.setupId, { activate: true, taskControl: false, expectedRevision: status.inboundRevision, candidateUserId: '456' });
  expect(done).toEqual({ receiverId: x.created[0]!.id, inboundRevision: expect.any(String) });
  expect(x.service.list().grants).toEqual([]);
  // Approving a person on an existing receiver is task control.
  await expect(x.service.beginSetup({ receiverId: x.created[0]!.id, expectedRevision: x.service.list().receivers[0]!.inboundRevision, dedicatedBot: true }))
    .rejects.toMatchObject({ status: 503, code: 'flag_off' });
});
it('hosted and webhooks-off refuse token-led setup outright', async () => {
  const x = await fixture();
  vi.stubEnv('CEZ_WEBHOOKS', '0');
  await expect(x.service.beginSetup({ token: x.token, dedicatedBot: true })).rejects.toMatchObject({ status: 503, code: 'webhooks_off' });
  expect(x.service.list()).toMatchObject({ notifications: { available: false, reason: 'webhooks_off' }, taskControl: { available: false, reason: 'webhooks_off' } });
  expect(x.call).not.toHaveBeenCalled();
});
it('disconnecting a bot removes the receivers it sends through; resetting access keeps them', async () => {
  const x = await fixture();
  const { begun, status } = await x.started();
  const active = await x.service.activateSetup(begun.setupId, { activate: true, expectedRevision: status.inboundRevision, candidateUserId: '456', permissions: ['respond'] });
  const reset = await x.service.reset(x.botId, active.inboundRevision);
  expect(x.removeBotReceivers).not.toHaveBeenCalled(); expect(x.service.list().grants).toEqual([]);
  await x.service.disconnect(x.botId, reset.inboundRevision);
  expect(x.removeBotReceivers).toHaveBeenCalledWith(x.botId, [x.created[0]!.id]);
  expect(x.service.list().bots).toEqual([]);
});
it('a failed receiver removal leaves the bot connected, so Disconnect can be retried', async () => {
  const x = await fixture();
  const { begun, status } = await x.started();
  const done = await x.service.activateSetup(begun.setupId, { activate: true, taskControl: false, expectedRevision: status.inboundRevision, candidateUserId: '456' });
  x.removeBotReceivers.mockRejectedValueOnce(new Error('vault'));
  await expect(x.service.disconnect(x.botId, done.inboundRevision)).rejects.toThrow('vault');
  const bot = x.service.list().bots.find(row => row.botId === x.botId)!;
  expect(bot).toBeDefined();
  await x.service.disconnect(x.botId, bot.inboundRevision!);
  expect(x.service.list().bots).toEqual([]);
});
it('names the discovered group, the bot by its username, and a receiver suspended by Telegram', async () => {
  const x = await fixture();
  const { begun, status } = await x.started(-1001234567890);
  expect(status.candidate).toMatchObject({ chatType: 'group', chatTitle: 'Release crew' });
  expect(x.service.pairings.accept(x.botId, 'test_bot', { message_id: 2, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false, first_name: 'Person' },
    text: `/start ${new URL(begun.deepLink).searchParams.get('start')}`, entities: [command] })).toBe('candidate');
  expect(x.service.setupStatus(begun.setupId).candidate).toMatchObject({ chatType: 'private', chatTitle: 'Release crew', comparisonCode: expect.any(String) });
  await x.service.activateSetup(begun.setupId, { activate: true, taskControl: false, groupVisibilityAccepted: true, expectedRevision: status.inboundRevision, candidateUserId: '456' });
  expect(x.service.list().bots).toEqual([expect.objectContaining({ botId: x.botId, username: 'test_bot' })]);
  const store = (x.service as unknown as { bots: Map<string, { state: InboundStateStore }> }).bots.get(x.botId)!.state;
  await store.change(state => { state.receivers[0]!.suspendedReason = 'bot_removed'; });
  expect(x.service.list().receivers).toEqual([expect.objectContaining({ receiverId: x.created[0]!.id, suspendedReason: 'bot_removed', state: 'suspended' })]);
});
it('a notifications-only re-run on a chat whose people are approved keeps their task control', async () => {
  const x = await fixture();
  const first = await x.started();
  await x.service.activateSetup(first.begun.setupId, { activate: true, expectedRevision: first.status.inboundRevision, candidateUserId: '456', permissions: ['respond'] });
  const second = await x.started();
  await x.service.activateSetup(second.begun.setupId, { activate: true, taskControl: false, expectedRevision: second.status.inboundRevision, candidateUserId: '456' });
  expect(x.bindings()).toEqual([expect.objectContaining({ chatId: '456', enabled: true })]);
  expect(x.service.list()).toMatchObject({ receivers: [{ state: 'active' }], grants: [{ userId: '456' }] });
});
it('a first notifications-only setup leaves the chat without task control (guard)', async () => {
  const x = await fixture();
  const { begun, status } = await x.started();
  await x.service.activateSetup(begun.setupId, { activate: true, taskControl: false, expectedRevision: status.inboundRevision, candidateUserId: '456' });
  expect(x.bindings()).toEqual([expect.objectContaining({ chatId: '456', enabled: false })]);
});
it.each(['0', '1'] as const)('cancelling a first token-led setup releases the bot it bound (CEZ_CHAT_INBOUND=%s)', async inbound => {
  const x = await fixture({ inbound });
  const { begun } = await x.started();
  expect(await x.bound()).toBe(true);
  await x.service.cancelSetup(begun.setupId);
  expect(x.service.list().bots).toEqual([]);
  expect(await x.bound()).toBe(false);
  expect((await x.restarted()).list().bots).toEqual([]);
});
it('an expired first token-led setup releases the bot it bound', async () => {
  const x = await fixture();
  const { begun } = await x.started();
  x.setNow(begun.expiresAt + 1);
  expect(x.service.setupStatus(begun.setupId).status).toBe('expired');
  await vi.waitFor(() => expect(x.service.list().bots).toEqual([]));
  expect(await x.bound()).toBe(false);
});
it('a restart releases a bot a first setup bound and never used', async () => {
  const x = await fixture();
  await x.started();
  // The process died mid-setup: nothing released the bot, so the next boot must.
  (x.service as unknown as { setup: { setups: Map<string, unknown> } }).setup.setups.clear();
  await x.service.dispose();
  const next = await x.restarted();
  expect(next.list().bots).toEqual([]);
  expect(await x.bound()).toBe(false);
});
it('cancelling Add a chat on a bot that already serves a chat keeps the bot (guard)', async () => {
  const x = await fixture();
  const first = await x.started();
  await x.service.activateSetup(first.begun.setupId, { activate: true, taskControl: false, expectedRevision: first.status.inboundRevision, candidateUserId: '456' });
  const { begun } = await x.started(-1001234567890);
  await x.service.cancelSetup(begun.setupId);
  expect(x.service.list().bots).toEqual([expect.objectContaining({ botId: x.botId })]);
  expect(await x.bound()).toBe(true);
  expect((await x.restarted()).list().bots).toEqual([expect.objectContaining({ botId: x.botId })]);
});
type Internals = { bots: Map<string, { state: InboundStateStore }> };
const store = (service: TelegramInbound, botId: string) => (service as unknown as Internals).bots.get(botId)!.state;
/** Approve person 456 in a private chat, then mark the bot stopped by `fatalStop` as a revoked token would. */
async function approvedThenStopped(fatalStop: 'credentials-unavailable' | 'conflict') {
  const x = await fixture();
  const first = await x.started();
  await x.service.activateSetup(first.begun.setupId, { activate: true, expectedRevision: first.status.inboundRevision, candidateUserId: '456', permissions: ['respond'] });
  await store(x.service, x.botId).change(state => { state.fatalStop = fatalStop; });
  return x;
}
it('Add a chat with a new token for the same bot clears a revoked-credentials stop, so task control survives a restart', async () => {
  const x = await approvedThenStopped('credentials-unavailable');
  const rotated = `${x.botId}:${'B'.repeat(35)}`;
  const second = await x.started(456, rotated);
  await x.service.activateSetup(second.begun.setupId, { activate: true, taskControl: false, expectedRevision: second.status.inboundRevision, candidateUserId: '456' });
  expect(store(x.service, x.botId).snapshot().fatalStop).toBeUndefined();
  await x.service.dispose();
  const next = await x.restarted(); await next.start();
  await vi.waitFor(() => expect(next.list().bots).toEqual([expect.objectContaining({ botId: x.botId, health: expect.objectContaining({ state: 'polling' }) })]));
  expect(next.list().receivers).toEqual([expect.objectContaining({ receiverId: x.created[0]!.id, state: 'active' })]);
});
it('a re-run with a new token keeps a conflict stop: only enable, pair or reset clears it (guard)', async () => {
  const x = await approvedThenStopped('conflict');
  const second = await x.started(456, `${x.botId}:${'B'.repeat(35)}`);
  await x.service.activateSetup(second.begun.setupId, { activate: true, taskControl: false, expectedRevision: second.status.inboundRevision, candidateUserId: '456' });
  expect(store(x.service, x.botId).snapshot().fatalStop).toBe('conflict');
});
it('a task-control re-run for a person already approved finishes and keeps their grant', async () => {
  const x = await fixture();
  const first = await x.started();
  await x.service.activateSetup(first.begun.setupId, { activate: true, expectedRevision: first.status.inboundRevision, candidateUserId: '456', permissions: ['respond', 'cancel'] });
  const second = await x.started(456, `${x.botId}:${'B'.repeat(35)}`);
  const done = await x.service.activateSetup(second.begun.setupId, { activate: true, expectedRevision: second.status.inboundRevision, candidateUserId: '456', permissions: ['respond'] });
  expect(done).toEqual({ receiverId: x.created[0]!.id, inboundRevision: expect.any(String) });
  expect(x.service.list().grants).toEqual([expect.objectContaining({ userId: '456', permissions: ['respond', 'cancel'] })]);
  expect(() => x.service.setupStatus(second.begun.setupId)).toThrow(expect.objectContaining({ code: 'pairing_expired' }));
});
it('grants of a deleted receiver are neither listed nor reason to poll after a restart', async () => {
  const x = await fixture();
  const first = await x.started();
  await x.service.activateSetup(first.begun.setupId, { activate: true, expectedRevision: first.status.inboundRevision, candidateUserId: '456', permissions: ['respond'] });
  x.receivers.splice(0);
  expect(x.service.list().grants).toEqual([]);
  await x.service.dispose();
  const next = await x.restarted(); await next.start();
  expect((next as unknown as Internals).bots.size).toBe(0);
});
