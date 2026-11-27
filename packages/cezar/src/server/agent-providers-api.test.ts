import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readAgentProviders } from '../workspace/agent-providers.ts';
import { Hono } from 'hono';
import { agentProvidersResponseSchema } from '@open-mercato/cezar-contract';
import { agentProvidersRoutes } from './agent-providers-routes.ts';
import { applyProviderChanges, configuredAuthStatus, providerCatalog, providerEntry, providerModelAdmission, refreshProviderModels } from '../agent-providers/service.ts';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'cez-provider-api-'));
  vi.stubEnv('CEZ_HOME', home);
  vi.stubEnv('CEZ_SECRETS_KEYCHAIN', '0');
  vi.stubEnv('CEZ_DRY_RUN', '1');
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); });

const app = (local: boolean) => new Hono().route('/api/v1', agentProvidersRoutes(() => local,
  async () => [{ provider: 'claude', status: 'connected', methods: { subscription: 'connected' } }]));
const base = '/api/v1/agent-providers';
const put = (body: unknown) => ({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

it('saves write-only keys, serves the active catalog and keeps other connected methods available', async () => {
  const server = app(true);
  const path = base + '/claude/methods/openrouter';
  const value = 'provider-fixture-only-5544';
  const saved = await server.request(path, put({ kind: 'openrouter', apiKey: value }));
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ state: 'connected', keyHint: '…5544', modelCount: 2 });
  expect((await server.request(base + '/claude/active', put({ methodId: 'openrouter' }))).status).toBe(200);
  const state = await (await server.request(base)).json();
  expect(JSON.stringify(state)).not.toContain(value);
  expect(JSON.stringify(state)).not.toContain('keyRef');
  const claude = agentProvidersResponseSchema.parse(state).agents.find(a => a.runner === 'claude');
  expect(claude).toMatchObject({ active: 'openrouter', methods: expect.arrayContaining([
    expect.objectContaining({ kind: 'subscription', state: 'connected' }),
  ]) });
  const native = vi.fn();
  const catalog = await providerCatalog('claude', native);
  expect(native).not.toHaveBeenCalled();
  expect(catalog.models.map(m => m.id)).toEqual(['anthropic/test-model', 'test-model']);
  expect(catalog.models[1]).toMatchObject({ description: 'May not support tools', via: { methodId: 'openrouter' } });
  expect((await server.request(path, { method: 'DELETE' })).status).toBe(204);
  const entry = agentProvidersResponseSchema.parse(await (await server.request(base)).json());
  expect(entry.agents.find(a => a.runner === 'claude')?.active).toBe(null);
});

it('refuses every remote mutation before parsing the secret body, while serving status', async () => {
  const server = app(false);
  const path = base + '/claude/methods/openrouter';
  expect(await (await server.request(base)).json()).toMatchObject({ editable: false });
  for (const [url, method] of [[path, 'PUT'], [path, 'DELETE'], [path + '/models', 'POST'], [base + '/claude/active', 'PUT']]) {
    expect((await server.request(url!, { method })).status).toBe(409);
  }
});

it('requires an explicit new key before changing a custom endpoint to another origin', async () => {
  const server = app(true);
  const url = base + '/codex/methods/custom';
  const input = { kind: 'custom', baseUrl: 'https://first.test', apiKey: 'provider-fixture-only-5544' };
  expect((await server.request(url, put(input))).status).toBe(200);
  expect((await server.request(url, put({ kind: 'custom', baseUrl: 'https://second.test' }))).status).toBe(400);
});

it('retains the last good catalog on a refresh error and never returns the upstream body', async () => {
  const server = app(true);
  const path = base + '/claude/methods/openrouter';
  await server.request(path, put({ kind: 'openrouter', apiKey: 'provider-fixture-only-5544' }));
  vi.stubEnv('CEZ_DRY_RUN', '0');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream debug provider-fixture-only-5544', { status: 502 })));
  try {
    const retry = await server.request(path + '/models', { method: 'POST' });
    expect(retry.status).toBe(400);
    expect(await retry.text()).not.toContain('provider-fixture-only-5544');
    const state = agentProvidersResponseSchema.parse(await (await server.request(base)).json());
    const method = state.agents.find(a => a.runner === 'claude')?.methods.find(m => m.id === 'openrouter');
    expect(method).toMatchObject({ state: 'connected', modelCount: 2, error: expect.stringContaining('retry') });
  } finally { vi.unstubAllGlobals(); }
});

