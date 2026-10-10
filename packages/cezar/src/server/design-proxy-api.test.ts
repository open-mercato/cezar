import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { designProxyResponseSchema } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { DesignProxies } from './preview/design-proxy.ts';
import { createApp } from './server.ts';

/**
 * `POST /api/v1/preview/design-proxy` — the route behind the Browser column's Design Mode (spec
 * `.ai/specs/2026-10-09-design-mode.md`).
 *
 * The proxy itself is `preview/design-proxy.test.ts`. Under test here is the route's policy:
 * capability first (409), then the address (400), and the server never mirroring itself.
 */
describe('the design-proxy API', () => {
  let repoRoot: string;
  let store: RunStore;
  let proxies: DesignProxies;
  let app: Hono;
  const env = { remote: process.env.CEZ_REMOTE, design: process.env.CEZ_DESIGN_MODE };

  const post = (body: unknown) =>
    apiRequest(app, '/api/v1/preview/design-proxy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    delete process.env.CEZ_REMOTE;
    delete process.env.CEZ_DESIGN_MODE;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-design-api-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    proxies = new DesignProxies();
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', designProxies: proxies });
  });
  afterEach(() => {
    proxies.closeAll();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    for (const [name, value] of [['CEZ_REMOTE', env.remote], ['CEZ_DESIGN_MODE', env.design]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('opens a mirror for a loopback dev server, in the contract shape', async () => {
    const res = await post({ target: 'http://localhost:5173', parentOrigin: 'http://localhost:4321' });
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(designProxyResponseSchema.safeParse(body).success).toBe(true);
    expect((body as { origin: string }).origin).toMatch(/^http:\/\/localhost:\d+$/);
    expect(proxies.size).toBe(1);
  });

  it('refuses an address that is not a local http dev server with 400', async () => {
    const res = await post({ target: 'https://github.com', parentOrigin: 'http://localhost:4321' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.any(String) });
    expect(proxies.size).toBe(0);
  });

  it('refuses a malformed body in middleware', async () => {
    expect((await post({ target: 5 })).status).toBe(400);
    expect(proxies.size).toBe(0);
  });

  it('answers 409 and opens nothing when CEZ_DESIGN_MODE=0', async () => {
    process.env.CEZ_DESIGN_MODE = '0';
    const res = await post({ target: 'http://localhost:5173', parentOrigin: 'http://localhost:4321' });
    expect(res.status).toBe(409);
    expect(proxies.size).toBe(0);
  });

  it('answers 409 on a hosted cockpit, where a loopback mirror reaches nobody', async () => {
    process.env.CEZ_REMOTE = '1';
    const res = await post({ target: 'http://localhost:5173', parentOrigin: 'http://localhost:4321' });
    expect(res.status).toBe(409);
    expect(proxies.size).toBe(0);
  });
});
