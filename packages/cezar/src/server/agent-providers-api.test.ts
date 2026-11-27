import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { agentProvidersResponseSchema } from '@open-mercato/cezar-contract';
import { agentProvidersRoutes } from './agent-providers-routes.ts';
import { providerCatalog } from '../agent-providers/service.ts';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'cez-provider-api-'));
  vi.stubEnv('CEZ_HOME', home);
  vi.stubEnv('CEZ_SECRETS_KEYCHAIN', '0');
  vi.stubEnv('CEZ_DRY_RUN', '1');
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); });

const app = (local: boolean) => new Hono().route('/api/v1', agentProvidersRoutes(() => local,
  async () => [{ provider: 'claude', status: 'connected' }]));
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