it('keeps an initial failed discovery unavailable and lets a local retry restore it', async () => {
  const server = app(true);
  const path = base + '/codex/methods/custom';
  vi.stubEnv('CEZ_DRY_RUN', '0');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502 })));
  try {
    const response = await server.request(path, put({ kind: 'custom', baseUrl: 'https://gateway.test', apiKey: 'fixture-only-test-4433' }));
    expect(await response.json()).toMatchObject({ state: 'error', modelCount: 0 });
    expect((await server.request(base + '/codex/active', put({ methodId: 'custom' }))).status).toBe(400);
    vi.stubEnv('CEZ_DRY_RUN', '1');
    expect((await server.request(path + '/models', { method: 'POST' })).status).toBe(200);
    expect((await server.request(base + '/codex/active', put({ methodId: 'custom' }))).status).toBe(200);
  } finally { vi.unstubAllGlobals(); }
});

it.each([true, false])('keeps a newer successful catalog fresh when an earlier refresh finishes last (success=%s)', async success => {
  await applyProviderChanges([{ runner: 'codex', active: 'custom', methods: [
    { id: 'custom', baseUrl: 'https://gateway.test', apiKey: 'test-fixture-key' },
  ] }], 'cli', []);
  vi.stubEnv('CEZ_DRY_RUN', '0');
  let finishSlow!: (response: Response) => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  vi.stubGlobal('fetch', vi.fn()
    .mockImplementationOnce(() => new Promise<Response>(resolve => { finishSlow = resolve; started(); }))
    .mockResolvedValueOnce(Response.json({ data: [{ id: 'newest-model' }] })));
  try {
    const slow = refreshProviderModels('codex', 'custom');
    await waiting;
    expect(await refreshProviderModels('codex', 'custom')).toEqual({ models: ['newest-model'] });
    finishSlow(success ? Response.json({ data: [{ id: 'retired-model' }] }) : new Response(null, { status: 502 }));
    expect(await slow).toMatchObject({ models: ['newest-model'] });
    const catalog = await providerCatalog('codex', vi.fn());
    expect(catalog).toMatchObject({ stale: false, models: [{ id: 'newest-model' }] });
  } finally { vi.unstubAllGlobals(); }
});

it('adds only connected native methods to a configured additive catalog', async () => {
  await app(true).request(base + '/pi/methods/openrouter', put({ kind: 'openrouter', apiKey: 'fixture-provider' }));
  const native = vi.fn(async () => ({
    runner: 'pi' as const, source: 'cache' as const, stale: false,
    models: ['anthropic/native', 'openai-codex/unverified'].map(id => ({ id, label: id, description: '' })),
  }));
  const catalog = await providerCatalog('pi', native, () => ({
    provider: 'pi', status: 'connected', methods: { anthropic: 'connected' },
  }));
  expect(catalog.models.map(m => [m.id, m.via?.methodId])).toEqual([
    ['anthropic/native', 'anthropic'], ['anthropic/test-model', 'openrouter'], ['test-model', 'openrouter'],
  ]);
});

it('offers guarded OMP native subscriptions beside a saved gateway without claiming OAuth is connected', async () => {
  await app(true).request(base + '/omp/methods/custom', put({ kind: 'custom', baseUrl: 'https://gateway.test', apiKey: 'fixture-only' }));
  const login = { provider: 'omp' as const, status: 'unknown' as const, methods: { 'openai-codex': 'disconnected' as const } };
  const catalog = await providerCatalog('omp', async () => ({
    runner: 'omp', source: 'live', stale: false,
    models: ['anthropic/native', 'openai-codex/signed-out', 'other/native'].map(id => ({ id, label: id, description: '' })),
  }), () => login);
  expect(catalog.models.map(m => [m.id, m.via?.methodId])).toEqual([
    ['anthropic/native', 'anthropic'], ['anthropic/test-model', 'custom'], ['test-model', 'custom'],
  ]);
  expect(providerEntry('omp', await readAgentProviders(), login).methods.find(m => m.id === 'anthropic')?.state).toBe('unknown');
});

