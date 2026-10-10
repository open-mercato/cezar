import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { previewGatewayResponseSchema } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { PreviewGateways } from './preview/gateway.ts';
import { createApp } from './server.ts';

/**
 * `POST /api/v1/preview/gateway` — the route behind the Browser column on a hosted cockpit (spec
 * `.ai/specs/2026-10-10-preview-gateway.md`).
 *
 * The gateway itself is `preview/gateway.test.ts`. Under test here is the route's policy: no
 * pool, no gateway (409); then the address (400); and the server never re-serving itself.
 */
describe('the preview-gateway API', () => {
  let repoRoot: string;
  let store: RunStore;
  let gateways: PreviewGateways | undefined;
  const saved = process.env.CEZ_PREVIEW_PORTS;

  const makeApp = (previewGateways?: PreviewGateways): Hono =>
    createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', previewGateways });

  const post = (app: Hono, body: unknown) =>
    apiRequest(app, '/api/v1/preview/gateway', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    delete process.env.CEZ_PREVIEW_PORTS;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-gateway-api-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    gateways = undefined;
  });
  afterEach(() => {
    gateways?.closeAll();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (saved === undefined) delete process.env.CEZ_PREVIEW_PORTS;
    else process.env.CEZ_PREVIEW_PORTS = saved;
  });

  it('does not exist by default: no pool was named, so nothing can be opened', async () => {
    const res = await post(makeApp(), { target: 'http://localhost:3000', parentOrigin: 'https://cezar.example.com' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('CEZ_PREVIEW_PORTS');
  });

  it('opens a gateway on a pool port, in the contract shape', async () => {
    // Port 0 is not a pool an operator can name (`parsePreviewPorts` drops it) — here it lets
    // the OS pick a free one, so the suite never fights another process for a fixed number.
    gateways = new PreviewGateways({ ports: [0] });
    const res = await post(makeApp(gateways), { target: 'http://localhost:3000', parentOrigin: 'https://cezar.example.com' });
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(previewGatewayResponseSchema.safeParse(body).success).toBe(true);
    expect((body as { origin: string }).origin).toMatch(/^https:\/\/cezar\.example\.com:\d+$/);
    expect((body as { ticketParam: string }).ticketParam).toBe('__cez_preview');
    expect(gateways.size).toBe(1);
  });

  it('answers 400 for an address that is not a local app', async () => {
    gateways = new PreviewGateways({ ports: [0] });
    const res = await post(makeApp(gateways), { target: 'https://example.com', parentOrigin: 'https://cezar.example.com' });
    expect(res.status).toBe(400);
    expect(gateways.size).toBe(0);
  });

  it('never re-serves the cockpit it was asked through', async () => {
    gateways = new PreviewGateways({ ports: [0] });
    const res = await apiRequest(makeApp(gateways), '/api/v1/preview/gateway', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'localhost:4321' },
      body: JSON.stringify({ target: 'http://127.0.0.1:4321', parentOrigin: 'http://localhost:4321' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('cezar itself');
    expect(gateways.size).toBe(0);
  });
});
