import { afterEach, expect, it, vi } from 'vitest';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID, randomInt } from 'node:crypto';
import { TelegramInbound, TelegramInboundFailure } from './service.ts';
import type { PrivateReceiver } from '../webhooks/endpoints.ts';
import { TelegramApiError, type TelegramCall } from './client.ts';
import { ZodError } from 'zod';
import { grantFresh } from './authorization.ts';
import { BotLease, botDirectory } from './ownership.ts';
import type { InboundStateStore } from './state.ts';
import type { RunRecord } from '../runs/store.ts';
const cleanups: (() => Promise<void>)[] = [];
const digestForTest = (value: string) => createHash('sha256').update(value).digest('hex');
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.unstubAllEnvs(); });
async function fixture() {
  vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '1');
  const directory = await mkdtemp(join(tmpdir(), 'telegram-controller-'));
  const botId = String(randomInt(100000, 99999999));
  let now = 10_000;
  const receiver = { id: randomUUID(), revision: 1, deliveryRevision: 1, format: 'telegram.v1', telegramChatId: '456', state: 'active', lastTest: 'success', profile: 'standard', events: ['task.attention_required'], telegramSecret: { sha256: 'a'.repeat(64) } } as PrivateReceiver;
  const extraReceivers: PrivateReceiver[] = [];
  const call = vi.fn<TelegramCall>(async (method, _body, signal) => {
    if (method === 'getMe') return { id: Number(botId), username: 'test_bot', first_name: 'Test' };
    if (method === 'getUpdates') return new Promise(resolve => signal?.addEventListener('abort', () => resolve([]), { once: true }));
    return {};
  });
  const installationId = randomUUID();
  const options: any = { projectId: 'project', root: directory, installationId, directory, mode: 'local' as const,
    receivers: () => [receiver, ...extraReceivers], call: () => call, callToken: undefined, createReceiverFromToken: undefined, context: vi.fn(), deliver: vi.fn(), episode: () => undefined, changed() {}, now: () => now };
  const service = new TelegramInbound(options);
  cleanups.push(async () => { await service.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { service, receiver, call, botId, installationId, options, directory, extraReceivers, setNow: (value: number) => { now = value; } };
}
/** A bot token's view of a plain supergroup the bot belongs to. */
function groupTokenCall(botId: string) {
  return vi.fn<TelegramCall>(async (method, body, signal) => {
    if (method === 'getMe') return { id: Number(botId), username: 'test_bot' };
    if (method === 'getUpdates') return new Promise(resolve => signal?.addEventListener('abort', () => resolve([]), { once: true }));
    if (method === 'getChat') return { id: Number((body as { chat_id: string }).chat_id), type: 'supergroup' };
    if (method === 'getChatMember') return { user: { id: (body as { user_id: number }).user_id }, status: 'member' };
    return {};
  });
}
it('GET is read-only; explicit pairing discovers bot, confirmation grants only the configured private person', async () => {
  const { service, receiver, call } = await fixture();
  const before = service.list(); expect(call).not.toHaveBeenCalled();
  const pairing = await service.pair({ receiverId: receiver.id, expectedRevision: before.receivers[0]!.inboundRevision, dedicatedBot: true });
  expect(pairing.deepLink).toContain('https://t.me/test_bot?start=');
  expect(service.pairing(pairing.pairingId).status).toBe('waiting');
  const code = new URL(pairing.deepLink).searchParams.get('start');
  const bot = service.list().bots[0]!;
  service.pairings.accept(bot.botId, 'test_bot', { message_id: 1, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false }, text: `/start ${code}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  const candidate = service.pairing(pairing.pairingId);
  const result = await service.confirm(pairing.pairingId, { expectedRevision: candidate.inboundRevision, candidateUserId: '456' });
  expect(result.grant.permissions).toEqual(['respond']);
  expect(service.list().receivers[0]!.state).toBe('active');
  const revoked = await service.revoke(result.grant.id, result.inboundRevision);
  expect(revoked.revoked).toBe(true); expect(service.list().grants).toEqual([]);
  expect(service.list().receivers[0]!.state).toBe('disabled');
});
it('orchestrates private-chat setup without exposing credentials', async () => {
  const { service, receiver, botId } = await fixture();
  const begun = await service.beginSetup({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  expect(begun).toMatchObject({ receiverId: receiver.id, bot: { id: botId, username: 'test_bot' } });
  expect(JSON.stringify(begun)).not.toContain('a'.repeat(32));
  const code = new URL(begun.deepLink).searchParams.get('start');
  service.pairings.accept(botId, 'test_bot', { message_id: 1, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false, first_name: 'Person' },
    text: `/start ${code}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  const status = service.setupStatus(begun.setupId);
  expect(status).toEqual({ status: 'candidate', receiverId: receiver.id, bot: { id: botId, username: 'test_bot' }, inboundRevision: expect.any(String), candidate: { userId: '456', chatType: 'private', label: 'Person' } });
  const active = await service.activateSetup(begun.setupId, { activate: true, expectedRevision: status.inboundRevision,
    candidateUserId: '456', permissions: ['respond', 'continue'] });
  expect(active).toEqual({ grant: expect.objectContaining({ capability: 'task_control', permissions: ['respond', 'continue'] }), inboundRevision: expect.any(String) });
  expect(() => service.setupStatus(begun.setupId)).toThrow(expect.objectContaining({ code: 'pairing_expired' }));
});
it('starts token-led setup only after dedicated consent and persists the first private identity on activation', async () => {
  const x = await fixture();
  const token = `123456:${'A'.repeat(35)}`;
  const tokenCall = vi.fn<TelegramCall>(async (method, _body, signal) => {
    if (method === 'getMe') return { id: Number(x.botId), username: 'test_bot' };
    if (method === 'getUpdates') return new Promise(resolve => signal?.addEventListener('abort', () => resolve([]), { once: true }));
    return {};
  });
  x.options.callToken = () => tokenCall;
  const persisted = { ...x.receiver, id: randomUUID(), telegramChatId: '456', telegramSecret: { sha256: digestForTest(token) } } as PrivateReceiver;
  x.options.createReceiverFromToken = vi.fn(async () => { x.extraReceivers.push(persisted); return persisted; });
  const begun = await x.service.beginSetup({ token, name: 'Fresh bot', dedicatedBot: true });
  expect(tokenCall).toHaveBeenCalledWith('getMe', {});
  const code = new URL(begun.deepLink).searchParams.get('start');
  x.service.pairings.accept(x.botId, 'test_bot', { message_id: 1, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false }, text: `/start ${code}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  const status = x.service.setupStatus(begun.setupId);
  await x.service.activateSetup(begun.setupId, { activate: true, expectedRevision: status.inboundRevision, candidateUserId: '456', permissions: ['respond'] });
  expect(x.options.createReceiverFromToken).toHaveBeenCalledWith(token, 'Fresh bot', '456', undefined);
});
it('cleans up a temporary receiver and opened bot when token-led setup fails', async () => {
  const x = await fixture();
  const token = `123456:${'D'.repeat(35)}`;
  const tokenCall = vi.fn<TelegramCall>(async (method, _body, signal) => {
    if (method === 'getMe') return { id: Number(x.botId), username: 'test_bot' };
    if (method === 'getUpdates') return new Promise(resolve => signal?.addEventListener('abort', () => resolve([]), { once: true }));
    return {};
  });
  x.options.callToken = () => tokenCall;

  const pair = x.service.pair.bind(x.service);
  vi.spyOn(x.service, 'pair').mockImplementation(async input => { await pair(input); throw new Error('pair failed'); });
  await expect(x.service.beginSetup({ token, dedicatedBot: true })).rejects.toThrow('pair failed');
  expect((x.service as any).setup.temporaryReceivers()).toEqual([]);
  expect(x.service.list().receivers).toEqual([expect.objectContaining({ receiverId: x.receiver.id })]);
  expect(x.service.list().bots).toEqual([]);
  await expect(access(join(x.directory, `${x.botId}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('token-led setup discovers the real group chat and uses it for notification-only activation', async () => {
  const x = await fixture();
  const token = `123456:${'B'.repeat(35)}`;
  const tokenCall = groupTokenCall(x.botId);
  x.options.callToken = () => tokenCall;
  x.call.mockImplementation(async (method, body, signal) => {
    if (method === 'getChatMember') return { user: { id: (body as { user_id: number }).user_id }, status: 'member' };
    if (method === 'getUpdates') return new Promise(resolve => signal?.addEventListener('abort', () => resolve([]), { once: true }));
    return method === 'getMe' ? { id: Number(x.botId), username: 'test_bot' } : {};
  });
  const persisted = { ...x.receiver, id: randomUUID(), telegramChatId: '-1009876543210', telegramSecret: { sha256: digestForTest(token) } } as PrivateReceiver;
  x.options.createReceiverFromToken = vi.fn(async (_token, _name, chatId) => {
    persisted.telegramChatId = chatId;
    x.extraReceivers.push(persisted);
    return persisted;
  });
  const begun = await x.service.beginSetup({ token, name: 'Group bot', dedicatedBot: true });
  const code = new URL(begun.deepLink).searchParams.get('start');
  expect(x.service.pairings.accept(x.botId, 'test_bot', {
    message_id: 1, date: 10, chat: { id: -1009876543210, type: 'supergroup' },
    from: { id: 456, is_bot: false, first_name: 'Member' }, text: `/start ${code}`,
    entities: [{ type: 'bot_command', offset: 0, length: 6 }],
  })).toBe('candidate');
  const status = x.service.setupStatus(begun.setupId);
  expect(status.candidate).toMatchObject({ userId: '456', chatType: 'group', label: 'Member' });
  const active = await x.service.activateSetup(begun.setupId, {
    activate: true, taskControl: false, expectedRevision: status.inboundRevision, candidateUserId: '456', groupVisibilityAccepted: true,
  });
  expect(active.grant).toBeUndefined();
  expect(x.options.createReceiverFromToken).toHaveBeenCalledWith(token, 'Group bot', '-1009876543210', undefined);
  expect(x.service.list().receivers).toEqual(expect.arrayContaining([expect.objectContaining({ receiverId: persisted.id })]));
});
it('does not grant token-led group task control from the group Start alone', async () => {
  const x = await fixture();
  const token = `123456:${'C'.repeat(35)}`;
  const tokenCall = groupTokenCall(x.botId);
  x.options.callToken = () => tokenCall;
  x.call.mockImplementation(async (method, body, signal) => method === 'getChatMember'
    ? { user: { id: (body as { user_id: number }).user_id }, status: 'member' }
    : method === 'getUpdates' ? new Promise(resolve => signal?.addEventListener('abort', () => resolve([]), { once: true }))
    : method === 'getMe' ? { id: Number(x.botId), username: 'test_bot' } : {});
  const persisted = { ...x.receiver, id: randomUUID(), telegramChatId: '-1009876543210', telegramSecret: { sha256: digestForTest(token) } } as PrivateReceiver;
  x.options.createReceiverFromToken = vi.fn(async (_token, _name, chatId) => { persisted.telegramChatId = chatId; x.extraReceivers.push(persisted); return persisted; });
  const begun = await x.service.beginSetup({ token, name: 'Group control', dedicatedBot: true });
  const code = new URL(begun.deepLink).searchParams.get('start');
  expect(x.service.pairings.accept(x.botId, 'test_bot', { message_id: 1, date: 10, chat: { id: -1009876543210, type: 'supergroup' },
    from: { id: 456, is_bot: false, first_name: 'Member' }, text: `/start ${code}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] })).toBe('candidate');
  const status = x.service.setupStatus(begun.setupId);
  expect(status.candidate?.chatType).toBe('group');
  expect(status.candidate?.comparisonCode).toBeUndefined();
  expect(x.service.pairings.accept(x.botId, 'test_bot', { message_id: 2, date: 10, chat: { id: 456, type: 'private' },
    from: { id: 456, is_bot: false, first_name: 'Member' }, text: `/start ${code}`,
    entities: [{ type: 'bot_command', offset: 0, length: 6 }] })).toBe('candidate');
  const confirmedStatus = x.service.setupStatus(begun.setupId);
  expect(confirmedStatus.candidate).toMatchObject({ userId: '456', chatType: 'private', comparisonCode: expect.stringMatching(/^[0-9]{6}$/) });
  const active = await x.service.activateSetup(begun.setupId, { activate: true, expectedRevision: confirmedStatus.inboundRevision,
    candidateUserId: '456', permissions: ['respond'], comparisonVerified: true, groupVisibilityAccepted: true });
  expect(x.options.createReceiverFromToken).toHaveBeenCalledWith(token, 'Group control', '-1009876543210', undefined);
  expect(active.grant).toMatchObject({ chatId: '-1009876543210', userId: '456', capability: 'task_control' });
});
it('does not validate a token before dedicated-bot consent', async () => {
  const x = await fixture(); const tokenCall = vi.fn<TelegramCall>(); x.options.callToken = () => tokenCall;
  await expect(x.service.beginSetup({ token: `123456:${'A'.repeat(35)}`, dedicatedBot: false } as any)).rejects.toThrow();
  expect(tokenCall).not.toHaveBeenCalled();
});
it('can finish setup without granting task-control permissions', async () => {
  const x = await fixture();
  const begun = await x.service.beginSetup({ receiverId: x.receiver.id, expectedRevision: x.service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  const code = new URL(begun.deepLink).searchParams.get('start');
  x.service.pairings.accept(x.botId, 'test_bot', { message_id: 1, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false }, text: `/start ${code}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  const status = x.service.setupStatus(begun.setupId);
  const result = await x.service.activateSetup(begun.setupId, { activate: true, taskControl: false, expectedRevision: status.inboundRevision, candidateUserId: '456' });
  expect(result.grant).toBeUndefined(); expect(x.service.list().grants).toEqual([]);
});
it('runs a group receiver through the same setup: visibility consent, comparison code, membership', async () => {
  const x = await fixture();
  x.receiver.telegramChatId = '-123';
  x.call.mockImplementation((method, body, signal) => method === 'getChat' ? Promise.resolve({ id: -123, type: 'group' })
    : method === 'getChatMember' ? Promise.resolve({ user: { id: (body as { user_id: number }).user_id }, status: 'member' })
    : method === 'getMe' ? Promise.resolve({ id: Number(x.botId), username: 'test_bot', first_name: 'Test' })
    : method === 'getUpdates' ? new Promise(resolve => signal?.addEventListener('abort', () => resolve([]), { once: true })) : Promise.resolve({}));
  const input = () => ({ receiverId: x.receiver.id, expectedRevision: x.service.list().receivers[0]!.inboundRevision, dedicatedBot: true as const });
  await expect(x.service.beginSetup(input())).rejects.toMatchObject({ code: 'group_visibility_required' });
  const begun = await x.service.beginSetup({ ...input(), groupVisibilityAccepted: true });
  x.service.pairings.accept(x.botId, 'test_bot', { message_id: 1, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false, first_name: 'Member' },
    text: `/start ${new URL(begun.deepLink).searchParams.get('start')}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  const status = x.service.setupStatus(begun.setupId);
  expect(status.candidate).toMatchObject({ userId: '456', comparisonCode: expect.stringMatching(/^[0-9]{6}$/) });
  const activate = (comparisonVerified?: true) => x.service.activateSetup(begun.setupId, { activate: true, expectedRevision: status.inboundRevision,
    candidateUserId: '456', permissions: ['respond'], ...(comparisonVerified ? { comparisonVerified } : {}) });
  await expect(activate()).rejects.toMatchObject({ code: 'comparison_required' });
  const active = await activate(true);
  expect(active.grant).toMatchObject({ chatId: '-123', userId: '456', capability: 'task_control' });
  expect(x.call.mock.calls.filter(([method]) => method === 'getChatMember').map(([, body]) => (body as { user_id: number }).user_id)).toEqual([Number(x.botId), 456]);
});
it('keeps setup sessions in memory only: a restart expires them and nothing is written to disk', async () => {
  const x = await fixture();
  const begun = await x.service.beginSetup({ receiverId: x.receiver.id, expectedRevision: x.service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  x.service.pairings.accept(x.botId, 'test_bot', { message_id: 1, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false },
    text: `/start ${new URL(begun.deepLink).searchParams.get('start')}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  for (let poll = 0; poll < 3; poll++) expect(x.service.setupStatus(begun.setupId).status).toBe('candidate');
  await expect(access(join(x.directory, 'setups.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await x.service.dispose();
  const reopened = new TelegramInbound(x.options); cleanups.push(() => reopened.dispose());
  await reopened.load();
  expect(() => reopened.setupStatus(begun.setupId)).toThrow(expect.objectContaining({ code: 'pairing_expired' }));
  await expect(reopened.activateSetup(begun.setupId, { activate: true, expectedRevision: reopened.list().receivers[0]!.inboundRevision,
    candidateUserId: '456', permissions: ['respond'] })).rejects.toMatchObject({ code: 'pairing_expired' });
  expect(reopened.list().grants).toEqual([]);
});
it('maps invalid setup credentials and stale setup choices to actionable errors', async () => {
  const x = await fixture();
  x.call.mockRejectedValueOnce(new TelegramApiError('http', 401));
  await expect(x.service.beginSetup({ receiverId: x.receiver.id, expectedRevision: x.service.list().receivers[0]!.inboundRevision,
    dedicatedBot: true })).rejects.toMatchObject({ code: 'invalid_token' });
  expect(() => x.service.setupStatus(randomUUID())).toThrow(expect.objectContaining({ code: 'pairing_expired' }));
});
it('maps blocked, conflicted, vault-unavailable and damaged setup states distinctly', async () => {
  for (const [failure, expected] of [
    [new TelegramApiError('http', 403), 'blocked'],
    [new TelegramInboundFailure(409, 'revision_conflict'), 'conflict'],
    [new TelegramInboundFailure(409, 'replacement_required'), 'replacement_required'],
    [new TelegramInboundFailure(409, 'chat_conflict'), 'chat_conflict'],
    [new TelegramInboundFailure(503, 'credentials_unavailable'), 'vault_unavailable'],
    [new TelegramInboundFailure(409, 'reset_required'), 'damaged_state'],
  ] as const) {
    const x = await fixture();
    vi.spyOn(x.service, 'pair').mockRejectedValueOnce(failure);
    await expect(x.service.beginSetup({ receiverId: x.receiver.id, expectedRevision: x.service.list().receivers[0]!.inboundRevision,
      dedicatedBot: true })).rejects.toMatchObject({ code: expected });
  }
});
it('setup without the dedicated-bot acknowledgement is refused before any Telegram call', async () => {
  const x = await fixture();
  await expect(x.service.beginSetup({ receiverId: x.receiver.id, expectedRevision: x.service.list().receivers[0]!.inboundRevision } as never)).rejects.toBeInstanceOf(ZodError);
  expect(x.call).not.toHaveBeenCalled();
  expect(x.service.list()).toMatchObject({ bots: [], grants: [] });
});
it('still refuses a duplicate task-control approval', async () => {
  const x = await fixture();
  await paired(x);
  const pairing = await x.service.pair({ receiverId: x.receiver.id, expectedRevision: x.service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  x.service.pairings.accept(x.botId, 'test_bot', { message_id: 2, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false }, text: `/start ${new URL(pairing.deepLink).searchParams.get('start')}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  await expect(x.service.confirm(pairing.pairingId, { expectedRevision: x.service.pairing(pairing.pairingId).inboundRevision, candidateUserId: '456' }))
    .rejects.toMatchObject({ code: 'already_paired' });
});
it('enforces least privilege, cancellation and expiry cleanup of task-control setup', async () => {
  const x = await fixture();
  const setup = async () => x.service.beginSetup({ receiverId: x.receiver.id, expectedRevision: x.service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  const begun = await setup();
  x.service.pairings.accept(x.botId, 'test_bot', { message_id: 1, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false },
    text: `/start ${new URL(begun.deepLink).searchParams.get('start')}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  const status = x.service.setupStatus(begun.setupId);
  for (const permissions of [undefined, ['cancel']]) {
    await expect(x.service.activateSetup(begun.setupId, { activate: true, expectedRevision: status.inboundRevision,
      candidateUserId: '456', ...(permissions ? { permissions } : {}) } as never)).rejects.toBeInstanceOf(ZodError);
  }
  await x.service.cancelSetup(begun.setupId);
  expect(() => x.service.setupStatus(begun.setupId)).toThrow(expect.objectContaining({ code: 'pairing_expired' }));

  // Cancelled sessions free their slot: abandoning setup repeatedly never reaches pairing_limit.
  for (let attempt = 0; attempt < 4; attempt++) await x.service.cancelSetup((await setup()).setupId);

  const expiring = await setup();
  x.setNow(expiring.expiresAt + 1);
  expect(x.service.setupStatus(expiring.setupId).status).toBe('expired');
  x.setNow(expiring.expiresAt + 300_001);
  expect(() => x.service.setupStatus(expiring.setupId)).toThrow(expect.objectContaining({ code: 'pairing_expired' }));
});
it('rejects stale configuration and disabled flag before network or grant mutation', async () => {
  const { service, receiver, call } = await fixture(); const revision = service.list().receivers[0]!.inboundRevision;
  receiver.revision++;
  await expect(service.pair({ receiverId: receiver.id, expectedRevision: revision, dedicatedBot: true })).rejects.toMatchObject({ code: 'revision_conflict' });
  vi.stubEnv('CEZ_CHAT_INBOUND', '0');
  await expect(service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true })).rejects.toMatchObject({ code: 'flag_off' });
  expect(call).not.toHaveBeenCalled(); expect(service.list().available).toBe(false);
});
async function paired(x: Awaited<ReturnType<typeof fixture>>) {
  const pairing = await x.service.pair({ receiverId: x.receiver.id, expectedRevision: x.service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  x.service.pairings.accept(x.botId, 'test_bot', { message_id: 1, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false }, text: `/start ${new URL(pairing.deepLink).searchParams.get('start')}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  return x.service.confirm(pairing.pairingId, { expectedRevision: x.service.pairing(pairing.pairingId).inboundRevision, candidateUserId: '456' });
}
const internals = (service: TelegramInbound) => service as unknown as { bots: Map<string, { state: InboundStateStore; runtime?: { health(): { state: string } } }>; discovered: Map<string, string>; confirmed: Map<string, unknown> };
it('does not approve a candidate after the receiver changed or untrusted permissions were requested', async () => {
  const { service, receiver, botId } = await fixture();
  const pairing = await service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  service.pairings.accept(botId, 'test_bot', { message_id: 1, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false }, text: `/start ${new URL(pairing.deepLink).searchParams.get('start')}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  const revision = service.pairing(pairing.pairingId).inboundRevision;
  for (const permissions of [['cancel'], ['respond', 'respond'], ['respond', 'admin']]) {
    await expect(service.confirm(pairing.pairingId, { expectedRevision: revision, candidateUserId: '456', permissions: permissions as never })).rejects.toBeInstanceOf(ZodError);
  }
  await expect(service.confirm(pairing.pairingId, { expectedRevision: revision, candidateUserId: '789' })).rejects.toMatchObject({ code: 'pairing_changed' });
  receiver.telegramChatId = '789'; receiver.revision++;
  await expect(service.confirm(pairing.pairingId, { expectedRevision: revision, candidateUserId: '456' })).rejects.toMatchObject({ code: 'pairing_changed' });
  expect(service.list().grants).toEqual([]);
});
it('disabling preserves grants but re-enable advances the boundary; reset removes all access', async () => {
  const { service, receiver, installationId } = await fixture();
  const pairing = await service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  const bot = service.list().bots[0]!, code = new URL(pairing.deepLink).searchParams.get('start');
  service.pairings.accept(bot.botId, 'test_bot', { message_id: 1, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false }, text: `/start ${code}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  const confirmed = await service.confirm(pairing.pairingId, { expectedRevision: service.pairing(pairing.pairingId).inboundRevision, candidateUserId: '456' });
  const disabled = await service.setEnabled(receiver.id, { enabled: false, expectedRevision: confirmed.inboundRevision });
  expect(service.list().grants).toHaveLength(1); expect(service.list().receivers[0]!.state).toBe('disabled');
  const enabled = await service.setEnabled(receiver.id, { enabled: true, expectedRevision: disabled.inboundRevision });
  expect(service.list().grants[0]!.enableGeneration).not.toBe(confirmed.grant.enableGeneration);
  await service.reset(bot.botId, enabled.inboundRevision);
  expect(service.list().grants).toEqual([]); expect(service.list().receivers).toEqual([expect.objectContaining({ state: 'disabled' })]);
});
it('a delivered source final is not sent again after Disable, Enable and a restart', async () => {
  const x0 = await fixture(), dataDir = await mkdtemp(join(tmpdir(), 'telegram-service-final-'));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const runs = new Map<string, RunRecord>(), events = new EventEmitter();
  const project = { root: x0.directory, dataDir, store: { on: events.on.bind(events), off: events.off.bind(events), listRuns: () => [...runs.values()],
    getRun: (id: string) => runs.get(id), redactRunText: (_id: string, text: string) => text } };
  // Pairing uses the fixture's clock; then a running one, which the reply queue paces by and compaction ages receipts by.
  let running = false;
  const options = { ...x0.options, now: () => running ? Date.now() : 10_000, context: async () => project };
  const sent: string[] = [], original = x0.call.getMockImplementation()!;
  x0.call.mockImplementation((method, body, signal) => method === 'sendMessage'
    ? Promise.resolve((sent.push((body as { text: string }).text), { message_id: 100 + sent.length, chat: { id: 456 } }))
    : original(method, body, signal));
  const service = new TelegramInbound(options); cleanups.unshift(() => service.dispose());
  const approved = await paired({ ...x0, service, options });
  running = true;
  // Redaction reads every receiver's secret from its URL.
  x0.receiver.url = `https://api.telegram.org/bot${x0.botId}:${'A'.repeat(35)}/sendMessage`;
  const runId = `run-${randomInt(1e6)}`, grant = approved.grant, bot = internals(service).bots.get(x0.botId)!;
  const source = { id: randomUUID(), botId: x0.botId, epoch: bot.state.snapshot().epoch, projectId: 'project', receiverId: x0.receiver.id, grantId: grant.id,
    grantGeneration: grant.generation, enableGeneration: grant.enableGeneration, chatId: '456', userId: '456', sourceMessageId: 1, updateId: 1,
    episodeId: `${runId}-1`, requestId: randomUUID(), runId, state: 'finished' as const, createdAt: Date.now(), updatedAt: Date.now() };
  await bot.state.change(state => { state.sources.push(source); });
  await mkdir(join(dataDir, 'runs'), { recursive: true });
  await writeFile(join(dataDir, 'runs', `${runId}.ndjson`), JSON.stringify({ type: 'text', text: 'Deployed.', ts: new Date(Date.now() - 1000).toISOString() }) + '\n');
  runs.set(runId, { id: runId, title: 'Ship it', status: 'done', completionReason: 'completed', archived: false, steps: [], telegramSource: source } as unknown as RunRecord);
  const finals = () => sent.filter(text => text.includes('Task completed'));
  const reopen = async () => {
    await service.dispose();
    const next = new TelegramInbound(options); cleanups.unshift(() => next.dispose()); await next.load(); await next.start(); return next;
  };
  // The runtime starting over the durable source delivers its final.
  let current = await reopen();
  await vi.waitFor(() => expect(finals()).toHaveLength(1), { timeout: 8000 });
  await internals(current).bots.get(x0.botId)!.state.drain();
  const off = await current.setEnabled(x0.receiver.id, { enabled: false, expectedRevision: current.list().receivers[0]!.inboundRevision });
  await current.setEnabled(x0.receiver.id, { enabled: true, expectedRevision: off.inboundRevision });
  await internals(current).bots.get(x0.botId)!.state.drain();
  await current.dispose();
  current = new TelegramInbound(options); cleanups.unshift(() => current.dispose()); await current.load(); await current.start();
  await new Promise(resolve => setTimeout(resolve, 1500));
  expect(finals()).toHaveLength(1);
}, 20_000);
it.each([false, true])('a final the webhook delivered while replies were disabled is not sent again after Enable (restart before delivery: %s)', async restartFirst => {
  const x0 = await fixture(), dataDir = await mkdtemp(join(tmpdir(), 'telegram-service-disabled-'));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const runs = new Map<string, RunRecord>(), events = new EventEmitter();
  const project = { root: x0.directory, dataDir, store: { on: events.on.bind(events), off: events.off.bind(events), listRuns: () => [...runs.values()],
    getRun: (id: string) => runs.get(id), redactRunText: (_id: string, text: string) => text } };
  let running = false;
  const options = { ...x0.options, now: () => running ? Date.now() : 10_000, context: async () => project };
  const sent: string[] = [], original = x0.call.getMockImplementation()!;
  x0.call.mockImplementation((method, body, signal) => method === 'sendMessage'
    ? Promise.resolve((sent.push((body as { text: string }).text), { message_id: 100 + sent.length, chat: { id: 456 } }))
    : original(method, body, signal));
  const service = new TelegramInbound(options); cleanups.unshift(() => service.dispose());
  const approved = await paired({ ...x0, service, options });
  running = true;
  x0.receiver.url = `https://api.telegram.org/bot${x0.botId}:${'A'.repeat(35)}/sendMessage`;
  let current = service;
  const reopen = async () => {
    await current.dispose();
    current = new TelegramInbound(options); cleanups.unshift(() => current.dispose()); await current.load(); await current.start();
  };
  const off = await current.setEnabled(x0.receiver.id, { enabled: false, expectedRevision: current.list().receivers[0]!.inboundRevision });
  const runId = `run-${randomInt(1e6)}`, grant = approved.grant, bot = internals(current).bots.get(x0.botId)!;
  const source = { id: randomUUID(), botId: x0.botId, epoch: bot.state.snapshot().epoch, projectId: 'project', receiverId: x0.receiver.id, grantId: grant.id,
    grantGeneration: grant.generation, enableGeneration: grant.enableGeneration, chatId: '456', userId: '456', sourceMessageId: 1, updateId: 1,
    episodeId: `${runId}-1`, requestId: randomUUID(), runId, state: 'finished' as const, createdAt: Date.now(), updatedAt: Date.now() };
  await bot.state.change(state => { state.sources.push(source); });
  await mkdir(join(dataDir, 'runs'), { recursive: true });
  await writeFile(join(dataDir, 'runs', `${runId}.ndjson`), JSON.stringify({ type: 'text', text: 'Deployed.', ts: new Date(Date.now() - 1000).toISOString() }) + '\n');
  runs.set(runId, { id: runId, title: 'Ship it', status: 'done', completionReason: 'completed', archived: false, steps: [], telegramSource: source } as unknown as RunRecord);
  await bot.state.drain();
  // A disabled bot is not opened at boot; its receipt still has to land.
  if (restartFirst) await reopen();
  const webhookFinal = { projectId: 'project', installationId: x0.installationId, type: 'task.finished', sequence: 3, episodeId: `${runId}-1`,
    snapshot: { id: runId, status: 'done', continuation: 0 } } as import('../webhooks/source.ts').WebhookSource;
  expect(await current.recordDelivery(webhookFinal, x0.receiver.id, x0.receiver.deliveryRevision, { messageId: 50, chatId: '456' })).toBe(true);
  // A question is never stored while disabled: Enable re-asks it with a routable notice.
  const question = { ...webhookFinal, type: 'task.attention_required', sequence: 4 } as import('../webhooks/source.ts').WebhookSource;
  expect(await current.recordDelivery(question, x0.receiver.id, x0.receiver.deliveryRevision, { messageId: 51, chatId: '456' })).toBe(false);
  await current.setEnabled(x0.receiver.id, { enabled: true, expectedRevision: current.list().receivers[0]?.inboundRevision ?? off.inboundRevision });
  await new Promise(resolve => setTimeout(resolve, 1500));
  await reopen();
  await new Promise(resolve => setTimeout(resolve, 1500));
  expect(sent.filter(text => text.includes('Task completed'))).toEqual([]);
  expect(internals(current).bots.get(x0.botId)!.state.snapshot().correlations.some(row => row.messageId === 51)).toBe(false);
}, 20_000);
it('permission edits move the freshness boundary of that grant only', async () => {
  const { service, receiver, botId, setNow } = await fixture();
  const first = await service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  const start = new URL(first.deepLink).searchParams.get('start');
  service.pairings.accept(botId, 'test_bot', { message_id: 1, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false }, text: `/start ${start}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  const approved = await service.confirm(first.pairingId, { expectedRevision: service.pairing(first.pairingId).inboundRevision, candidateUserId: '456' });
  setNow(20_000);
  const changed = await service.permissions(approved.grant.id, { expectedRevision: approved.inboundRevision, permissions: ['respond', 'continue'] });
  expect(service.list().grants[0]!.generation).not.toBe(approved.grant.generation);
  const stateBefore = internals(service).bots.get(botId)!.state.snapshot();
  expect(stateBefore.receivers[0]!.acceptAfter).toBe(10_000); expect(stateBefore.grants[0]!.approvedAt).toBe(20_000);
  expect(grantFresh(stateBefore, stateBefore.grants[0]!, 15, 20_000)).toBe(false);
});
it('can pair again after explicit disconnect without restoring any old grants', async () => {
  const { service, receiver } = await fixture();
  await service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  const bot = service.list().bots[0]!;
  await service.disconnect(bot.botId, bot.inboundRevision!);
  expect(service.list().bots).toEqual([]);
  const next = await service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  expect(next.deepLink).toContain('https://t.me/');
  expect(service.list().grants).toEqual([]);
});
it('keeps outbound message correlation only for a matching enabled receiver generation', async () => {
  const { service, receiver, installationId } = await fixture();
  const pairing = await service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  const bot = service.list().bots[0]!, code = new URL(pairing.deepLink).searchParams.get('start');
  service.pairings.accept(bot.botId, 'test_bot', { message_id: 1, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false }, text: `/start ${code}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  await service.confirm(pairing.pairingId, { expectedRevision: service.pairing(pairing.pairingId).inboundRevision, candidateUserId: '456' });
  const source = { projectId: 'project', installationId, type: 'task.attention_required', sequence: 1, episodeId: 'task-1', snapshot: { id: 'task', status: 'waiting', continuation: 0 } } as import('../webhooks/source.ts').WebhookSource;
  expect(await service.recordDelivery(source, receiver.id, receiver.deliveryRevision, { messageId: 5, chatId: '789' })).toBe(false);
  expect(await service.recordDelivery(source, receiver.id, receiver.deliveryRevision + 1, { messageId: 5, chatId: '456' })).toBe(false);
  expect(await service.recordDelivery(source, receiver.id, receiver.deliveryRevision, { messageId: 5, chatId: '456' })).toBe(true);
  receiver.revision++; receiver.deliveryRevision++;
  expect(await service.recordDelivery(source, receiver.id, receiver.deliveryRevision - 1, { messageId: 6, chatId: '456' })).toBe(false);
});

it.each(['missing', 'corrupt', 'oversized'] as const)('shows %s state as blocked and resets only after explicit revision confirmation', async fault => {
  const { writeFile, readFile } = await import('node:fs/promises');
  const { service, receiver, botId, options, directory, call } = await fixture();
  await service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  await service.dispose();
  const path = join(directory, `${botId}.json`);
  if (fault === 'missing') await rm(path);
  else await writeFile(path, fault === 'corrupt' ? '{broken' : Buffer.alloc(3 * 1024 * 1024, 1));
  const reopened = new TelegramInbound(options);
  cleanups.unshift(() => reopened.dispose());
  call.mockClear(); await reopened.load(); await reopened.start();
  expect(call).not.toHaveBeenCalled(); expect(reopened.list().grants).toEqual([]);
  const row = reopened.list().bots.find(row => row.botId === botId)!;
  expect(row.health.state).toBe('blocked'); expect(row.inboundRevision).toMatch(/^[a-f0-9]{64}$/);
  await expect(reopened.reset(botId, '0'.repeat(64))).rejects.toMatchObject({ code: 'revision_conflict' });
  await reopened.reset(botId, row.inboundRevision!);
  expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ grants: [], receivers: [], nextOffset: null, phase: 'probing' });
  expect(call).not.toHaveBeenCalled(); expect(reopened.list().bots[0]!.health.state).toBe('stopped');
});
it('refuses damaged-state reset if the bytes change after the displayed revision', async () => {
  const { writeFile, readFile } = await import('node:fs/promises');
  const { service, receiver, botId, options, directory } = await fixture();
  await service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true }); await service.dispose();
  const path = join(directory, `${botId}.json`); await writeFile(path, '{broken');
  const reopened = new TelegramInbound(options); cleanups.unshift(() => reopened.dispose()); await reopened.load();
  const revision = reopened.list().bots[0]!.inboundRevision!;
  await writeFile(path, '{changed');
  await expect(reopened.reset(botId, revision)).rejects.toMatchObject({ code: 'revision_conflict' });
  expect(await readFile(path, 'utf8')).toBe('{changed');
  await reopened.refreshDiagnostics();
  const refreshed = reopened.list().bots[0]!.inboundRevision!; expect(refreshed).not.toBe(revision);
  await reopened.reset(botId, refreshed);
});
it('can explicitly reset a live store blocked by a failed write without releasing ownership early', async () => {
  const { service, receiver, botId } = await fixture();
  await service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  const state = (service as unknown as { bots: Map<string, { state: import('./state.ts').InboundStateStore }> }).bots.get(botId)!.state;
  const dependencies = (state as unknown as { dependencies: { write(value: unknown): Promise<void> } }).dependencies;
  const write = vi.spyOn(dependencies, 'write').mockRejectedValueOnce(new Error('disk unavailable'));
  await expect(state.change(() => {})).rejects.toThrow('disk unavailable'); write.mockRestore();
  await service.refreshDiagnostics();
  const bot = service.list().bots[0]!; expect(bot.health.state).toBe('blocked');
  await service.reset(botId, bot.inboundRevision!);
  expect(service.list().bots[0]!.health.state).toBe('stopped'); expect(service.list().grants).toEqual([]);
});
it('coalesces overlapping lifecycle starts into one bot identity check and poller', async () => {
  const { service, receiver, botId, options, call } = await fixture();
  const paired = await service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  const code = new URL(paired.deepLink).searchParams.get('start');
  service.pairings.accept(botId, 'test_bot', { message_id: 1, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false }, text: `/start ${code}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  await service.confirm(paired.pairingId, { expectedRevision: service.pairing(paired.pairingId).inboundRevision, candidateUserId: '456' }); await service.dispose();
  const reopened = new TelegramInbound(options); cleanups.unshift(() => reopened.dispose()); await reopened.load(); call.mockClear();
  let finish!: (value: unknown) => void;
  call.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const first = reopened.start(), second = reopened.start();
  await vi.waitFor(() => expect(finish).toBeDefined());
  expect(call.mock.calls.filter(([method]) => method === 'getMe')).toHaveLength(1);
  finish({ id: Number(botId), username: 'test_bot' });
  await Promise.all([first, second]);
  expect(call.mock.calls.filter(([method]) => method === 'getMe')).toHaveLength(1);
});
it('replaces a changed chat only through fresh pairing and removes the old grant', async () => {
  const { service, receiver, botId } = await fixture();
  const first = await service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  const code = new URL(first.deepLink).searchParams.get('start');
  service.pairings.accept(botId, 'test_bot', { message_id: 1, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false }, text: `/start ${code}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  await service.confirm(first.pairingId, { expectedRevision: service.pairing(first.pairingId).inboundRevision, candidateUserId: '456' });
  receiver.telegramChatId = '789'; receiver.revision++; receiver.deliveryRevision++;
  await service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true, replaceExisting: true });
  expect(service.list().grants).toEqual([]); expect(service.list().receivers[0]!.state).toBe('pairing');
});
it.each([false, true])('changed bot never inherits authorization, including target-write failure=%s', async failTargetWrite => {
  const { service, receiver, call, botId } = await fixture();
  const first = await service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  const code = new URL(first.deepLink).searchParams.get('start');
  service.pairings.accept(botId, 'test_bot', { message_id: 1, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false }, text: `/start ${code}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  await service.confirm(first.pairingId, { expectedRevision: service.pairing(first.pairingId).inboundRevision, candidateUserId: '456' });
  receiver.revision++; receiver.deliveryRevision++; receiver.telegramSecret!.sha256 = 'b'.repeat(64);
  const replacementId = Number(botId) + 100000000;
  call.mockImplementation(async (method, _body, signal) => method === 'getMe' ? { id: replacementId, username: 'replacement_bot' }
    : method === 'getUpdates' ? new Promise(resolve => signal?.addEventListener('abort', () => resolve([]), { once: true })) : {});
  await expect(service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true, replaceExisting: true })).rejects.toMatchObject({ code: 'revision_required' });
  const current = service.list().receivers[0]!;
  expect(current.botId).toBe(botId); expect(service.list().grants).toHaveLength(1);
  if (failTargetWrite) {
    const target = (service as unknown as { bots: Map<string, { state: import('./state.ts').InboundStateStore }> }).bots.get(String(replacementId))!;
    const dependencies = (target.state as unknown as { dependencies: { write(value: unknown): Promise<void> } }).dependencies;
    const write = vi.spyOn(dependencies, 'write').mockRejectedValueOnce(new Error('target disk failure'));
    await expect(service.pair({ receiverId: receiver.id, expectedRevision: current.inboundRevision, dedicatedBot: true, replaceExisting: true })).rejects.toThrow('target disk failure');
    write.mockRestore();
    expect(service.list().grants).toEqual([]);
    await service.refreshDiagnostics();
    expect(service.list().bots.find(bot => bot.botId === String(replacementId))!.health.state).toBe('blocked');
    return;
  }
  const paired = await service.pair({ receiverId: receiver.id, expectedRevision: current.inboundRevision, dedicatedBot: true, replaceExisting: true });
  expect(service.list().receivers[0]!.botId).toBe(String(replacementId)); expect(service.list().grants).toEqual([]);
  expect(paired.deepLink).toContain('replacement_bot');
});
it('turning off inbound aborts the pending poll while preserving approved people', async () => {
  const { service, receiver, botId, call, options } = await fixture();
  let aborted = false;
  call.mockImplementation(async (method, _body, signal) => {
    if (method === 'getMe') return { id: Number(botId), username: 'test_bot' };
    if (method === 'getUpdates') return new Promise(resolve => signal?.addEventListener('abort', () => { aborted = true; resolve([]); }, { once: true }));
    return {};
  });
  const pairing = await service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  service.pairings.accept(botId, 'test_bot', { message_id: 1, date: 10, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false }, text: `/start ${new URL(pairing.deepLink).searchParams.get('start')}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  await service.confirm(pairing.pairingId, { expectedRevision: service.pairing(pairing.pairingId).inboundRevision, candidateUserId: '456' });
  await vi.waitFor(() => expect(call.mock.calls.some(([method]) => method === 'getUpdates')).toBe(true));
  vi.stubEnv('CEZ_CHAT_INBOUND', '0');
  await vi.waitFor(() => expect(aborted).toBe(true), { timeout: 2500 });
  expect(service.list().grants).toHaveLength(1); expect(service.list().available).toBe(false);
  expect(options.context).not.toHaveBeenCalled(); expect(options.deliver).not.toHaveBeenCalled();
});
it('requires group disclosure and comparison, preserves the first person when adding another, and changes permissions per person', async () => {
  const { service, receiver, call, botId } = await fixture(); receiver.telegramChatId = '-123';
  const original = call.getMockImplementation()!;
  let candidateMember = true;
  call.mockImplementation((method, body, signal) => method === 'getChat' ? Promise.resolve({ id: -123, type: 'group' })
    : method === 'getChatMember' ? Promise.resolve({ user: { id: Number((body as { user_id?: number }).user_id) }, status: Number((body as { user_id?: number }).user_id) === 456 && !candidateMember ? 'left' : 'member' }) : original(method, body, signal));
  const input = () => ({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true as const });
  await expect(service.pair(input())).rejects.toMatchObject({ code: 'group_visibility_required' });
  const pair = async (userId: number) => {
    const pairing = await service.pair({ ...input(), groupVisibilityAccepted: true });
    service.pairings.accept(botId, 'test_bot', { message_id: userId, date: 10, chat: { id: userId, type: 'private' }, from: { id: userId, is_bot: false }, text: `/start ${new URL(pairing.deepLink).searchParams.get('start')}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
    return pairing;
  };
  const first = await pair(456), candidate = service.pairing(first.pairingId);
  expect(candidate.candidate?.comparisonCode).toMatch(/^[0-9]{6}$/);
  await expect(service.confirm(first.pairingId, { expectedRevision: candidate.inboundRevision, candidateUserId: '456' })).rejects.toMatchObject({ code: 'comparison_required' });
  candidateMember = false;
  await expect(service.confirm(first.pairingId, { expectedRevision: candidate.inboundRevision, candidateUserId: '456', comparisonVerified: true })).rejects.toMatchObject({ code: 'candidate_not_group_member' });
  candidateMember = true;
  const approved = await service.confirm(first.pairingId, { expectedRevision: candidate.inboundRevision, candidateUserId: '456', comparisonVerified: true });
  expect(approved.grant.chatId).toBe('-123');
  const second = await pair(789);
  await service.confirm(second.pairingId, { expectedRevision: service.pairing(second.pairingId).inboundRevision, candidateUserId: '789', comparisonVerified: true, permissions: ['respond', 'cancel'] });
  expect(service.list().grants).toHaveLength(2);
  expect(service.list().grants[0]!.enableGeneration).toBe(service.list().grants[1]!.enableGeneration);
  const modified = await service.permissions(approved.grant.id, { expectedRevision: service.list().receivers[0]!.inboundRevision, permissions: ['respond', 'continue'] });
  expect(modified.grant.generation).not.toBe(approved.grant.generation);
  expect(service.list().grants.find(grant => grant.userId === '789')!.permissions).toEqual(['respond', 'cancel']);
  await service.revoke(approved.grant.id, modified.inboundRevision);
  expect(service.list().receivers[0]!.state).toBe('active'); expect(service.list().grants).toHaveLength(1);
});
it('shares only a verified bot budget and retains its cooldown through runtime restart', async () => {
  const { service, receiver } = await fixture();
  expect(service.sendBudget(receiver)).toBeUndefined();
  const pairing = await service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  const budget = service.sendBudget(receiver)!;
  expect(budget).toBeDefined();
  expect(service.sendBudget({ ...receiver, id: randomUUID(), telegramChatId: '789' })).toBe(budget);
  expect(service.sendBudget({ ...receiver, telegramSecret: { ...receiver.telegramSecret!, sha256: 'b'.repeat(64) } })).toBeUndefined();
  budget.cooldown(100_000);
  await service.cancelSetup(pairing.pairingId);
  await service.pair({ receiverId: receiver.id, expectedRevision: service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  expect(service.sendBudget(receiver)).toBe(budget);
  budget.offer({ id: 'waiting', chat: '456', readyAt: 0, expiresAt: 200_000, valid: () => true });
  expect(budget.take('waiting')).toBe(false);
});
it('disconnect removes state before the binding; a failed binding removal stays resettable and a retry finishes', async () => {
  const { existsSync } = await import('node:fs');
  const x = await fixture(); await paired(x);
  const bot = x.service.list().bots[0]!, path = join(x.directory, `${x.botId}.json`), binding = join(botDirectory(x.botId), 'binding.json');
  const disconnect = vi.spyOn(BotLease.prototype, 'disconnect').mockRejectedValueOnce(Object.assign(new Error('EIO'), { code: 'EIO' }));
  await expect(x.service.disconnect(bot.botId, bot.inboundRevision!)).rejects.toMatchObject({ code: 'EIO' });
  disconnect.mockRestore();
  expect(existsSync(path)).toBe(false); expect(existsSync(binding)).toBe(true);
  const damaged = x.service.list().bots.find(row => row.botId === x.botId)!;
  expect(damaged.health.state).toBe('blocked'); expect(damaged.inboundRevision).toMatch(/^[a-f0-9]{64}$/);
  await x.service.disconnect(x.botId, damaged.inboundRevision!);
  expect(existsSync(binding)).toBe(false); expect(x.service.list().bots).toEqual([]);
  await x.service.pair({ receiverId: x.receiver.id, expectedRevision: x.service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  expect(x.service.list().grants).toEqual([]);
});
it('pairing replaces a state file stranded without its binding instead of refusing forever', async () => {
  const x = await fixture(); await paired(x); await x.service.dispose();
  await rm(join(botDirectory(x.botId), 'binding.json'));
  const reopened = new TelegramInbound(x.options); cleanups.unshift(() => reopened.dispose()); await reopened.load();
  const pairing = await reopened.pair({ receiverId: x.receiver.id, expectedRevision: reopened.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  expect(pairing.deepLink).toContain('https://t.me/test_bot'); expect(reopened.list().grants).toEqual([]);
});
it('a provider conflict is never restarted by the lifecycle tick, only by an explicit enable', async () => {
  const x = await fixture(), original = x.call.getMockImplementation()!;
  let conflict = false;
  x.call.mockImplementation((method, body, signal) => conflict && method === 'getUpdates' ? Promise.reject(new TelegramApiError('http', 409)) : original(method, body, signal));
  const approved = await paired(x);
  await vi.waitFor(() => expect(x.call.mock.calls.some(([method]) => method === 'getUpdates')).toBe(true));
  // Force the live poll to fail with 409 on its next round.
  conflict = true; const bot = internals(x.service).bots.get(x.botId)!;
  await x.service.setEnabled(x.receiver.id, { enabled: false, expectedRevision: approved.inboundRevision });
  const disabled = x.service.list().receivers[0]!.inboundRevision;
  const enabled = await x.service.setEnabled(x.receiver.id, { enabled: true, expectedRevision: disabled });
  await vi.waitFor(() => expect(bot.runtime!.health().state).toBe('conflict'));
  expect(x.service.list().receivers[0]!.state).toBe('conflict');
  const identities = () => x.call.mock.calls.filter(([method]) => method === 'getMe').length, before = identities();
  await x.service.start(); await x.service.start();
  expect(identities()).toBe(before); expect(bot.runtime!.health().state).toBe('conflict');
  conflict = false;
  const off = await x.service.setEnabled(x.receiver.id, { enabled: false, expectedRevision: enabled.inboundRevision });
  await x.service.setEnabled(x.receiver.id, { enabled: true, expectedRevision: off.inboundRevision });
  expect(identities()).toBeGreaterThan(before);
  await vi.waitFor(() => expect(x.service.list().receivers[0]!.state).toBe('active'));
});
it('persists a fatal conflict across reload until explicit recovery', async () => {
  const x = await fixture(), original = x.call.getMockImplementation()!;
  let conflict = false;
  x.call.mockImplementation((method, body, signal) => conflict && method === 'getUpdates' ? Promise.reject(new TelegramApiError('http', 409)) : original(method, body, signal));
  const approved = await paired(x);
  const disabled = await x.service.setEnabled(x.receiver.id, { enabled: false, expectedRevision: approved.inboundRevision });
  conflict = true;
  await x.service.setEnabled(x.receiver.id, { enabled: true, expectedRevision: disabled.inboundRevision });
  await vi.waitFor(() => expect(x.service.list().receivers[0]!.state).toBe('conflict'));
  await internals(x.service).bots.get(x.botId)!.state.drain();
  await x.service.dispose();
  const reopened = new TelegramInbound(x.options); cleanups.unshift(() => reopened.dispose()); await reopened.load();
  expect(reopened.list().receivers[0]!.state).toBe('conflict');
  const before = x.call.mock.calls.filter(([method]) => method === 'getMe').length;
  await reopened.start();
  expect(x.call.mock.calls.filter(([method]) => method === 'getMe')).toHaveLength(before);
  conflict = false;
  const off = await reopened.setEnabled(x.receiver.id, { enabled: false, expectedRevision: reopened.list().receivers[0]!.inboundRevision });
  await reopened.setEnabled(x.receiver.id, { enabled: true, expectedRevision: off.inboundRevision });
  await vi.waitFor(() => expect(reopened.list().receivers[0]!.state).toBe('active'));
  void approved;
});
it('classifies a startup credential failure and does not retry it automatically', async () => {
  const x = await fixture(), original = x.call.getMockImplementation()!;
  const approved = await paired(x);
  const off = await x.service.setEnabled(x.receiver.id, { enabled: false, expectedRevision: approved.inboundRevision });
  let getMeCalls = 0;
  x.call.mockImplementation((method, body, signal) => method === 'getMe'
    ? (getMeCalls++ === 0 ? original(method, body, signal) : Promise.reject(new TelegramApiError('http', 401)))
    : original(method, body, signal));
  await x.service.setEnabled(x.receiver.id, { enabled: true, expectedRevision: off.inboundRevision });
  await vi.waitFor(() => expect(x.service.list().receivers[0]!.state).toBe('credentials-unavailable'));
  const attempts = x.call.mock.calls.filter(([method]) => method === 'getMe').length;
  await x.service.start(); await x.service.start();
  expect(x.call.mock.calls.filter(([method]) => method === 'getMe')).toHaveLength(attempts);
});
it('reports an approved receiver without a running consumer as stopped', async () => {
  const x = await fixture(); await paired(x); await x.service.dispose();
  const reopened = new TelegramInbound(x.options); cleanups.unshift(() => reopened.dispose()); await reopened.load();
  expect(reopened.list().receivers[0]!.state).toBe('stopped');
});
it('hosted mode answers empty at the service level and never touches Telegram', async () => {
  const x = await fixture(), hosted = new TelegramInbound({ ...x.options, mode: 'hosted' }); cleanups.unshift(() => hosted.dispose());
  await hosted.load(); await hosted.start();
  expect(hosted.list()).toMatchObject({ available: false, reason: 'hosted' });
  await expect(hosted.pair({ receiverId: x.receiver.id, expectedRevision: hosted.list().receivers[0]!.inboundRevision, dedicatedBot: true })).rejects.toMatchObject({ status: 503, code: 'hosted' });
  expect(hosted.activity({ limit: 50 })).toEqual({ entries: [] });
  expect(() => hosted.pairing(randomUUID())).toThrow(expect.objectContaining({ status: 404, code: 'pairing_expired' }));
  expect(hosted.sendBudget(x.receiver)).toBeUndefined(); expect(x.call).not.toHaveBeenCalled();
});
it('flag-off hides stored activity and pairing status', async () => {
  const x = await fixture();
  const pairing = await x.service.pair({ receiverId: x.receiver.id, expectedRevision: x.service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  await internals(x.service).bots.get(x.botId)!.state.finish(internals(x.service).bots.get(x.botId)!.state.snapshot().epoch, 1,
    { id: randomUUID(), epoch: internals(x.service).bots.get(x.botId)!.state.snapshot().epoch, updateId: 1, at: 10_000, botId: x.botId, kind: 'reply', state: 'accepted', reason: 'delivered', chatId: '456', userId: '456', runId: 'run' });
  expect(x.service.activity({ limit: 50 }).entries).toHaveLength(1);
  vi.stubEnv('CEZ_CHAT_INBOUND', '0');
  expect(x.service.activity({ limit: 50 })).toEqual({ entries: [] });
  expect(() => x.service.pairing(pairing.pairingId)).toThrow(expect.objectContaining({ code: 'pairing_expired' }));
});
it('a read-only home degrades pairing to a refusal without breaking status or start', async () => {
  const { chmod, mkdir } = await import('node:fs/promises');
  const x = await fixture(), home = join(x.directory, 'readonly-home');
  await mkdir(home); await chmod(home, 0o500); vi.stubEnv('CEZ_HOME', home);
  try {
    await x.service.load(); await x.service.start();
    await expect(x.service.pair({ receiverId: x.receiver.id, expectedRevision: x.service.list().receivers[0]!.inboundRevision, dedicatedBot: true })).rejects.toMatchObject({ code: 'EACCES' });
    expect(x.service.list()).toMatchObject({ available: true, receivers: [expect.objectContaining({ state: 'disabled' })], grants: [] });
  } finally { await chmod(home, 0o700); }
});
it('refuses a state file copied from another project root as foreign', async () => {
  const { copyFile, mkdtemp: temp } = await import('node:fs/promises');
  const x = await fixture(); await paired(x); await x.service.dispose();
  const other = await temp(join(tmpdir(), 'telegram-copy-')); cleanups.push(() => rm(other, { recursive: true, force: true }));
  await copyFile(join(x.directory, `${x.botId}.json`), join(other, `${x.botId}.json`));
  const copied = new TelegramInbound({ ...x.options, root: other, directory: other }); cleanups.unshift(() => copied.dispose());
  await copied.load();
  expect(copied.list().grants).toEqual([]);
  await expect(copied.pair({ receiverId: x.receiver.id, expectedRevision: copied.list().receivers[0]!.inboundRevision, dedicatedBot: true })).rejects.toMatchObject({ code: 'foreign_state' });
});
it('a same-bot token rotation suspends access until re-enabled, which keeps the approved people', async () => {
  const x = await fixture(), approved = await paired(x);
  x.receiver.telegramSecret = { ...x.receiver.telegramSecret!, sha256: 'b'.repeat(64) }; x.receiver.revision++;
  expect(x.service.sendBudget(x.receiver)).toBeUndefined();
  const off = await x.service.setEnabled(x.receiver.id, { enabled: false, expectedRevision: x.service.list().receivers[0]!.inboundRevision });
  await x.service.setEnabled(x.receiver.id, { enabled: true, expectedRevision: off.inboundRevision });
  expect(x.service.list().grants).toEqual([expect.objectContaining({ id: approved.grant.id, userId: '456' })]);
  expect(internals(x.service).bots.get(x.botId)!.state.snapshot().receivers[0]!.credentialFingerprint).toBe('b'.repeat(64));
  expect(x.service.sendBudget(x.receiver)).toBeDefined();
});
// Status and the Reply hint share authorize()'s binding check: neither may promise a Reply authorize() would refuse.
it('a stale binding hides the Reply hint, and a rotated token reads as suspended', async () => {
  const x = await fixture(); await paired(x);
  await vi.waitFor(() => expect(x.service.repliesActive(x.receiver)).toBe(true));
  x.receiver.deliveryRevision++;
  expect(x.service.repliesActive(x.receiver)).toBe(false);
  x.receiver.deliveryRevision--; x.receiver.profile = 'minimal';
  expect(x.service.repliesActive(x.receiver)).toBe(false);
  x.receiver.profile = 'standard'; x.receiver.telegramSecret = { ...x.receiver.telegramSecret!, sha256: 'b'.repeat(64) };
  expect(x.service.list().receivers[0]!.state).toBe('suspended');
  expect(x.service.repliesActive(x.receiver)).toBe(false);
});
it('a Minimal profile suspends inbound in the status list; outbound-only suspension does not', async () => {
  const x = await fixture(); await paired(x);
  await vi.waitFor(() => expect(x.service.list().receivers[0]!.state).toBe('active'));
  x.receiver.state = 'suspended';
  expect(x.service.list().receivers[0]!.state).toBe('active');
  x.receiver.state = 'active'; x.receiver.profile = 'minimal';
  expect(x.service.list().receivers[0]!.state).toBe('suspended');
});
it('marks as pairing only the receiver actually being paired', async () => {
  const x = await fixture(), second = { ...x.receiver, id: randomUUID(), telegramChatId: '789' } as PrivateReceiver;
  x.options.receivers = () => [x.receiver, second];
  const first = await x.service.pair({ receiverId: x.receiver.id, expectedRevision: x.service.list().receivers[0]!.inboundRevision, dedicatedBot: true });
  const revision = () => x.service.list().receivers.find(row => row.receiverId === second.id)!.inboundRevision;
  await expect(x.service.pair({ receiverId: second.id, expectedRevision: revision(), dedicatedBot: true })).rejects.toMatchObject({ code: 'revision_required' });
  await x.service.pair({ receiverId: second.id, expectedRevision: revision(), dedicatedBot: true });
  await x.service.cancelSetup(first.pairingId);
  const states = Object.fromEntries(x.service.list().receivers.map(row => [row.receiverId, row.state]));
  expect(states).toEqual({ [x.receiver.id]: 'disabled', [second.id]: 'pairing' });
});
it('reset holds maintenance, so no send budget is lent mid-reset', async () => {
  const x = await fixture(); await paired(x);
  const bot = x.service.list().bots[0]!, state = internals(x.service).bots.get(x.botId)!.state, change = state.change.bind(state);
  let lent: unknown = 'unobserved';
  vi.spyOn(state, 'change').mockImplementation(mutation => { lent = x.service.sendBudget(x.receiver); return change(mutation); });
  await x.service.reset(bot.botId, bot.inboundRevision!);
  expect(lent).toBeUndefined(); expect(x.service.sendBudget(x.receiver)).toBeDefined();
});
it('forgets discovery and confirmation bookkeeping for a deleted receiver', async () => {
  const x = await fixture(); await paired(x);
  expect(internals(x.service).discovered.size).toBe(1); expect(internals(x.service).confirmed.size).toBe(1);
  x.options.receivers = () => [];
  x.service.list();
  expect(internals(x.service).discovered.size).toBe(0); expect(internals(x.service).confirmed.size).toBe(0);
});
it('owns a Telegram-started run\'s source chat only while the live runtime will deliver it (G1)', async () => {
  const x = await fixture(); const { grant } = await paired(x);
  const bot = internals(x.service).bots.get(x.botId)! as unknown as { runtime: { health(): { state: string }; deliversSource(run: unknown): boolean } };
  await vi.waitFor(() => expect(bot.runtime.health().state).toBe('polling'));
  const delivers = vi.spyOn(bot.runtime, 'deliversSource').mockReturnValue(true);
  const run = { id: randomUUID(), telegramSource: { id: randomUUID(), botId: x.botId, epoch: randomUUID(), projectId: 'project', receiverId: x.receiver.id,
    grantId: grant.id, grantGeneration: grant.generation, enableGeneration: grant.enableGeneration, chatId: '456', userId: '456', sourceMessageId: 1, updateId: 1,
    episodeId: randomUUID(), requestId: randomUUID(), state: 'finished', createdAt: 1, updatedAt: 1 } } as never;
  expect(x.service.ownsSourceDelivery(run)).toBe(true);
  expect(x.service.ownsSourceDelivery({ id: randomUUID() } as never)).toBe(false);
  delivers.mockReturnValue(false); expect(x.service.ownsSourceDelivery(run)).toBe(false); delivers.mockReturnValue(true);
  // Two-way replies off: the webhook path must notify the chat instead.
  vi.stubEnv('CEZ_CHAT_INBOUND', '0'); expect(x.service.ownsSourceDelivery(run)).toBe(false); vi.stubEnv('CEZ_CHAT_INBOUND', '1');
  x.receiver.telegramChatId = '789'; expect(x.service.ownsSourceDelivery(run)).toBe(false); x.receiver.telegramChatId = '456';
  await x.service.setEnabled(x.receiver.id, { enabled: false, expectedRevision: x.service.list().receivers[0]!.inboundRevision });
  await vi.waitFor(() => expect(bot.runtime.health().state).toBe('stopped'));
  expect(x.service.ownsSourceDelivery(run)).toBe(false);
});

it.each([false, true])('requires explicit replacement after retargeting a receiver (group=%s)', async group => {
  const x = await fixture();
  if (group) x.receiver.telegramChatId = '-123';
  const original = x.call.getMockImplementation()!;
  x.call.mockImplementation((method, body, signal) => method === 'getChat'
    ? Promise.resolve({ id: Number(x.receiver.telegramChatId), type: 'group' })
    : method === 'getChatMember' ? Promise.resolve({ user: { id: (body as { user_id: number }).user_id }, status: 'member' })
    : original(method, body, signal));
  const begin = (replaceExisting = false) => x.service.beginSetup({ receiverId: x.receiver.id,
    expectedRevision: x.service.list().receivers[0]!.inboundRevision, dedicatedBot: true,
    ...(group ? { groupVisibilityAccepted: true } : {}), ...(replaceExisting ? { replaceExisting: true } : {}) });
  const candidate = (link: string, userId: number) => x.service.pairings.accept(x.botId, 'test_bot', {
    message_id: 1, date: 10, chat: { id: userId, type: 'private' }, from: { id: userId, is_bot: false },
    text: '/start ' + new URL(link).searchParams.get('start'), entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  const activate = (setupId: string, userId: string) => x.service.activateSetup(setupId, {
    activate: true, expectedRevision: x.service.setupStatus(setupId).inboundRevision,
    candidateUserId: userId, permissions: ['respond'], ...(group ? { comparisonVerified: true } : {}) });
  const initial = await begin(); candidate(initial.deepLink, 456);
  const approved = await activate(initial.setupId, '456');
  if (!group) await x.service.revoke(approved.grant!.id, approved.inboundRevision);
  x.receiver.telegramChatId = group ? '-789' : '789'; x.receiver.revision++; x.receiver.deliveryRevision++;
  const before = x.service.list().grants;
  await expect(begin()).rejects.toMatchObject({ code: 'replacement_required' });
  expect(x.service.list().grants).toEqual(before);
  const replacement = await begin(true);
  expect(x.service.list().grants).toEqual([]);
  candidate(replacement.deepLink, group ? 456 : 789);
  if (group) {
    const status = x.service.setupStatus(replacement.setupId);
    await expect(x.service.activateSetup(replacement.setupId, { activate: true,
      expectedRevision: status.inboundRevision, candidateUserId: '456', permissions: ['respond'] }))
      .rejects.toMatchObject({ code: 'comparison_required' });
  }
  const next = await activate(replacement.setupId, group ? '456' : '789');
  expect(next.grant!.chatId).toBe(x.receiver.telegramChatId);
  expect(next.grant!.id).not.toBe(approved.grant!.id);
  expect(x.service.list().receivers[0]!.state).toBe('active');
});
