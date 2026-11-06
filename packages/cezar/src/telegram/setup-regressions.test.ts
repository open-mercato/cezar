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
import type { PrivateReceiver } from '../webhooks/endpoints.ts';
import type { SendResult } from '../webhooks/transport.ts';
import { TelegramInbound } from './service.ts';
import { TelegramApiError, type TelegramCall } from './client.ts';
import type { TelegramUpdate } from './protocol.ts';
import type { InboundStateStore } from './state.ts';

// Real-store setups; under a full parallel `npm test` they outlast the 5s default.
vi.setConfig({ testTimeout: 20000 });

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });
function barrier() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function transport(botId: string) {
  let poll: { resolve(value: unknown): void; reject(error: unknown): void } | undefined;
  let failure: TelegramApiError | undefined;
  const updates: TelegramUpdate[] = [];
  const call: TelegramCall = vi.fn(async (method, _body, signal) => {
    if (failure) throw failure;
    if (method === 'getMe') return { id: Number(botId), username: 'test_bot' };
    if (method !== 'getUpdates') return {};
    if (updates.length) return updates.splice(0);
    return new Promise((resolve, reject) => {
      const current = { resolve, reject }; poll = current;
      const abort = () => { if (poll === current) poll = undefined; resolve([]); };
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    });
  });
  return { call, push(update: TelegramUpdate) { if (poll) { const current = poll; poll = undefined; current.resolve([update]); } else updates.push(update); },
    fail(error: TelegramApiError) { failure = error; poll?.reject(error); poll = undefined; } };
}
async function fixture() {
  vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '1');
  const root = await mkdtemp(join(tmpdir(), 'telegram-regression-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const botId = String(randomInt(100000, 99999999)), oldToken = `${botId}:${'A'.repeat(35)}`, newToken = `${botId}:${'B'.repeat(35)}`;
  const old = transport(botId), fresh = transport(botId);
  const scope = { kind: 'project' as const, projectId: 'project', root };
  const vault = new SecretStore({ ...process.env, CEZ_HOME: join(root, 'vault') }, { keychain: async () => null });
  const send = vi.fn(async (): Promise<SendResult> => ({ kind: 'http', status: 200, response: '{"ok":true,"result":{"message_id":1,"chat":{"id":42}}}' }));
  let offset = 0;
  const now = () => Date.now() + offset;
  const webhooks = (await WebhookService.open({ root, dataDir: join(root, '.ai/cezar'), projectId: 'project', mode: 'local',
    serverPorts: () => [], scheduler: new WebhookScheduler(), send, telegramSecrets: new TelegramSecrets(scope, vault), now }))!;
  cleanups.push(() => webhooks.dispose());
  let service = webhooks.telegram;
  const deps = (service as unknown as { deps: {
    callToken(token: string): TelegramCall; call(id: string): TelegramCall;
    createReceiverFromToken(token: string, name: string | undefined, chatId: string, existingId?: string): Promise<PrivateReceiver>;
  } }).deps;
  deps.callToken = token => token === newToken ? fresh.call : old.call;
  const { createHash } = await import('node:crypto');
  const endpoints = (webhooks as unknown as { endpoints: { privateReceiver(id: string): PrivateReceiver } }).endpoints;
  deps.call = id => endpoints.privateReceiver(id).telegramSecret?.sha256 === createHash('sha256').update(newToken).digest('hex') ? fresh.call : old.call;
  let updateId = 1;
  const begin = (token = oldToken) => service.beginSetup({ token, dedicatedBot: true });
  const start = async (begun: Awaited<ReturnType<typeof begin>>, chat = 42, channel = old) => {
    channel.push({ update_id: updateId++, message: { message_id: updateId, date: Math.ceil(now() / 1000), chat: { id: chat, type: 'private' },
      from: { id: chat, is_bot: false, first_name: 'Person' }, text: `/start ${new URL(begun.deepLink).searchParams.get('start')}`,
      entities: [{ type: 'bot_command', offset: 0, length: 6 }] } });
    await vi.waitFor(() => expect(service.setupStatus(begun.setupId).status).toBe('candidate'));
  };
  const activate = (begun: Awaited<ReturnType<typeof begin>>, chat = 42) => service.activateSetup(begun.setupId, { activate: true,
    expectedRevision: service.setupStatus(begun.setupId).inboundRevision, candidateUserId: String(chat), permissions: ['respond'] });
  const state = () => (service as unknown as { bots: Map<string, { state: InboundStateStore }> }).bots.get(botId)!.state.snapshot();
  const tokens = async () => (await vault.list(scope)).secrets.filter(secret => secret.name.startsWith('WEBHOOK_TELEGRAM_'));
  const restart = async () => {
    await service.dispose(); service = new TelegramInbound(deps as never);
    const next = service; cleanups.push(() => next.dispose()); await service.load();
  };
  return { webhooks, get service() { return service; }, deps, send, begin, start, activate, state, tokens, old, fresh, botId, oldToken, newToken, restart, expire: () => { offset += 300001; } };
}

it.each(['revoked', 'polling', 'backoff'] as const)('rotates the polling credential from %s through a real Start and keeps it after activation with another old-token chat', async mode => {
  const x = await fixture();
  const first = await x.begin(); await x.start(first); await x.activate(first);
  const second = await x.begin(); await x.start(second, 43); await x.activate(second, 43);
  const grants = x.service.list().grants;
  if (mode !== 'polling') {
    x.old.fail(new TelegramApiError('http', mode === 'revoked' ? 401 : 500));
    await vi.waitFor(() => expect(x.service.list().bots[0]?.health.state).toBe(mode === 'revoked' ? 'credentials-unavailable' : 'backoff'));
  }
  const recovery = await x.begin(x.newToken);
  await x.start(recovery, 43, x.fresh);
  // Verification alone has not stored the replacement token.
  expect(await x.tokens()).toHaveLength(2);
  await x.activate(recovery, 43);
  expect(x.service.list().grants).toEqual(grants);
  x.old.fail(new TelegramApiError('http', 401));
  const next = await x.service.beginSetup({ receiverId: x.webhooks.list().receivers.find(row => row.telegramChatId === '43')!.id,
    expectedRevision: x.service.list().receivers.find(row => row.receiverId === x.webhooks.list().receivers.find(receiver => receiver.telegramChatId === '43')!.id)!.inboundRevision, dedicatedBot: true });
  await x.start(next, 43, x.fresh);
  expect(x.service.list().bots[0]?.health.state).toBe('polling');
  await x.service.cancelSetup(next.setupId);
  await x.restart(); await x.service.start();
  await vi.waitFor(() => expect(x.service.list().bots[0]?.health.state).toBe('polling'));
  const rotated = x.webhooks.list().receivers.find(row => row.telegramChatId === '43')!;
  await x.webhooks.delete(rotated.id, rotated.revision);
  await x.restart(); await x.service.start();
  expect(x.service.list().bots[0]?.health.state).toBe('stopped');
});

it.each(['same', 'distinct'] as const)('serializes %s-session activations for one chat across real receiver creation', async kind => {
  const x = await fixture();
  const first = await x.begin(); await x.start(first);
  const second = kind === 'same' ? first : await x.begin();
  if (kind !== 'same') await x.start(second);
  const entered = barrier(), release = barrier(); cleanups.push(async () => release.resolve());
  const factory = x.deps.createReceiverFromToken;
  x.deps.createReceiverFromToken = async (...args) => { entered.resolve(); await release.promise; return factory(...args); };
  const one = x.activate(first); await entered.promise;
  const two = x.activate(second);
  const outcomes = Promise.allSettled([one, two]); release.resolve();
  const result = await outcomes;
  expect(x.webhooks.list().receivers).toHaveLength(1);
  expect(await x.tokens()).toHaveLength(1);
  expect(x.state().receivers).toHaveLength(1);
  expect(result.map(row => row.status)).toEqual(['fulfilled', 'fulfilled']);
});

it.each(['cancel', 'expire', 'disconnect'] as const)('rolls back a new receiver and its vault secret when %s occurs during its factory', async action => {
  const x = await fixture(); const begun = await x.begin(); await x.start(begun);
  const entered = barrier(), release = barrier(); cleanups.push(async () => release.resolve());
  const factory = x.deps.createReceiverFromToken;
  x.deps.createReceiverFromToken = async (...args) => { entered.resolve(); await release.promise; return factory(...args); };
  const result = x.activate(begun).then(() => 'activated', () => 'rejected'); await entered.promise;
  if (action === 'cancel') await x.service.cancelSetup(begun.setupId);
  if (action === 'expire') x.expire();
  if (action === 'disconnect') await x.service.disconnect(x.botId, x.service.list().bots[0]!.inboundRevision!);
  release.resolve();
  expect(await result).toBe('rejected');
  expect(x.webhooks.list().receivers).toEqual([]);
  expect(await x.tokens()).toEqual([]);
});


it('replaces an old transport whose runtime getMe is still in flight', async () => {
  const x = await fixture(); const first = await x.begin(); await x.start(first); await x.activate(first);
  await x.restart();
  const entered = barrier();
  const oldCall = x.deps.call;
  x.deps.call = id => async (method, body, signal, authorization) => {
    if (method !== 'getMe') return oldCall(id)(method, body, signal, authorization);
    entered.resolve();
    return new Promise((_resolve, reject) => {
      const abort = () => reject(new Error('aborted startup'));
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    });
  };
  const starting = x.service.start(); await entered.promise;
  const recovery = await x.begin(x.newToken);
  await starting;
  await x.start(recovery, 42, x.fresh);
  await x.activate(recovery);
  expect(x.service.list().bots[0]?.health.state).toBe('polling');
});

it('a pending activation for one chat does not block an independent chat', async () => {
  const x = await fixture(); const first = await x.begin(); await x.start(first);
  const second = await x.begin(); await x.start(second, 43);
  const entered = barrier(), release = barrier(); cleanups.push(async () => release.resolve());
  const factory = x.deps.createReceiverFromToken;
  x.deps.createReceiverFromToken = async (...args) => { if (args[2] === '42') { entered.resolve(); await release.promise; } return factory(...args); };
  const one = x.activate(first); await entered.promise;
  await x.activate(second, 43);
  release.resolve(); await one;
  expect(x.webhooks.list().receivers).toHaveLength(2);
  expect(x.state().receivers).toHaveLength(2);
  expect(await x.tokens()).toHaveLength(2);
});

it('rolls back a newly created receiver after approval fails and permits a clean retry', async () => {
  const x = await fixture(); const begun = await x.begin(); await x.start(begun);
  const confirm = vi.spyOn(x.service, 'confirm').mockRejectedValueOnce(new Error('approval failed'));
  await expect(x.activate(begun)).rejects.toThrow('approval failed');
  expect(x.webhooks.list().receivers).toEqual([]); expect(await x.tokens()).toEqual([]);
  expect(x.state().receivers).toEqual([]);
  confirm.mockRestore(); await x.activate(begun);
  expect(x.webhooks.list().receivers).toHaveLength(1); expect(await x.tokens()).toHaveLength(1);
  expect(x.service.list().grants).toHaveLength(1);
});

it('a failed reused setup preserves the pre-existing receiver, options and grant', async () => {
  const x = await fixture(); const first = await x.begin(); await x.start(first); await x.activate(first);
  const before = x.webhooks.list().receivers[0]!;
  await x.webhooks.update(before.id, { name: before.name, format: 'telegram.v1', telegramChatId: '42', profile: 'standard', preset: 'attention',
    events: ['task.attention_required'], graceSeconds: 60, includeAgentExcerpt: true, expectedRevision: before.revision });
  const grants = x.service.list().grants;
  const begun = await x.begin(); await x.start(begun);
  const entered = barrier(), release = barrier(); cleanups.push(async () => release.resolve());
  const factory = x.deps.createReceiverFromToken;
  x.deps.createReceiverFromToken = async (...args) => { entered.resolve(); await release.promise; return factory(...args); };
  const result = x.activate(begun).then(() => 'activated', () => 'rejected'); await entered.promise;
  await x.service.cancelSetup(begun.setupId); release.resolve();
  expect(await result).toBe('rejected');
  expect(x.webhooks.list().receivers).toEqual([expect.objectContaining({ id: before.id, state: 'active', graceSeconds: 60, includeAgentExcerpt: true })]);
  expect(await x.tokens()).toHaveLength(1); expect(x.service.list().grants).toEqual(grants);
});


it('loads legacy state without a preferred credential and keeps it when setup is cancelled', async () => {
  const x = await fixture(); const first = await x.begin(); await x.start(first); await x.activate(first);
  const bot = (x.service as unknown as { bots: Map<string, { state: InboundStateStore }> }).bots.get(x.botId)!;
  await bot.state.change(state => { delete state.transportCredentialFingerprint; });
  await x.restart(); await x.service.start();
  await vi.waitFor(() => expect(x.service.list().bots[0]?.health.state).toBe('polling'));
  const begun = await x.begin(); await x.service.cancelSetup(begun.setupId);
  const again = await x.begin(); await x.start(again);
  expect(x.service.list().grants).toHaveLength(1);
  expect(x.webhooks.list().receivers).toHaveLength(1);
});
