import { Hono } from 'hono';
import { slackSchemas, discordSchemas, chatSetupBegunSchema } from '@open-mercato/cezar-contract';
import { createChatRoutes } from '../server/chat-routes.ts';
import { WebhookService } from '../webhooks/service.ts';
import { WebhookScheduler } from '../webhooks/scheduler.ts';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { slackServiceDescriptor } from './providers/slack/index.ts';
import { discordServiceDescriptor } from './providers/discord/index.ts';
import { fakeChatTransport } from './test-support/chat-transport.testkit.ts';
import { encodeSlackCredentials } from './providers/slack/identity.ts';
import type { PrivateReceiver } from '../webhooks/endpoints.ts';
import { ChatInbound, withProvider } from './service.ts';
import type { ChatBotRuntime } from './runtime.ts';
import { readInboundState, type InboundStateStore } from './state.ts';
import { BotLease } from './ownership.ts';
import type { ChatSetups } from './setup.ts';
import { drive, elapse, fakeClock, quiesce, realClock, until } from './test-support/fake-clock.testkit.ts';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { realClock(); for (const clean of cleanups.splice(0).reverse()) await clean(); vi.unstubAllEnvs(); });
/** Awaits a call that may wait on timers (test-delivery polling, reply pacing): on the fake clock, time is driven. */
const settle = <T>(promise: Promise<T>) => vi.isFakeTimers() ? drive(promise) : promise;
function internals(service: ChatInbound) {
  return service as unknown as { setup: ChatSetups; bots: Map<string, { runtime: ChatBotRuntime; state: InboundStateStore; lease: BotLease }> };
}
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(provider: 'slack' | 'discord', realStore = false) {
  vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '1');
  const directory = await mkdtemp(join(tmpdir(), 'chat-lifecycle-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  vi.stubEnv('CEZ_HOME', join(directory, 'home'));
  const botId = provider === 'slack' ? 'T123:U123' : '12345';
  const userId = provider === 'slack' ? 'U456' : '456';
  const token = provider === 'slack' ? encodeSlackCredentials({ appToken: 'xapp-synthetic12345', botToken: 'xoxb-synthetic12345' })
    : `${'a'.repeat(24)}.${'b'.repeat(6)}.${'c'.repeat(27)}`;
  const receivers: PrivateReceiver[] = [];
  let pauseIdentity = false;
  const identityEntered = barrier();
  const identity = async (signal?: AbortSignal) => {
    if (!pauseIdentity) return;
    pauseIdentity = false; identityEntered.resolve();
    await new Promise<void>((_, reject) => {
      const abort = () => reject(new Error('aborted startup'));
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    });
  };
  const descriptor = provider === 'slack' ? slackServiceDescriptor : discordServiceDescriptor;
  const fake = fakeChatTransport({ botId, identify: identity, isGroup: chatId => descriptor.presentation.isGroup(chatId) });
  const sockets = fake.connections;
  const options = { projectId: 'project', root: directory, directory, installationId: randomUUID(), mode: 'local' as const,
    receivers: () => receivers, context: async () => { throw new Error('no project in lifecycle fixture'); }, deliver: async () => { throw new Error('unexpected delivery'); }, episode: () => undefined, changed() {},
    createReceiverFromToken: async (_token: string, _name: string | undefined, chatId: string) => {
      const receiver = { id: randomUUID(), revision: 1, deliveryRevision: 1, format: `${provider}.v1`, chatId,
        state: 'active', lastTest: 'success', profile: 'standard', events: ['task.attention_required'],
        chatSecret: { sha256: createHash('sha256').update(token).digest('hex') } } as PrivateReceiver;
      receivers.push(receiver); return receiver;
    },
  };
  const construct = () => new ChatInbound(withProvider(options as never, { provider: descriptor, transport: () => fake.transport, credentialTransport: () => fake.transport }));
  let service = construct();
  let webhooks: WebhookService | undefined;
  if (realStore) {
    execFileSync('git', ['init', '-q'], { cwd: directory, timeout: 5000 });
    webhooks = (await WebhookService.open({ root: directory, dataDir: join(directory, '.ai/cezar'), projectId: 'project',
      mode: 'local', serverPorts: () => [], scheduler: new WebhookScheduler(),
      chatTransport: () => fake.transport }))!;
    service = webhooks[provider];
    cleanups.push(() => webhooks!.dispose());
  }
  const app = new Hono().route('/api/v1', createChatRoutes(provider, async () => service, () => undefined,
    provider === 'slack' ? slackSchemas : discordSchemas));
  const request = async (path: string, body: unknown) => app.request(`/api/v1/${provider}/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const api = (path: string, body: unknown) => settle(request(path, body));
  cleanups.push(async () => {
    await Promise.all([...internals(service).bots.values()].map(bot => bot.runtime?.stop()));
    await service.dispose();
  });
  const ready = () => until(() => expect(service.list().bots[0]?.health.state).toBe('polling'));
  const begin = () => service.beginSetup({ token, dedicatedBot: true });
  const sendStart = (deepLink: string, group: boolean) => {
    const code = provider === 'slack' ? new URL(deepLink).searchParams.get('cezar_start') : new URL(deepLink).hash.split('=')[1];
    const chatId = provider === 'slack' ? (group ? 'group:T123:U123:C789' : 'private:T123:U123:D456') : (group ? 'discord:guild:999:789' : 'discord:dm:456');
    void sockets.at(-1)!.accept({ kind: 'start', id: randomUUID(), code: code!, at: Date.now(), chat: { id: chatId, kind: group ? 'group' : 'private' }, user: { id: userId, label: 'Person' } });
  };
  const discover = async () => {
    const begun = await begin(); await ready(); sendStart(begun.deepLink, true);
    await until(() => expect(service.setupStatus(begun.setupId).status).toBe('candidate'));
    await service.activateSetup(begun.setupId, { activate: true, taskControl: false, groupVisibilityAccepted: true,
      expectedRevision: service.setupStatus(begun.setupId).inboundRevision, candidateUserId: userId });
  };
  const approve = async () => {
    const begun = await service.beginSetup({ receiverId: receivers[0]!.id, dedicatedBot: true, groupVisibilityAccepted: true,
      expectedRevision: service.list().receivers[0]!.inboundRevision });
    await ready(); sendStart(begun.deepLink, false);
    await until(() => expect(service.setupStatus(begun.setupId).candidate?.comparisonCode).toBeTruthy());
    await service.activateSetup(begun.setupId, { activate: true, permissions: ['respond'], comparisonVerified: true, groupVisibilityAccepted: true,
      expectedRevision: service.setupStatus(begun.setupId).inboundRevision, candidateUserId: userId });
  };
  const privateGrant = async () => {
    const begun = await begin(); await ready(); sendStart(begun.deepLink, false);
    await until(() => expect(service.setupStatus(begun.setupId).status).toBe('candidate'));
    await service.activateSetup(begun.setupId, { activate: true, permissions: ['respond'],
      expectedRevision: service.setupStatus(begun.setupId).inboundRevision, candidateUserId: userId });
    await service.dispose(); service = construct(); await service.load(); await service.start(); await ready();
  };
  return { api, request, webhooks, token, observe: () => webhooks!.on(`${provider}-change`, () => service.list()), privateGrant, get service() { return service; }, bot: () => internals(service).bots.get(botId)!, begin, ready, discover, approve, sendStart,
    sockets, userId, pauseIdentity: () => { pauseIdentity = true; return identityEntered.promise; },
    restart: async (start = true) => { await service.dispose(); service = construct(); await service.load(); if (start) await service.start(); },
  };
}

it.each(['slack', 'discord'] as const)('%s receives private group approval after same-token notification activation', async provider => {
  const x = await fixture(provider);
  await x.discover(); await x.approve();
  expect(x.service.list().grants).toHaveLength(1);
  expect(x.bot().state.snapshot().fatalStop).toBeUndefined();
  await x.restart(); await x.ready();
});

it.each(['slack', 'discord'] as const)('%s replaces a starting durable anchor with a same-token temporary anchor', async provider => {
  const x = await fixture(provider);
  await x.privateGrant(); await x.restart(false);
  const entered = x.pauseIdentity();
  const starting = x.service.start(); await entered;
  const begun = await x.begin(); await starting; await x.ready();
  x.sendStart(begun.deepLink, false);
  await until(() => expect(x.service.setupStatus(begun.setupId).status).toBe('candidate'));
}, 10000);

it('does not persist a deliberate shutdown as fatal while setup settlement is pending', async () => {
  const x = await fixture('discord'); await x.privateGrant();
  const entered = barrier(), release = barrier();
  const setup = internals(x.service).setup, settled = setup.settled.bind(setup);
  vi.spyOn(setup, 'settled').mockImplementation(async () => { await settled(); entered.resolve(); await release.promise; });
  x.bot().lease.assertOwner();
  x.sockets.at(-1)!.pulse();
  const disposing = x.service.dispose();
  try {
    await entered.promise;
    // Inside the settlement window, once every write the shutdown queued has landed (d869584d).
    await quiesce(); await x.bot().state.drain();
    expect(x.bot().state.snapshot().fatalStop).toBeUndefined();
  } finally { release.resolve(); await disposing; }
  await x.restart(); await x.ready();
});

it('retains a real authentication failure across disposal and restart', async () => {
  const x = await fixture('discord'); await x.privateGrant();
  x.sockets.at(-1)!.fail('credentials-unavailable');
  await until(() => expect(x.bot().state.snapshot().fatalStop).toBe('credentials-unavailable'));
  await x.restart();
  expect(x.service.list().bots[0]?.health.state).toBe('credentials-unavailable');
});

it('retains an operational ownership guard failure', async () => {
  const x = await fixture('discord'); await x.privateGrant();
  // Preserve the store's ownership checks: only the transport's synchronous fence is lost.
  vi.spyOn(x.bot().lease, 'assertOwner').mockImplementationOnce(() => { throw new Error('lost ownership'); });
  x.sockets.at(-1)!.pulse();
  await until(() => expect(x.bot().state.snapshot().fatalStop).toBe('blocked'));
  vi.restoreAllMocks();
  await x.restart();
  expect(x.service.list().bots[0]?.health.state).toBe('blocked');
});

it('does not construct a replacement or retain its lease when disposal overtakes anchor switching', async () => {
  const x = await fixture('discord'); await x.privateGrant();
  const runtime = x.bot().runtime, stop = runtime.stop.bind(runtime), entered = barrier(), release = barrier();
  vi.spyOn(runtime, 'stop').mockImplementation(async () => {
    const stopped = await stop(); entered.resolve(); await release.promise; return stopped;
  });
  const before = x.sockets.length;
  const replacing = x.begin().then(() => 'started', () => 'closed');
  await entered.promise;
  const disposing = x.service.dispose();
  release.resolve();
  expect(await replacing).toBe('closed');
  await disposing;
  expect(x.sockets).toHaveLength(before);
  expect(x.bot().runtime).toBe(runtime);
  expect(x.bot().state.snapshot().fatalStop).toBeUndefined();
  // A new service can acquire the same lease and resume the existing grant.
  await x.restart(); await x.ready();
});

// Real endpoint persistence/test/activation and real adapters, with only platform I/O replaced.
it.each([
  ['slack', false], ['slack', true], ['discord', false], ['discord', true],
] as const)('%s activates through the API with a status subscriber (group=%s)', async (provider, group) => {
  fakeClock(); // test-delivery polling and reply pacing
  const x = await fixture(provider, true);
  const response = await x.api('setup', { token: x.token, dedicatedBot: true });
  expect(response.status).toBe(201);
  const begun = chatSetupBegunSchema.parse(await response.json());
  await x.ready(); x.sendStart(begun.deepLink, group);
  await until(() => expect(x.service.setupStatus(begun.setupId).status).toBe('candidate'));
  x.observe();
  const activated = await x.api(`setup/${begun.setupId}/activate`, { activate: true, taskControl: !group,
    ...(group ? { groupVisibilityAccepted: true } : { permissions: ['respond'] }),
    expectedRevision: x.service.setupStatus(begun.setupId).inboundRevision, candidateUserId: x.userId });
  expect(await activated.clone().json()).not.toHaveProperty('error');
  expect(activated.status).toBe(200);
  expect(x.service.list().receivers).toHaveLength(1);
  expect(x.service.list().grants).toHaveLength(group ? 0 : 1);
  expect(x.bot().state.snapshot().fatalStop).toBeUndefined();
  if (group) {
    const receiver = x.service.list().receivers[0]!;
    const approvalResponse = await x.api('setup', { receiverId: receiver.receiverId, dedicatedBot: true,
      groupVisibilityAccepted: true, expectedRevision: receiver.inboundRevision });
    expect(approvalResponse.status).toBe(201);
    const approval = chatSetupBegunSchema.parse(await approvalResponse.json());
    await x.ready(); x.sendStart(approval.deepLink, false);
    await until(() => expect(x.service.setupStatus(approval.setupId).candidate?.comparisonCode).toBeTruthy());
    const approved = await x.api(`setup/${approval.setupId}/activate`, { activate: true, permissions: ['respond'],
      comparisonVerified: true, groupVisibilityAccepted: true,
      expectedRevision: x.service.setupStatus(approval.setupId).inboundRevision, candidateUserId: x.userId });
    expect(approved.status).toBe(200);
    expect(x.service.list().grants).toHaveLength(1);
    expect(x.bot().state.snapshot().fatalStop).toBeUndefined();
  }
});

it.each([
  ['slack', 'edit', false], ['slack', 'revoke', true], ['discord', 'edit', false], ['discord', 'revoke', true],
  ['slack', 'edit', true], ['discord', 'edit', true], ['slack', 'none', true], ['discord', 'none', true],
] as const)('%s fences %s during anchor handoff (existing grant: %s)', async (provider, mutation, existingGrant) => {
  fakeClock(); // test-delivery polling and reply pacing
  const x = await fixture(provider, true);
  const candidate = async () => {
    const response = await x.api('setup', { token: x.token, dedicatedBot: true });
    expect(response.status).toBe(201);
    const begun = chatSetupBegunSchema.parse(await response.json());
    await x.ready(); x.sendStart(begun.deepLink, false);
    await until(() => expect(x.service.setupStatus(begun.setupId).status).toBe('candidate'));
    return begun;
  };
  const activation = (id: string) => x.request(`setup/${id}/activate`, { activate: true, taskControl: existingGrant, permissions: ['respond'],
    expectedRevision: x.service.setupStatus(id).inboundRevision, candidateUserId: x.userId });
  const activate = (id: string) => drive(activation(id));
  if (existingGrant) {
    const first = await candidate();
    expect((await activate(first.setupId)).status).toBe(200);
  }
  const begun = await candidate(); x.observe();
  const runtime = x.bot().runtime, stop = runtime.stop.bind(runtime), entered = barrier(), release = barrier();
  vi.spyOn(runtime, 'stop').mockImplementation(async () => {
    const stopped = await stop(); entered.resolve(); await release.promise; return stopped;
  });
  const pending = activation(begun.setupId);
  await drive(entered.promise);
  try {
    if (mutation === 'revoke') {
      const current = x.service.list();
      await drive(x.service.revoke(current.grants[0]!.id, current.bots[0]!.inboundRevision!));
    } else if (mutation === 'edit') {
      const receiver = x.webhooks!.list().receivers[0]!;
      await drive(x.webhooks!.update(receiver.id, { expectedRevision: receiver.revision, format: `${provider}.v1`, name: 'Concurrent rename' }));
    }
  } finally { release.resolve(); }
  const response = await drive(pending);
  expect(response.status).toBe(mutation === 'none' ? 200 : 409);
  if (mutation !== 'none') expect(await response.json()).toEqual({ error: 'revision_conflict', code: 'revision_conflict' });
  expect(x.service.list().grants).toHaveLength(existingGrant && mutation !== 'revoke' ? 1 : 0);
  if (mutation === 'none') expect(x.service.list().grants[0]!.permissions).toEqual(['respond']);
});


it.each(['cleanup', 'disconnect'] as const)('retains unused bot ownership after a real stop timeout, then retries via %s', async retry => {
  const x = await fixture('discord'), begun = await x.begin(); await x.ready();
  const bot = x.bot(), binding = bot.state.snapshot().binding;
  const connection = (bot.runtime as unknown as { connection: { stop(): Promise<void> } }).connection;
  const stop = connection.stop.bind(connection), entered = barrier(), release = barrier();
  const held = vi.spyOn(connection, 'stop').mockImplementation(async () => {
    entered.resolve(); await release.promise; await stop();
  });
  const drain = vi.spyOn(bot.state, 'drain');
  const disconnect = vi.spyOn(bot.lease, 'disconnect'), relinquish = vi.spyOn(bot.lease, 'release');
  try {
    fakeClock(); // the runtime's 5 s stop timeout
    let settled = false;
    const cancelling = x.service.cancelSetup(begun.setupId).finally(() => { settled = true; });
    await entered.promise;
    // Cleanup waits out the whole stop timeout for the held connection, then gives up on it.
    await elapse(4900, 100); expect(settled).toBe(false);
    await expect(drive(cancelling, 200)).resolves.toEqual({ cancelled: true });
    expect(x.bot()).toBe(bot);
    expect(drain).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled(); expect(relinquish).not.toHaveBeenCalled();
    bot.lease.assertOwner();
    expect(await bot.lease.binding()).toEqual(binding);
    expect(await readInboundState(binding.root, '12345')).toEqual(bot.state.snapshot());
    await expect(BotLease.acquire('12345', false, 'discord')).rejects.toMatchObject({ code: 'owner_conflict' });
    const listed = x.service.list().bots[0]!;
    expect(listed.botId).toBe('12345');
    release.resolve();
    if (retry === 'disconnect') await drive(x.service.disconnect(listed.botId, listed.inboundRevision!));
    else await drive((x.service as unknown as { releaseUnusedBot(id: string): Promise<void> }).releaseUnusedBot('12345'));
    expect(x.bot()).toBeUndefined();
    expect(await readInboundState(binding.root, '12345')).toBeUndefined();
    const nextOwner = await BotLease.acquire('12345', false, 'discord');
    try { expect(await nextOwner.binding()).toBeUndefined(); } finally { await nextOwner.release(); }
  } finally {
    release.resolve(); await settle(bot.runtime.stop()); held.mockRestore();
    drain.mockRestore(); disconnect.mockRestore(); relinquish.mockRestore();
  }
});

it('isolates a rejected cleanup stop and permits Disconnect to release the empty bot', async () => {
  const x = await fixture('discord'), begun = await x.begin(); await x.ready();
  const bot = x.bot(), stop = vi.spyOn(bot.runtime, 'stop').mockRejectedValueOnce(new Error('stop failed'));
  try {
    await expect(x.service.cancelSetup(begun.setupId)).resolves.toEqual({ cancelled: true });
    expect(x.bot()).toBe(bot); bot.lease.assertOwner();
    const listed = x.service.list().bots[0]!;
    await x.service.disconnect(listed.botId, listed.inboundRevision!);
    expect(x.service.list().bots).toEqual([]);
    const next = await BotLease.acquire('12345', false, 'discord');
    try { expect(await next.binding()).toBeUndefined(); } finally { await next.release(); }
  } finally { stop.mockRestore(); }
});

it('isolates an unbind failure after a safe stop and releases the lease', async () => {
  const x = await fixture('discord'), begun = await x.begin(); await x.ready();
  const bot = x.bot(), disconnect = vi.spyOn(bot.lease, 'disconnect').mockRejectedValueOnce(new Error('disk failed'));
  try {
    await expect(x.service.cancelSetup(begun.setupId)).resolves.toEqual({ cancelled: true });
    expect(x.bot()).toBeUndefined();
    const next = await BotLease.acquire('12345', false, 'discord');
    try { expect(await next.binding()).toEqual(bot.state.snapshot().binding); } finally { await next.release(); }
  } finally { disconnect.mockRestore(); }
});
