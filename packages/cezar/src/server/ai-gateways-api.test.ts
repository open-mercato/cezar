import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aiGatewaysResponseSchema, aiGatewayViewSchema } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { SecretStore } from '../workspace/secrets.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

const auth = {
  protocols: { 'openai-responses': 'bearer' },
  catalog: 'bearer',
};

describe('AI gateways HTTP API', () => {
  const savedHome = process.env.CEZ_HOME;
  let home: string;
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let secrets: SecretStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-ai-gateways-api-'));
    process.env.CEZ_HOME = home;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-ai-gateways-api-repo-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    secrets = new SecretStore(process.env, { keychain: async () => null });
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', secrets });
  });

  afterEach(() => {
    store.flush();
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
  });

  const request = (path: string, method: string, body?: unknown) => apiRequest(app, path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  it('starts with an empty list, then creates, enables, and removes without echoing the key', async () => {
    const listed = aiGatewaysResponseSchema.parse(await (await request('/api/v1/ai-gateways', 'GET')).json());
    expect(listed.gateways).toEqual([]);

    const secret = 'sk-route-do-not-echo';
    const createdRes = await request('/api/v1/ai-gateways', 'POST', {
      name: ' Sandbox ',
      baseUrl: 'https://gateway.example/v1',
      protocols: ['openai-responses'],
      auth,
      apiKey: secret,
      enabled: true,
    });
    expect(createdRes.status).toBe(200);
    const createdText = await createdRes.text();
    expect(createdText).not.toContain(secret);
    const created = aiGatewayViewSchema.parse(JSON.parse(createdText));
    expect(created).toMatchObject({
      name: 'Sandbox',
      baseUrl: 'https://gateway.example/v1',
      enabled: true,
      hasApiKey: true,
    });
    expect(created.pendingWrite).toBeUndefined();

    const renamed = aiGatewayViewSchema.parse(await (await request(`/api/v1/ai-gateways/${created.id}`, 'PATCH', { name: 'Renamed' })).json());
    expect(renamed).toMatchObject({ name: 'Renamed', routingRevision: created.routingRevision, hasApiKey: true });

    const disabled = aiGatewayViewSchema.parse(await (await request(`/api/v1/ai-gateways/${created.id}`, 'PATCH', { enabled: false })).json());
    expect(disabled.enabled).toBe(false);

    const slashed = await request('/api/v1/ai-gateways', 'POST', {
      name: 'Slash',
      baseUrl: 'https://gateway.example/v1/',
      protocols: ['openai-responses'],
      auth,
      apiKey: secret,
    });
    expect(slashed.status).toBe(400);
    expect(await slashed.text()).not.toContain(secret);

    const leaked = await request('/api/v1/ai-gateways', 'POST', {
      name: 'Bad',
      baseUrl: 'https://user:secret@gateway.example/v1',
      protocols: ['openai-responses'],
      auth,
      apiKey: secret,
    });
    expect(leaked.status).toBe(400);
    expect(await leaked.text()).not.toContain(secret);

    expect((await request('/api/v1/ai-gateways/not-a-uuid', 'DELETE')).status).toBe(400);
    expect((await request('/api/v1/ai-gateways/550e8400-e29b-41d4-a716-446655440000', 'DELETE')).status).toBe(404);

    const removed = await request(`/api/v1/ai-gateways/${created.id}`, 'DELETE');
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ removed: true });
    const after = aiGatewaysResponseSchema.parse(await (await request('/api/v1/ai-gateways', 'GET')).json());
    expect(after.gateways).toEqual([]);
    expect((await request('/api/v1/p/default/ai-gateways', 'GET')).status).toBe(404);
  });
});
