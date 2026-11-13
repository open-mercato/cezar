import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildChildEnv } from '../core/agent-env.ts';
import {
  discoverGatewayModels,
  GATEWAY_KEY_ENV,
  gatewayAgentEnv,
  ModelGatewayStore,
  resolveGatewayInput,
  type StoredModelGateway,
} from './model-gateway.ts';

/** Spec 2026-11-10-model-gateway: the key is sealed at rest and reaches OpenCode alone. */

const custom: StoredModelGateway = {
  preset: 'custom', name: 'Acme API', baseUrl: 'https://api.acme.example/v1', apiKey: 'acme-secret-key-123',
  models: ['acme-coder', 'acme-large'], updatedAt: '2026-11-10T00:00:00.000Z',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('ModelGatewayStore', () => {
  let home: string;
  let store: ModelGatewayStore;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-gateway-'));
    store = new ModelGatewayStore({ CEZ_HOME: home }, { keychain: async () => null });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('reads nothing before a save, and the key back after one', async () => {
    expect(store.configured()).toBe(false);
    expect(await store.read()).toBeNull();
    expect(await store.agentEnv()).toEqual({});
    await store.save(custom);
    expect(store.configured()).toBe(true);
    expect(await store.read()).toEqual(custom);
  });

  it('never writes the key in the clear, and keeps the file private', async () => {
    await store.save(custom);
    const dir = join(home, 'model-gateway');
    for (const name of readdirSync(dir)) expect(readFileSync(join(dir, name), 'utf8')).not.toContain(custom.apiKey);
    if (process.platform !== 'win32') expect(statSync(join(dir, 'gateway.vault')).mode & 0o777).toBe(0o600);
  });

  it('forgets it on remove, and a second remove is fine', async () => {
    await store.save(custom);
    await store.remove();
    await store.remove();
    expect(store.configured()).toBe(false);
    expect(await store.read()).toBeNull();
  });
});

describe('gatewayAgentEnv', () => {
  it('declares a custom gateway to OpenCode with the key read from the environment, never inlined', () => {
    const env = gatewayAgentEnv(custom);
    expect(env[GATEWAY_KEY_ENV]).toBe(custom.apiKey);
    expect(env.OPENCODE_CONFIG_CONTENT).not.toContain(custom.apiKey);
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({
      provider: {
        'acme-api': {
          npm: '@ai-sdk/openai-compatible',
          name: 'Acme API',
          options: { baseURL: 'https://api.acme.example/v1', apiKey: `{env:${GATEWAY_KEY_ENV}}` },
          models: { 'acme-coder': {}, 'acme-large': {} },
        },
      },
    });
  });

  it('gives OpenRouter, which OpenCode already knows, only its own key variable', () => {
    expect(gatewayAgentEnv({ ...custom, preset: 'openrouter', models: [] })).toEqual({ OPENROUTER_API_KEY: custom.apiKey });
  });

  it('is not something any backend picks up from the host by itself', () => {
    const host = { PATH: '/bin', [GATEWAY_KEY_ENV]: 'leaked' };
    for (const backend of ['claude', 'codex', 'opencode', 'cursor', 'pi'] as const) {
      expect(buildChildEnv({ backend, source: host })[GATEWAY_KEY_ENV]).toBeUndefined();
    }
  });
});

describe('resolveGatewayInput', () => {
  it('lists a custom gateway’s models from its own endpoint, with the key', async () => {
    const fetch = vi.fn(async () => json({ object: 'list', data: [{ id: 'acme-coder' }, { id: 'acme-large' }, { id: 'acme-coder' }] }));
    const record = await resolveGatewayInput({ preset: 'custom', name: 'Acme API', baseUrl: 'https://api.acme.example/v1/', apiKey: custom.apiKey }, { fetch, now: () => new Date(custom.updatedAt) });
    expect(record).toEqual(custom);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.acme.example/v1/models');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${custom.apiKey}`);
  });

  it('takes the model ids it is given without asking', async () => {
    const fetch = vi.fn();
    const record = await resolveGatewayInput({ preset: 'custom', name: 'Acme API', baseUrl: custom.baseUrl, apiKey: custom.apiKey, models: ['m1'] }, { fetch });
    expect(record.models).toEqual(['m1']);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('checks an OpenRouter key against OpenRouter', async () => {
    const fetch = vi.fn(async () => json({ data: {} }));
    const record = await resolveGatewayInput({ preset: 'openrouter', apiKey: 'sk-or-v1-abcdef' }, { fetch });
    expect(record).toMatchObject({ preset: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', models: [] });
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe('https://openrouter.ai/api/v1/key');
  });

  it.each([
    ['a rejected key', async () => json({}, 401), 'rejected this key'],
    ['an unreachable host', async () => { throw new TypeError('fetch failed'); }, 'Could not reach api.acme.example'],
    ['an endpoint with no model list', async () => json({ hello: 1 }), 'Enter the model ids yourself'],
    ['an endpoint that errors', async () => json({}, 500), 'answered 500'],
  ])('refuses %s with a sentence', async (_name, impl, message) => {
    await expect(discoverGatewayModels(custom.baseUrl, custom.apiKey, vi.fn(impl) as unknown as typeof fetch)).rejects.toThrow(message);
  });
});