it.each(['copilot', 'antigravity', 'junie'] as const)('can select the %s vendor login with an inconclusive method probe', async runner => {
  const login = { provider: runner, status: 'connected' as const };
  await applyProviderChanges([{ runner, active: 'subscription', methods: [] }], 'cli', [login]);
  const store = await readAgentProviders();
  const method = providerEntry(runner, store, login).methods[0];
  expect(method).toMatchObject({ state: 'unknown', verifyAtLaunch: true });
  expect((await configuredAuthStatus(store, login, 'subscription')).status).toBe('connected');
  expect(providerEntry(runner, store, { ...login, authFailureId: 'incident' }).methods[0]).not.toHaveProperty('verifyAtLaunch');
});

it('uses only native model discovery under the operator authentication lock', async () => {
  await app(true).request(base + '/codex/methods/custom', put({ kind: 'custom', baseUrl: 'https://gateway.test', apiKey: 'fixture-only' }));
  await app(true).request(base + '/codex/active', put({ methodId: 'custom' }));
  vi.stubEnv('CEZ_AGENT_MODELS_LOCKED', '1');
  expect(await (await app(true).request(base)).json()).toMatchObject({ nativeAuth: true });
  const catalog = { runner: 'codex' as const, models: [], source: 'cache' as const, stale: false };
  expect(await providerCatalog('codex', async () => catalog)).toEqual(catalog);
});

it('can return to a Kimi subscription verified at launch after removing a gateway', async () => {
  const login = { provider: 'kimi' as const, status: 'connected' as const };
  const server = new Hono().route('/api/v1', agentProvidersRoutes(() => true, async () => [login]));
  const path = base + '/kimi/methods/custom';
  expect((await server.request(path, put({ kind: 'custom', baseUrl: 'https://gateway.test', apiKey: 'fixture-only' }))).status).toBe(200);
  expect((await server.request(base + '/kimi/active', put({ methodId: 'custom' }))).status).toBe(200);
  expect((await server.request(path, { method: 'DELETE' })).status).toBe(204);
  const select = () => server.request(base + '/kimi/active', put({ methodId: 'subscription' }));
  expect((await select()).status).toBe(200);
  const state = await readAgentProviders();
  expect(providerEntry('kimi', state, login)).toMatchObject({ active: 'subscription', methods: expect.arrayContaining([
    expect.objectContaining({ id: 'subscription', state: 'unknown' }),
  ]) });
  expect((await configuredAuthStatus(state, login)).status).toBe('connected');
  expect((await configuredAuthStatus(state, { ...login, status: 'disconnected' })).status).toBe('disconnected');
  const native = vi.fn(async () => ({ runner: 'kimi' as const, source: 'live' as const, stale: false,
    models: [{ id: 'kimi-code/native', label: 'Native', description: '' }] }));
  expect((await providerCatalog('kimi', native, () => login)).models[0]?.via?.methodId).toBe('subscription');
});

it('uses a detected vendor key without attributing an unverified subscription', () => {
  vi.stubEnv('GEMINI_API_KEY', '');
  const entry = providerEntry('gemini', { agents: {} }, {
    provider: 'gemini', status: 'connected', methods: { apiKey: 'connected' },
  });
  expect(entry).toMatchObject({ active: 'apiKey', methods: expect.arrayContaining([
    expect.objectContaining({ id: 'apiKey', origin: 'host', state: 'connected' }),
  ]) });
});

it('admits an otherwise foreign native model only from the selected or recorded gateway', async () => {
  vi.stubEnv('CEZ_DRY_RUN', '0');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ id: 'anthropic/claude-sonnet-5' }] })));
  const server = app(true);
  try {
    await server.request(base + '/codex/methods/custom', put({ kind: 'custom', baseUrl: 'https://gateway.test', apiKey: 'fixture-only' }));
    const model = 'anthropic/claude-sonnet-5';
    expect(await providerModelAdmission('codex', model)).toEqual({});
    expect(await providerModelAdmission('codex', model, 'custom')).toEqual({ providerModel: model });
    await server.request(base + '/codex/active', put({ methodId: 'custom' }));
    expect(await providerModelAdmission('codex', model)).toEqual({ providerModel: model });
    expect(await providerModelAdmission('codex', 'anthropic/claude-opus-9')).toEqual({});
  } finally { vi.unstubAllGlobals(); }
});
