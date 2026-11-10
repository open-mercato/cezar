import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { modelGatewayStateSchema } from '@open-mercato/cezar-contract';

import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { ModelGatewayStore } from '../workspace/model-gateway.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp, type ServerDeps } from './server.ts';

/** `/api/v1/workspace/model-gateway` (spec 2026-11-10-model-gateway). */

const KEY = 'acme-secret-key-123';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('/api/v1/workspace/model-gateway', () => {
  let root: string;
  let store: RunStore;
  let gateway: ModelGatewayStore;
  let invalidate: ReturnType<typeof vi.fn>;
  let fetch: ReturnType<typeof vi.fn>;
  let opencode: 'connected' | 'disconnected';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-gateway-api-'));
    vi.stubEnv('CEZ_HOME', join(root, 'home'));
    vi.stubEnv('CEZ_DRY_RUN', '0');
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(root, '.ai/cezar'));
    gateway = new ModelGatewayStore(process.env, { keychain: async () => null });
    invalidate = vi.fn();
    fetch = vi.fn(async () => json({ data: [{ id: 'acme-coder' }] }));
    opencode = 'disconnected';
  });
  afterEach(() => {
    store.flush();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const app = () => createApp({
    repoRoot: root,
    store,
    manager: {} as RunManager,
    version: 'test',
    modelGateway: gateway,
    modelGatewayFetch: fetch as unknown as typeof globalThis.fetch,
    modelCatalog: { get: vi.fn(), invalidate } as unknown as ServerDeps['modelCatalog'],
    providerAuth: {
      status: async () => ({ providers: [{ provider: 'opencode', status: opencode }] }),
    } as unknown as ServerDeps['providerAuth'],
  });
  const put = (body: unknown): RequestInit => ({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('stores a custom gateway, answers everything but the key, and tells OpenCode’s catalog', async () => {
    const instance = app();
    const empty = modelGatewayStateSchema.parse(await (await apiRequest(instance, '/api/v1/workspace/model-gateway')).json());
    expect(empty.gateway).toBeNull();
    expect(empty.presets.map((preset) => preset.id)).toEqual(['openrouter', 'custom']);

    const saved = await apiRequest(instance, '/api/v1/workspace/model-gateway', put({ preset: 'custom', name: 'Acme API', baseUrl: 'https://api.acme.example/v1', apiKey: KEY }));
    expect(saved.status).toBe(200);
    const text = await saved.text();
    expect(text).not.toContain(KEY);
    expect(modelGatewayStateSchema.parse(JSON.parse(text)).gateway).toMatchObject({ preset: 'custom', name: 'Acme API', models: ['acme-coder'] });
    expect(invalidate).toHaveBeenCalledWith('opencode');
    expect((await gateway.read())?.apiKey).toBe(KEY);
    expect(await (await apiRequest(instance, '/api/v1/workspace/model-gateway')).text()).not.toContain(KEY);
  });

  it('refuses a key the gateway rejects, and stores nothing', async () => {
    fetch.mockImplementation(async () => json({}, 401));
    const response = await apiRequest(app(), '/api/v1/workspace/model-gateway', put({ preset: 'custom', name: 'Acme', baseUrl: 'https://api.acme.example/v1', apiKey: KEY }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain('rejected this key');
    expect(gateway.configured()).toBe(false);
  });

  it.each([
    ['an unknown preset', { preset: 'nope', apiKey: KEY }],
    ['a custom gateway without its address', { preset: 'custom', name: 'Acme', apiKey: KEY }],
    ['a non-http address', { preset: 'custom', name: 'Acme', baseUrl: 'file:///etc/passwd', apiKey: KEY }],
    ['an address for OpenRouter', { preset: 'openrouter', apiKey: KEY, baseUrl: 'https://evil.example' }],
  ])('refuses %s before calling anything', async (_name, body) => {
    expect((await apiRequest(app(), '/api/v1/workspace/model-gateway', put(body))).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('removes it', async () => {
    const instance = app();
    await apiRequest(instance, '/api/v1/workspace/model-gateway', put({ preset: 'openrouter', apiKey: KEY }));
    const removed = await apiRequest(instance, '/api/v1/workspace/model-gateway', { method: 'DELETE' });
    expect(modelGatewayStateSchema.parse(await removed.json()).gateway).toBeNull();
    expect(gateway.configured()).toBe(false);
  });

  it('says so when a stored gateway cannot be decrypted', async () => {
    await gateway.save({ preset: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: KEY, models: [], updatedAt: 'now' });
    rmSync(join(root, 'home', 'secrets', '.key'), { force: true });
    const state = modelGatewayStateSchema.parse(await (await apiRequest(app(), '/api/v1/workspace/model-gateway')).json());
    expect(state.gateway).toBeNull();
    expect(state.error).toContain('cannot be read');
  });
});
