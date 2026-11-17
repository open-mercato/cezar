import { webhookStoredSettingsSchema } from '@open-mercato/cezar-contract';
import { readInboundState } from '../chat/state.ts';
import type { TopicPublisher } from './ws.ts';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hc, type InferRequestType, type InferResponseType } from 'hono/client';
import { z } from 'zod';
import { expect, it, vi } from 'vitest';
import { slackSchemas, discordSchemas } from '@open-mercato/cezar-contract';
import { WebhookCoordinator } from '../webhooks/coordinator.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { registerProject } from '../workspace/projects.ts';
import { createApp } from './server.ts';
import type { AppType } from './app-type.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { fakeChatTransport } from '../chat/test-support/chat-transport.testkit.ts';
import { chatProvider } from '../chat/registry.ts';
const client = hc<AppType>('http://127.0.0.1');
const slack = client.api.v1.p[':projectId'].slack, discord = client.api.v1.p[':projectId'].discord;
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
type Checks = [
 Assert<Equal<z.input<typeof slackSchemas.chatSetupBeginSchema>, InferRequestType<typeof slack.setup.$post>['json']>>,
 Assert<Equal<z.input<typeof discordSchemas.chatSetupBeginSchema>, InferRequestType<typeof discord.setup.$post>['json']>>,
 Assert<Equal<z.infer<typeof slackSchemas.chatInboundStateResponseSchema>, InferResponseType<typeof slack.$get, 200>>>,
 Assert<Equal<z.infer<typeof discordSchemas.chatSetupActivatedSchema>, InferResponseType<typeof discord.setup[':id']['activate']['$post'], 200>>>,
 Assert<Equal<z.infer<typeof slackSchemas.chatOrphanBindingsSchema>, InferResponseType<typeof client.api.v1.slack['bot-bindings']['$get'], 200>>>,
 Assert<Equal<z.infer<typeof discordSchemas.chatOrphanReleasedSchema>, InferResponseType<typeof client.api.v1.discord['bot-bindings'][':botId']['$delete'], 200>>>,
];
const checked: Checks | undefined = undefined; void checked;
it.each(['slack', 'discord'].flatMap(provider => ['normal', 'retry', 'edited'].map(mode => [provider, mode] as const)))('registers %s transport and same-receiver activation (%s)', async (providerName, mode) => {
 const provider = providerName as 'slack' | 'discord';
 let failDelivery = false;
 const root = await mkdtemp(join(tmpdir(), 'chat-provider-parity-')); execFileSync('git', ['init', '-q'], { cwd: root });
 vi.stubEnv('CEZ_HOME', join(root, 'home')); vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '1');
 vi.stubEnv('CEZ_DRY_RUN', '0'); vi.stubEnv('CEZ_SINGLE_PROJECT', '0'); vi.stubEnv('CEZ_REMOTE', '0'); vi.stubEnv('CEZ_AUTOMATIONS', '0'); vi.stubEnv('CEZ_NO_BANNER', '1');
 const project = await registerProject(root), store = RunStore.open(join(root, '.ai/cezar'));
 const sent: unknown[] = [];
 let message = 100;
 const botId = provider === 'slack' ? 'TTEAM:UBOT' : '456', actor = provider === 'slack' ? 'UACTOR' : '789', chatId = provider === 'slack' ? 'private:TTEAM:UBOT:DCHAN' : 'discord:dm:123';
 const fake = fakeChatTransport({ botId, isGroup: id => chatProvider(provider)!.presentation.isGroup(id), send(destination, body) {
  if (failDelivery) throw new Error('injected delivery failure');
  sent.push(body); return { chatId: destination, messageId: provider === 'slack' ? `1700000000.${String(++message).padStart(6, '0')}` : String(++message) };
 } });
 const sockets = fake.connections;
 const coordinatorOptions: ConstructorParameters<typeof WebhookCoordinator>[0] = { dryRun: false, mode: () => 'local', ports: () => [], projects: async () => [{ ...project, status: 'ready' }], chatTransport: () => fake.transport };
 const coordinator = new WebhookCoordinator(coordinatorOptions);
 const cleanups: (() => void)[] = [];
 const topics = new Map<string, TopicPublisher>();
 const subscribe = vi.spyOn(coordinator, 'onChatChange');
 const app = createApp({ repoRoot: root, bootProjectId: project.id, store, manager: { isActive: () => false } as unknown as RunManager, version: 'test', webhooks: coordinator, socketHub: { registerTopic(name, publisher) { topics.set(name, publisher); return () => { topics.delete(name); }; }, attach() {}, close() {} }, onDispose: fn => cleanups.push(fn) });
 const schemas = provider === 'slack' ? slackSchemas : discordSchemas;
 const prefix = `/api/v1/p/${project.id}/${provider}`;
 const request = async (suffix: string, method = 'GET', body?: unknown, status = 200) => {
  const response = await apiRequest(app, prefix + suffix, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const result = await response.json(); expect(response.status, JSON.stringify(result)).toBe(status); return result;
 };
 try {
  const service = await coordinator.get(project.id, root, true);
  const url = provider === 'slack' ? 'https://hooks.slack.com/services/TA/BB/old' : `https://discord.com/api/webhooks/123456789012345678/${'x'.repeat(60)}`;
  const original = (await service.create({ name: 'Existing', format: `${provider}.v1`, url, graceSeconds: 0, preset: 'all' })).receiver;
  expect(subscribe).not.toHaveBeenCalled();
  const topic = topics.get(`${provider}-inbound`)!; expect(await topic.snapshot()).toEqual({ changed: true });
  const publish = vi.fn(), stop = topic.start(publish);
  expect(subscribe).toHaveBeenCalledWith(provider, expect.any(Function));
  service.emit(`${provider}-change`); expect(publish).toHaveBeenCalledWith({ changed: true });
  stop(); const published = publish.mock.calls.length; service.emit(`${provider}-change`); expect(publish).toHaveBeenCalledTimes(published);
  const state = schemas.chatInboundStateResponseSchema.parse(await request(''));
  const credential = provider === 'slack' ? JSON.stringify({ appToken: `xapp-${'a'.repeat(30)}`, botToken: `xoxb-${'b'.repeat(30)}` }) : `${'a'.repeat(30)}.${'b'.repeat(8)}.${'c'.repeat(30)}`;
  vi.stubEnv('CEZ_CHAT_INBOUND', '0');
  expect(await request('')).toMatchObject({ available: false, reason: 'flag_off', notifications: { available: true } });
  vi.stubEnv('CEZ_WEBHOOKS', '0');
  expect(await request('')).toMatchObject({ notifications: { available: false }, receivers: [], bots: [], grants: [] });
  await request('/setup', 'POST', { token: credential, dedicatedBot: true }, 503);
  vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '1');
  const begun = schemas.chatSetupBegunSchema.parse(await request('/setup', 'POST', { token: credential, receiverId: original.id, expectedRevision: state.receivers[0]!.inboundRevision, dedicatedBot: true }, 201));
  await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
  const link = new URL(begun.deepLink), code = provider === 'slack' ? link.searchParams.get('cezar_start')! : new URLSearchParams(link.hash.slice(1)).get('cezar-start')!;
  await sockets.at(-1)!.accept({ kind: 'start', id: 'discovery-event', code, at: Date.now(), chat: { id: chatId, kind: 'private' }, user: { id: actor, label: 'actor' } });
  await vi.waitFor(async () => expect(schemas.chatSetupStatusSchema.parse(await request(`/setup/${begun.setupId}`)).status).toBe('candidate'));
  const candidate = schemas.chatSetupStatusSchema.parse(await request(`/setup/${begun.setupId}`));
  if (mode !== 'normal') {
   failDelivery = true;
   const activation = { activate: true, expectedRevision: candidate.inboundRevision, candidateUserId: actor, permissions: ['respond'] };
   await request(`/setup/${begun.setupId}/activate`, 'POST', activation, 503);
   expect(service.list().receivers).toHaveLength(1);
   expect(service.list().receivers[0]?.state).toBe('inactive');
   expect(schemas.chatInboundStateResponseSchema.parse(await request('')).grants).toEqual([]);
   failDelivery = false;
   if (mode === 'edited') {
    const receiver = service.endpoints.privateReceiver(original.id)!;
    await service.update(receiver.id, { ...webhookStoredSettingsSchema.strip().parse(receiver), name: 'User renamed', expectedRevision: receiver.revision });
    const before = service.endpoints.privateReceiver(original.id);
    await request(`/setup/${begun.setupId}/activate`, 'POST', activation, 409);
    expect(service.endpoints.privateReceiver(original.id)).toEqual(before);
    return;
   }
  }
  const activated = schemas.chatSetupActivatedSchema.parse(await request(`/setup/${begun.setupId}/activate`, 'POST', { activate: true, expectedRevision: candidate.inboundRevision, candidateUserId: actor, permissions: ['respond'] }));
  expect(activated.grant?.receiverId).toBe(original.id); expect(service.list().receivers).toHaveLength(1);
  expect(service.list().receivers[0]).toMatchObject({ id: original.id, state: 'active', lastTest: 'success' }); expect(sent.length).toBeGreaterThan(0);
  if (mode === 'retry') return;
  const privateReceiver = service.endpoints.privateReceiver(original.id)!;
  expect(privateReceiver.chatBotId).toBe(provider === 'slack' ? 'TTEAM:UBOT' : '456');
  service.attach(store, { isActive: () => false }, true);
  const run = store.createRun({ title: 'Outbound provider receipt', task: 'fixture', workflow: 'w', steps: [] }); store.updateRun(run.id, { status: 'done', completionReason: 'completed' });
  await vi.waitFor(async () => { await service.tick(); expect(service.deliveries(original.id).some(row => row.eventType === 'task.finished' && row.status === 'delivered')).toBe(true); }, { timeout: 5000 });
  const inboundState = await readInboundState(join(root, '.ai/cezar/webhooks/chat', provider), privateReceiver.chatBotId!);
  expect(inboundState?.correlations.find(row => row.runId === run.id)).toMatchObject({ receiverId: original.id, chatId: privateReceiver.chatId, privateChat: true });
  const disk = await readFile(join(root, '.ai/cezar/webhooks/endpoints.json'), 'utf8'); expect(disk).not.toContain(credential);
  expect(JSON.stringify(service.list())).not.toContain('chatSecret');
  const alias = await apiRequest(app, `/api/v1/${provider}`); expect(await alias.json()).toEqual(await request(''));
  const bindings = await apiRequest(app, `/api/v1/${provider}/bot-bindings`); expect(bindings.status).toBe(200); schemas.chatOrphanBindingsSchema.parse(await bindings.json());
  await request('/setup', 'POST', { token: 'invalid', dedicatedBot: true }, 400);
  await request('/bots/invalid/reset', 'POST', { expectedRevision: 'a'.repeat(64), confirmReset: true }, 400);
  for (const cleanup of cleanups.splice(0)) cleanup(); await coordinator.dispose();
  const restarted = new WebhookCoordinator(coordinatorOptions);
  try {
    const restored = await restarted.get(project.id, root, true); await restored.startChat();
    expect(restored.endpoints.privateReceiver(original.id)).toMatchObject({ chatBotId: privateReceiver.chatBotId, chatId: privateReceiver.chatId });
    expect(restored.chats.get(provider)!.list().grants[0]?.receiverId).toBe(original.id);
    await vi.waitFor(() => expect(restored.chats.get(provider)!.list().bots[0]?.username).toBe(privateReceiver.chatBotId), { timeout: 5000 });
  } finally { await restarted.dispose(); }
 } finally { for (const cleanup of cleanups) cleanup(); await coordinator.dispose(); store.flush(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
}, 20000);
