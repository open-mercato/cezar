import { Hono } from 'hono';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { telegramDomainErrorSchema, telegramInboundStateResponseSchema } from '@open-mercato/cezar-contract';
import { createTelegramRoutes } from './telegram.ts';
import { TelegramInbound, TelegramInboundFailure } from '../telegram/service.ts';
import { telegramUnavailableReason } from '../telegram/availability.ts';
import type { PrivateReceiver } from '../webhooks/endpoints.ts';

it('serves disabled state through every alias without falling through to project recovery', async () => {
  const resolve = vi.fn(async () => undefined), recovery = vi.fn();
  const family = new Hono().route('/', createTelegramRoutes(resolve, () => 'flag_off'))
    .use('*', async (_c, next) => { recovery(); await next(); });
  const app = new Hono().route('/api/v1/p/:projectId', family).route('/api/v1', family);
  for (const prefix of ['/api/v1', '/api/v1/p/default', '/api/v1/p/project']) {
    const result = await app.request(`${prefix}/telegram`);
    expect(result.status).toBe(200); expect(result.headers.get('cache-control')).toBe('no-store');
    expect(telegramInboundStateResponseSchema.parse(await result.json())).toMatchObject({ available: false, reason: 'flag_off' });
    expect((await app.request(`${prefix}/telegram/unknown`)).status).toBe(404);
  }
  expect(recovery).not.toHaveBeenCalled();
});
it('withholds configured Telegram data while inbound is unavailable', async () => {
  const inbound = { refreshDiagnostics: vi.fn(), list: vi.fn(() => ({ available: true, receivers: [{ receiverId: 'secret', inboundRevision: 'a'.repeat(64), state: 'active' as const }], bots: [], grants: [] })) } as unknown as TelegramInbound;
  const app = createTelegramRoutes(async () => inbound, () => 'hosted');
  const response = await app.request('/telegram');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ available: false, reason: 'hosted',
    notifications: { available: false, reason: 'hosted' }, taskControl: { available: false, reason: 'hosted' }, receivers: [], bots: [], grants: [] });
  expect(inbound.list).not.toHaveBeenCalled();
});
it('serves the configuration with task control off, so notifications can be set up and managed', async () => {
  const list = vi.fn(() => ({ available: false, reason: 'flag_off', receivers: [], bots: [], grants: [],
    notifications: { available: true }, taskControl: { available: false, reason: 'flag_off' } }));
  const inbound = { refreshDiagnostics: vi.fn(), list } as unknown as TelegramInbound;
  const response = await createTelegramRoutes(async () => inbound, () => 'flag_off').request('/telegram');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ notifications: { available: true }, taskControl: { available: false, reason: 'flag_off' } });
  expect(list).toHaveBeenCalled();
});
it('lists Telegram chats with CEZ_WEBHOOKS=1 alone and reports only task control unavailable', async () => {
  vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '0');
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'telegram-route-')));
  const receiver = { id: 'chat', format: 'telegram.v1', telegramChatId: '456', state: 'active', lastTest: 'success', profile: 'standard',
    events: ['task.attention_required'], revision: 1, deliveryRevision: 1, telegramSecret: { sha256: 'a'.repeat(64) } } as PrivateReceiver;
  const inbound = new TelegramInbound({ projectId: 'project', root: directory, installationId: 'installation', directory, mode: 'local',
    receivers: () => [receiver], call: vi.fn(), changed() {}, context: vi.fn(), deliver: vi.fn(), episode: () => undefined } as never);
  try {
    const response = await createTelegramRoutes(async () => inbound, () => telegramUnavailableReason('local')).request('/telegram');
    expect(response.status).toBe(200);
    expect(telegramInboundStateResponseSchema.parse(await response.json())).toMatchObject({
      notifications: { available: true }, taskControl: { available: false, reason: 'flag_off' }, receivers: [{ receiverId: 'chat' }] });
  } finally { await inbound.dispose(); await rm(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); }
});
it('validates project scope before returning unavailable without opening webhook storage', async () => {
  const resolve = vi.fn(async () => { throw new Error('storage must not be opened'); });
  const validate = vi.fn(async (projectId: string | undefined) => {
    if (projectId === 'missing') throw new Error('scope missing');
  });
  const app = createTelegramRoutes(resolve, () => 'webhooks_off', validate);
  const response = await app.request('/telegram');
  expect(response.status).toBe(200);
  expect(resolve).not.toHaveBeenCalled();
  expect(validate).toHaveBeenCalledWith(undefined);
});
it('validates typed bodies before any setup action and blocks disabled mutations', async () => {
  const beginSetup = vi.fn(async () => ({})), permissions = vi.fn(), service = { beginSetup, permissions } as unknown as TelegramInbound;
  let reason: 'flag_off' | 'webhooks_off' | undefined;
  const app = createTelegramRoutes(async () => service, () => reason);
  const request = (body = '{}') => app.request('/telegram/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  expect((await request()).status).toBe(400); expect(beginSetup).not.toHaveBeenCalled();
  reason = 'webhooks_off';
  const blocked = await request(); expect(blocked.status).toBe(503);
  expect(await blocked.json()).toMatchObject({ code: 'webhooks_off' }); expect(beginSetup).not.toHaveBeenCalled();
  // Task control off: setup reaches the service (which gates by scope), approved-people edits do not.
  reason = 'flag_off';
  expect((await request(JSON.stringify({ token: `123456:${'A'.repeat(35)}`, dedicatedBot: true }))).status).toBe(201);
  expect(beginSetup).toHaveBeenCalledTimes(1);
  const patch = await app.request('/telegram/grants/00000000-0000-4000-8000-000000000000', { method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 'a'.repeat(64), permissions: ['respond'] }) });
  expect(patch.status).toBe(503); expect(await patch.json()).toMatchObject({ code: 'flag_off' }); expect(permissions).not.toHaveBeenCalled();
});
it('answers activity and setup reads empty while inbound is unavailable', async () => {
  const activity = vi.fn(() => ({ entries: [{ id: 'secret' }] })), setupStatus = vi.fn(() => ({ status: 'waiting' }));
  const inbound = { activity, setupStatus } as unknown as TelegramInbound;
  let reason: 'hosted' | 'webhooks_off' | 'flag_off' | undefined = 'hosted';
  const app = createTelegramRoutes(async () => inbound, () => reason);
  const id = '00000000-0000-4000-8000-000000000000';
  for (const next of ['hosted', 'webhooks_off'] as const) {
    reason = next;
    const listed = await app.request('/telegram/activity');
    expect(listed.status).toBe(200); expect(await listed.json()).toEqual({ entries: [] });
    const status = await app.request(`/telegram/setup/${id}`);
    expect(status.status).toBe(404); expect(await status.json()).toMatchObject({ code: 'pairing_expired' });
  }
  expect(activity).not.toHaveBeenCalled(); expect(setupStatus).not.toHaveBeenCalled();
  // Task control off: the journal stays hidden, a setup's own status is the service's call.
  reason = 'flag_off';
  expect(await (await app.request('/telegram/activity')).json()).toEqual({ entries: [] }); expect(activity).not.toHaveBeenCalled();
  expect((await app.request(`/telegram/setup/${id}`)).status).toBe(200); expect(setupStatus).toHaveBeenCalledTimes(1);
  setupStatus.mockClear();
  reason = undefined;
  expect((await app.request(`/telegram/setup/${id}`)).status).toBe(200); expect(setupStatus).toHaveBeenCalledTimes(1);
});
it('chains validated setup operations and never reflects a submitted token', async () => {
  const setupId = '00000000-0000-4000-8000-000000000000';
  const begun = { setupId, receiverId: 'receiver', bot: { id: '123', username: 'safe_bot' }, expiresAt: 1000, deepLink: 'https://t.me/safe_bot?start=x' };
  const beginSetup = vi.fn(async () => begun), setupStatus = vi.fn(() => ({ status: 'waiting' as const, receiverId: 'receiver', bot: begun.bot, inboundRevision: 'a'.repeat(64) }));
  const activateSetup = vi.fn(async () => ({ grant: {}, inboundRevision: 'b'.repeat(64) })), cancelSetup = vi.fn(() => ({ cancelled: true as const }));
  const app = createTelegramRoutes(async () => ({ beginSetup, setupStatus, activateSetup, cancelSetup } as unknown as TelegramInbound), () => undefined);
  const body = { receiverId: 'receiver', expectedRevision: 'a'.repeat(64), dedicatedBot: true, groupVisibilityAccepted: true };
  const response = await app.request('/telegram/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  expect(response.status).toBe(201); expect(result).toEqual(begun); expect(JSON.stringify(result)).not.toContain('token');
  const tokenBody = { token: `123456:${'A'.repeat(35)}`, name: 'Fresh', dedicatedBot: true };
  const tokenResponse = await app.request('/telegram/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(tokenBody) });
  expect(tokenResponse.status).toBe(201); expect(JSON.stringify(await tokenResponse.json())).not.toContain(tokenBody.token);
  expect((await app.request(`/telegram/setup/${setupId}`)).status).toBe(200);
  const activation = { activate: true, expectedRevision: 'a'.repeat(64), candidateUserId: '123', comparisonVerified: true, permissions: ['respond'] };
  expect((await app.request(`/telegram/setup/${setupId}/activate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(activation) })).status).toBe(200);
  expect((await app.request(`/telegram/setup/${setupId}`, { method: 'DELETE' })).status).toBe(200);
  expect(beginSetup).toHaveBeenCalledWith(body); expect(setupStatus).toHaveBeenCalledWith(setupId);
  expect(beginSetup).toHaveBeenCalledWith(tokenBody);
  expect(activateSetup).toHaveBeenCalledWith(setupId, activation); expect(cancelSetup).toHaveBeenCalledWith(setupId);
});
it('setup always needs the dedicated-bot acknowledgement and activation needs answering permission', async () => {
  const beginSetup = vi.fn(), activateSetup = vi.fn();
  const app = createTelegramRoutes(async () => ({ beginSetup, activateSetup } as unknown as TelegramInbound), () => undefined);
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect((await post('/telegram/setup', { receiverId: 'receiver', expectedRevision: 'a'.repeat(64) })).status).toBe(400);
  expect((await post('/telegram/setup', { receiverId: 'receiver', expectedRevision: 'a'.repeat(64), dedicatedBot: false })).status).toBe(400);
  const activate = { activate: true, expectedRevision: 'a'.repeat(64), candidateUserId: '123' };
  for (const extra of [{}, { permissions: ['cancel'] }]) expect((await post('/telegram/setup/00000000-0000-4000-8000-000000000000/activate', { ...activate, ...extra })).status).toBe(400);
  expect(beginSetup).not.toHaveBeenCalled(); expect(activateSetup).not.toHaveBeenCalled();
});
it('rejects a token-led setup before service work when dedicated-bot consent is absent', async () => {
  const beginSetup = vi.fn(), app = createTelegramRoutes(async () => ({ beginSetup } as unknown as TelegramInbound), () => undefined);
  const response = await app.request('/telegram/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: `123456:${'A'.repeat(35)}`, dedicatedBot: false }) });
  expect(response.status).toBe(400); expect(beginSetup).not.toHaveBeenCalled();
});
it('accepts explicit notifications-only activation without task-control permissions', async () => {
  const activateSetup = vi.fn(async () => ({ receiverId: 'receiver', inboundRevision: 'b'.repeat(64) }));
  const app = createTelegramRoutes(async () => ({ activateSetup } as unknown as TelegramInbound), () => undefined);
  const response = await app.request('/telegram/setup/00000000-0000-4000-8000-000000000000/activate', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ activate: true, expectedRevision: 'a'.repeat(64), candidateUserId: '123', taskControl: false }) });
  expect(response.status).toBe(200); expect(activateSetup).toHaveBeenCalled();
});
it('serves no separate pairing routes: guided setup is the only way to pair', async () => {
  const pair = vi.fn(), confirm = vi.fn(), pairing = vi.fn();
  const app = createTelegramRoutes(async () => ({ pair, confirm, pairing } as unknown as TelegramInbound), () => undefined);
  const id = '00000000-0000-4000-8000-000000000000', json = { 'content-type': 'application/json' };
  for (const [method, path] of [['POST', '/telegram/pairings'], ['GET', `/telegram/pairings/${id}`], ['POST', `/telegram/pairings/${id}/confirm`], ['DELETE', `/telegram/pairings/${id}`]] as const) {
    const response = await app.request(path, { method, headers: json, ...(method === 'POST' ? { body: JSON.stringify({ receiverId: 'r', expectedRevision: 'a'.repeat(64), dedicatedBot: true, candidateUserId: '1' }) } : {}) });
    expect(response.status, `${method} ${path}`).toBe(404);
  }
  expect(pair).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled(); expect(pairing).not.toHaveBeenCalled();
});
it('projects the setup recovery error matrix with exact statuses and schema', async () => {
  const setupId = '00000000-0000-4000-8000-000000000000';
  for (const [code, status] of [['invalid_token', 400], ['pairing_expired', 404], ['conflict', 409], ['blocked', 409],
    ['damaged_state', 409], ['vault_unavailable', 503]] as const) {
    const beginSetup = vi.fn(async () => { throw new TelegramInboundFailure(status, code); });
    const app = createTelegramRoutes(async () => ({ beginSetup } as unknown as TelegramInbound), () => undefined);
    const response = await app.request('/telegram/setup', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ receiverId: 'r', expectedRevision: 'a'.repeat(64), dedicatedBot: true }) });
    expect(response.status, code).toBe(status);
    expect(telegramDomainErrorSchema.parse(await response.json())).toEqual({ error: code, code });
  }
  for (const reason of ['hosted', 'flag_off'] as const) {
    const app = createTelegramRoutes(async () => undefined, () => reason);
    const read = await app.request(`/telegram/setup/${setupId}`);
    expect(read.status).toBe(404); expect(await read.json()).toEqual({ error: 'pairing_expired', code: 'pairing_expired' });
  }
});
it('preserves project-scope 404 and 409 failures before resolving setup state', async () => {
  const resolve = vi.fn(async () => undefined);
  for (const [projectId, status, code] of [['missing', 404, 'project_missing'], ['gone', 409, 'project_unavailable']] as const) {
    const family = createTelegramRoutes(resolve, () => undefined, async id => { if (id === projectId) throw new TelegramInboundFailure(status, code); });
    const app = new Hono().route('/p/:projectId', family);
    const response = await app.request(`/p/${projectId}/telegram`);
    expect(response.status).toBe(status); expect(await response.json()).toEqual({ error: code, code });
  }
  expect(resolve).not.toHaveBeenCalled();
});
it('gates setup mutations in hosted mode before service work', async () => {
  const beginSetup = vi.fn();
  const app = createTelegramRoutes(async () => ({ beginSetup } as unknown as TelegramInbound), () => 'hosted');
  const response = await app.request('/telegram/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ receiverId: 'r', expectedRevision: 'a'.repeat(64), dedicatedBot: true }) });
  expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ code: 'hosted' }); expect(beginSetup).not.toHaveBeenCalled();
});
