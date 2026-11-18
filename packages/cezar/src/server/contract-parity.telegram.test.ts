import { normalizeMessage } from '../chat/test-support/telegram-wire.testkit.ts';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hc, type InferRequestType, type InferResponseType } from 'hono/client';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { telegramSchemas } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { registerProject } from '../workspace/projects.ts';
import { WebhookCoordinator } from '../webhooks/coordinator.ts';
import { telegramSeam, type TelegramCall } from '../chat/test-support/telegram-wire.testkit.ts';
import type { AppType } from './app-type.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
const client = hc<AppType>('http://127.0.0.1');
const routes = client.api.v1.p[':projectId']['telegram'];
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-wider') : 'schema-wider';
type Assert<T extends true> = T;
type Checks = [
  Assert<Equal<z.infer<typeof telegramSchemas.chatInboundGrantPatchedSchema>, InferResponseType<typeof routes.grants[':id']['$patch'], 200>>>,
  Assert<Equal<z.infer<typeof telegramSchemas.chatOrphanBindingsSchema>, InferResponseType<typeof client.api.v1.telegram['bot-bindings']['$get'], 200>>>,
  Assert<Equal<z.infer<typeof telegramSchemas.chatOrphanReleasedSchema>, InferResponseType<typeof client.api.v1.telegram['bot-bindings'][':botId']['$delete'], 200>>>,
  Assert<Equal<z.infer<typeof telegramSchemas.chatInboundStateResponseSchema>, InferResponseType<typeof routes.$get, 200>>>,
  Assert<Equal<z.infer<typeof telegramSchemas.chatInboundActivityResponseSchema>, InferResponseType<typeof routes.activity.$get, 200>>>,
  Assert<Equal<z.infer<typeof telegramSchemas.chatSetupCancelledSchema>, InferResponseType<typeof routes.setup[':id']['$delete'], 200>>>,
  Assert<Equal<z.infer<typeof telegramSchemas.chatInboundReceiverPatchedSchema>, InferResponseType<typeof routes.receivers[':id']['$patch'], 200>>>,
  Assert<Equal<z.infer<typeof telegramSchemas.chatInboundRevokedSchema>, InferResponseType<typeof routes.grants[':id']['$delete'], 200>>>,
  Assert<Equal<z.infer<typeof telegramSchemas.chatInboundDisconnectedSchema>, InferResponseType<typeof routes.bots[':botId']['binding']['$delete'], 200>>>,
  Assert<Equal<z.infer<typeof telegramSchemas.chatInboundResetResponseSchema>, InferResponseType<typeof routes.bots[':botId']['reset']['$post'], 200>>>,
  Assert<Equal<z.input<typeof telegramSchemas.chatSetupActivateSchema>, InferRequestType<typeof routes.setup[':id']['activate']['$post']>['json']>>,
  Assert<Equal<z.infer<typeof telegramSchemas.chatSetupBegunSchema>, InferResponseType<typeof routes.setup.$post, 201>>>,
  Assert<Equal<z.infer<typeof telegramSchemas.chatSetupStatusSchema>, InferResponseType<typeof routes.setup[':id']['$get'], 200>>>,
  Assert<Equal<z.infer<typeof telegramSchemas.chatSetupActivatedSchema>, InferResponseType<typeof routes.setup[':id']['activate']['$post'], 200>>>,
  Assert<Equal<z.input<typeof telegramSchemas.chatSetupBeginSchema>, InferRequestType<typeof routes.setup.$post>['json']>>,
  Assert<Equal<InferResponseType<typeof routes.$get, 200>, InferResponseType<typeof client.api.v1.telegram.$get, 200>>>,
];
const checked: Checks | undefined = undefined; void checked;

/** Parse the schema AND reject any key it does not declare, at every depth: the wire must not be wider. */
function strict<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const parsed = schema.parse(value);
  walk(schema, value, '$');
  return parsed;
}
function walk(schema: z.ZodType, value: unknown, path: string): void {
  if (value === undefined || value === null) return;
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) return walk(schema.unwrap() as z.ZodType, value, path);
  // A union is checked against the one branch the value actually matched.
  if (schema instanceof z.ZodUnion) return walk((schema.options as z.ZodType[]).find(option => option.safeParse(value).success)!, value, path);
  if (schema instanceof z.ZodArray) return (value as unknown[]).forEach((item, index) => walk(schema.element as z.ZodType, item, `${path}[${index}]`));
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodType>;
    for (const key of Object.keys(value as object)) {
      expect(shape, `undeclared key ${path}.${key}`).toHaveProperty(key);
      walk(shape[key]!, (value as Record<string, unknown>)[key], `${path}.${key}`);
    }
  }
}

it('serves exactly the contract shapes from the real Telegram routes, flag off and on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cez-telegram-parity-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  vi.stubEnv('CEZ_HOME', join(dir, '.home')); vi.stubEnv('CEZ_DRY_RUN', '1'); vi.stubEnv('CEZ_WEBHOOKS', '1');
  vi.stubEnv('CEZ_CHAT_INBOUND', '0'); vi.stubEnv('CEZ_SINGLE_PROJECT', '0'); vi.stubEnv('CEZ_REMOTE', '0');
  vi.stubEnv('CEZ_AUTOMATIONS', '0'); vi.stubEnv('CEZ_NO_BANNER', '1');
  const project = await registerProject(dir);
  const store = RunStore.open(join(dir, '.ai/cezar'));
  const call: TelegramCall = async (method, body, signal) => {
    if (method === 'getMe') return { id: 123456, username: 'parity_bot', first_name: 'Parity' };
    if (method === 'getUpdates') return new Promise(resolve => signal?.addEventListener('abort', () => resolve([]), { once: true }));
    if (method === 'sendMessage') return { message_id: 1, chat: { id: Number((body as { chat_id?: unknown }).chat_id) } };
    return true;
  };
  const webhooks = new WebhookCoordinator({ mode: () => 'local', ports: () => [], projects: async () => [{ ...project, status: 'ready' }], dryRun: true, chatTransport: telegramSeam(call) });
  const cleanups: (() => void)[] = [];
  const app = createApp({ repoRoot: dir, bootProjectId: project.id, store, manager: { isActive: () => false } as unknown as RunManager, version: 'test', webhooks, onDispose: fn => { cleanups.push(fn); } });
  const json = (method: string, body: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const read = async (path: string, init?: RequestInit, status = 200): Promise<unknown> => {
    const response = await apiRequest(app, `/api/v1/p/${project.id}/telegram${path}`, init);
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  try {
    strict(telegramSchemas.chatInboundStateResponseSchema, await read(''));
    strict(telegramSchemas.chatOrphanBindingsSchema, await (await apiRequest(app, '/api/v1/telegram/bot-bindings')).json());

    vi.stubEnv('CEZ_CHAT_INBOUND', '1');
    const service = await webhooks.get(project.id, dir, true);
    const { receiver } = await service.create({ name: 'Parity', format: 'telegram.v1', url: `https://api.telegram.org/bot123456:${'x'.repeat(35)}/sendMessage`, chatId: '456', profile: 'standard', graceSeconds: 0 });
    await service.test(receiver.id, { expectedRevision: receiver.revision, deliveryRevision: receiver.deliveryRevision, operationId: 'parity-test' });
    await service.tick();
    await service.activate(receiver.id, service.list().receivers[0]!.revision);

    const state = strict(telegramSchemas.chatInboundStateResponseSchema, await read(''));
    const pairInput = { receiverId: receiver.id, expectedRevision: state.receivers[0]!.inboundRevision, dedicatedBot: true as const };
    const created = strict(telegramSchemas.chatSetupBegunSchema, await read('/setup', json('POST', pairInput), 201));
    strict(telegramSchemas.chatSetupStatusSchema, await read(`/setup/${created.setupId}`));
    const code = new URL(created.deepLink).searchParams.get('start');
    service.telegram.pairings.accept('123456', 'parity_bot', normalizeMessage({ message_id: 2, date: Math.ceil(Date.now() / 1000), chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false, first_name: 'Parity person' }, text: `/start ${code}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] }, 'parity_bot')!);
    const candidate = strict(telegramSchemas.chatSetupStatusSchema, await read(`/setup/${created.setupId}`));
    const activated = strict(telegramSchemas.chatSetupActivatedSchema, await read(`/setup/${created.setupId}/activate`, json('POST', { activate: true, expectedRevision: candidate.inboundRevision, candidateUserId: '456', permissions: ['respond'] })));
    if (!activated.grant) throw new Error('Expected task-control activation to return a grant');
    const confirmed = { grant: activated.grant, inboundRevision: activated.inboundRevision };
    const patched = strict(telegramSchemas.chatInboundGrantPatchedSchema, await read(`/grants/${confirmed.grant.id}`, json('PATCH', { expectedRevision: confirmed.inboundRevision, permissions: ['respond', 'cancel'] })));
    const disabled = strict(telegramSchemas.chatInboundReceiverPatchedSchema, await read(`/receivers/${receiver.id}`, json('PATCH', { expectedRevision: patched.inboundRevision, enabled: false })));
    const revoked = strict(telegramSchemas.chatInboundRevokedSchema, await read(`/grants/${confirmed.grant.id}?expectedRevision=${disabled.inboundRevision}`, { method: 'DELETE' }));
    strict(telegramSchemas.chatInboundActivityResponseSchema, await read('/activity'));

    const again = strict(telegramSchemas.chatSetupBegunSchema, await read('/setup', json('POST', { ...pairInput, expectedRevision: revoked.inboundRevision }), 201));
    strict(telegramSchemas.chatSetupCancelledSchema, await read(`/setup/${again.setupId}`, { method: 'DELETE' }));
    const bound = strict(telegramSchemas.chatInboundStateResponseSchema, await read(''));
    strict(telegramSchemas.chatOrphanBindingsSchema, await (await apiRequest(app, '/api/v1/telegram/bot-bindings')).json());
    strict(telegramSchemas.chatInboundDisconnectedSchema, await read(`/bots/123456/binding?expectedRevision=${bound.bots[0]!.inboundRevision}`, { method: 'DELETE' }));
  } finally {
    for (const cleanup of cleanups) cleanup();
    await webhooks.dispose(); store.flush(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true });
  }
});

it('strict() rejects a key the schema does not declare', () => {
  expect(() => strict(telegramSchemas.chatSetupCancelledSchema, { cancelled: true, leaked: 1 })).toThrow(/undeclared key \$\.leaked/);
  const availability = { notifications: { available: true }, taskControl: { available: true } };
  expect(() => strict(telegramSchemas.chatInboundStateResponseSchema, { available: true, ...availability, receivers: [{ receiverId: 'r', inboundRevision: 'a'.repeat(64), state: 'active', extra: 1 }], bots: [], grants: [] }))
    .toThrow(/undeclared key \$\.receivers\[0\]\.extra/);
});
