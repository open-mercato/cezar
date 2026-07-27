import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.js';
import type { RunManager, StartRunInput } from '../workflows/run.js';
import type { WorkflowDef } from '../workflows/types.js';
import { createApp } from './server.js';

/**
 * Request-origin guard (#426). The server executes agents with shell access,
 * so "bind 127.0.0.1 + same-origin" is not a perimeter on its own: a Host
 * allowlist kills DNS rebinding and an Origin match kills blind CSRF. Both are
 * zero-config and must leave the cockpit's own same-origin traffic, the SSE
 * reads and the intentionally-open /api/health probe untouched.
 */
describe('request-origin guard (#426)', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  const savedRemote = process.env.CEZ_REMOTE;
  const savedDryRun = process.env.CEZ_DRY_RUN;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-guard-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    delete process.env.CEZ_REMOTE;
    process.env.CEZ_DRY_RUN = '1'; // keeps the /api/health probe off the network
    // Capturing stub (the start-run.test.ts pattern) — the guard runs before
    // the handler, so a real run only needs to prove the request got through.
    const manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) =>
        store.createRun({ title: 't', workflow: '(planned)', task: input.task, steps: [] }),
    } as unknown as RunManager;
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = savedRemote;
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  const LOOPBACK = '127.0.0.1:4321';
  const startBody = { task: 'do the thing', steps: [{ id: 'work', prompt: '{{task}}' }] };

  const postRuns = (headers: Record<string, string>) =>
    app.request('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(startBody),
    });

  // ---- CSRF: cross-origin writes ------------------------------------------

  it('rejects a cross-origin mutating request (blind CSRF) with 403', async () => {
    const res = await postRuns({ host: LOOPBACK, origin: 'https://evil.tld' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain('cross-origin');
    expect(store.listRuns()).toHaveLength(0); // never reached the manager
  });

  it('rejects a request carrying Sec-Fetch-Site: cross-site with 403', async () => {
    const res = await postRuns({ host: LOOPBACK, 'sec-fetch-site': 'cross-site' });
    expect(res.status).toBe(403);
    expect(store.listRuns()).toHaveLength(0);
  });

  it('rejects an opaque "null" Origin (sandboxed iframe) with 403', async () => {
    const res = await postRuns({ host: LOOPBACK, origin: 'null' });
    expect(res.status).toBe(403);
    expect(store.listRuns()).toHaveLength(0);
  });

  // ---- DNS rebinding: foreign Host ----------------------------------------

  it('rejects a mutating request with a foreign Host header (DNS rebinding) with 403', async () => {
    const res = await postRuns({ host: 'evil.tld', origin: 'http://evil.tld' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain('Host');
    expect(store.listRuns()).toHaveLength(0);
  });

  it('rejects even a READ with a foreign Host header (rebinding exfiltration) with 403', async () => {
    const res = await app.request('/api/runs', { headers: { host: 'evil.tld' } });
    expect(res.status).toBe(403);
  });

  // The allowlist must match loopback *addresses*, not a `127.` string prefix:
  // an attacker can register any of these hostnames, point them at 127.0.0.1
  // and be genuinely same-origin with the cockpit, which satisfies the Origin
  // and Sec-Fetch-Site checks too. A prefix match hands them the whole API.
  const REBINDING_HOSTS = ['127.0.0.1.evil.com', '127.evil.com', '127.0.0.1.nip.io', '1270.0.0.1', '127.0.0.1x'];

  for (const host of REBINDING_HOSTS) {
    it(`rejects a READ whose Host is the rebinding hostname ${host} → 403`, async () => {
      const res = await app.request('/api/runs', { headers: { host: `${host}:4321` } });
      expect(res.status).toBe(403);
    });

    it(`rejects the same-origin RCE write from rebinding hostname ${host} → 403`, async () => {
      // The full attack: the page really is served from `host`, so Origin
      // matches Host and the browser reports same-origin. Only the anchored
      // Host allowlist can stop this one.
      const res = await postRuns({
        host: `${host}:4321`,
        origin: `http://${host}:4321`,
        'sec-fetch-site': 'same-origin',
      });
      expect(res.status).toBe(403);
      expect(store.listRuns()).toHaveLength(0); // no run created — RCE path closed
    });
  }

  // ---- a missing Host is untrusted, not "defaulted to loopback" ------------

  it('rejects a write with no Host and no Origin header → 403', async () => {
    const res = await postRuns({});
    expect(res.status).toBe(403);
    expect(store.listRuns()).toHaveLength(0);
  });

  it('rejects a read with no Host header → 403', async () => {
    const res = await app.request('/api/runs', { headers: {} });
    expect(res.status).toBe(403);
  });

  // ---- loopback spellings that must NOT fail closed ------------------------

  it('allows a trailing-dot FQDN loopback Host (localhost.) → 201', async () => {
    const res = await postRuns({ host: 'localhost.:4321', origin: 'http://localhost.:4321' });
    expect(res.status).toBe(201);
    expect(store.listRuns()).toHaveLength(1);
  });

  // Guard-layer behavior only: over a real socket `@hono/node-server` rejects an
  // expanded IPv6 Host with its own 400 "Invalid host header" (it compares the
  // header against `new URL().hostname`, which compresses) before our middleware
  // runs. That fails closed, so this asserts the guard does not add a *second*
  // reason to refuse a spelling of loopback.
  it('allows the expanded IPv6 loopback Host (0:0:0:0:0:0:0:1) → 201', async () => {
    const res = await postRuns({
      host: '[0:0:0:0:0:0:0:1]:4321',
      origin: 'http://[0:0:0:0:0:0:0:1]:4321',
    });
    expect(res.status).toBe(201);
    expect(store.listRuns()).toHaveLength(1);
  });

  it('allows other addresses inside 127.0.0.0/8 (127.0.0.2) → 201', async () => {
    const res = await postRuns({ host: '127.0.0.2:4321', origin: 'http://127.0.0.2:4321' });
    expect(res.status).toBe(201);
    expect(store.listRuns()).toHaveLength(1);
  });

  // ---- the cockpit's own same-origin traffic passes -----------------------

  it('allows the cockpit same-origin write (Origin === Host, loopback) → 201', async () => {
    const res = await postRuns({ host: LOOPBACK, origin: 'http://127.0.0.1:4321' });
    expect(res.status).toBe(201);
    expect(store.listRuns()).toHaveLength(1);
  });

  it('allows a same-origin write with no Origin header (non-browser caller) → 201', async () => {
    const res = await postRuns({ host: LOOPBACK });
    expect(res.status).toBe(201);
    expect(store.listRuns()).toHaveLength(1);
  });

  it('allows the dev-proxy write where a loopback Origin differs from a loopback Host → 201', async () => {
    // `npm run dev`: Vite (localhost:5173) proxies to the cockpit with
    // changeOrigin, so Host becomes 127.0.0.1 while the Origin stays localhost.
    // Verified against the real proxy: it rewrites Host but forwards both the
    // browser's Origin and its `Sec-Fetch-Site: same-origin`.
    const res = await postRuns({
      host: '127.0.0.1:4321',
      origin: 'http://localhost:5173',
      'sec-fetch-site': 'same-origin',
    });
    expect(res.status).toBe(201);
    expect(store.listRuns()).toHaveLength(1);
  });

  // ---- a different port is a different origin -----------------------------

  it('rejects a write from another loopback PORT (local dev server / local XSS) → 403', async () => {
    // A page on http://localhost:3000 is as foreign as evil.tld: matching on
    // hostname alone would hand every local dev server a shell here. Real
    // browsers label this `same-site`, NOT `same-origin`, so the dev-proxy
    // exemption does not cover it.
    const res = await postRuns({
      host: 'localhost:4321',
      origin: 'http://localhost:3000',
      'sec-fetch-site': 'same-site',
    });
    expect(res.status).toBe(403);
    expect(store.listRuns()).toHaveLength(0);
  });

  it('rejects a cross-port loopback write that sends no Sec-Fetch-Site → 403', async () => {
    const res = await postRuns({ host: '127.0.0.1:4321', origin: 'http://127.0.0.1:9999' });
    expect(res.status).toBe(403);
    expect(store.listRuns()).toHaveLength(0);
  });

  it('rejects a cross-scheme write on the matching port → 403', async () => {
    // https://127.0.0.1:4321 is a different origin from the http cockpit; the
    // authority comparison catches it because URL.port keeps the explicit 4321.
    const res = await postRuns({ host: '127.0.0.1:443', origin: 'https://127.0.0.1' });
    expect(res.status).toBe(403);
    expect(store.listRuns()).toHaveLength(0);
  });

  it('does not let a forged Sec-Fetch-Site readmit a NON-loopback cross-origin write → 403', async () => {
    const res = await postRuns({
      host: '127.0.0.1:4321',
      origin: 'https://evil.tld',
      'sec-fetch-site': 'same-origin',
    });
    expect(res.status).toBe(403);
    expect(store.listRuns()).toHaveLength(0);
  });

  // ---- malformed authorities must not normalize down to a loopback name ----

  it.each([
    '[::1]@evil.com',
    '[::1]evil.com',
    '127.0.0.1%2eevil.com',
    'localhost%.evil.com',
    '127.0.0.1:evil.com',
    'evil.com:80:127.0.0.1',
  ])('rejects the malformed/spoofing Host %s → 403', async (host) => {
    const res = await app.request('/api/runs', { headers: { host } });
    expect(res.status).toBe(403);
  });

  it('allows an IPv6 loopback same-origin write ([::1]) → 201', async () => {
    const res = await postRuns({ host: '[::1]:4321', origin: 'http://[::1]:4321' });
    expect(res.status).toBe(201);
    expect(store.listRuns()).toHaveLength(1);
  });

  // ---- reads and the SSE / health surfaces stay unaffected ----------------

  it('leaves loopback reads unaffected (GET /api/runs) → 200', async () => {
    const res = await app.request('/api/runs', { headers: { host: LOOPBACK } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('lets a loopback SSE read through to its route (unknown id → 404, not a 403)', async () => {
    const res = await app.request('/api/runs/nope/events', { headers: { host: LOOPBACK } });
    expect(res.status).toBe(404); // the route's own answer — the guard let it pass
  });

  it('still guards the SSE route against a foreign Host → 403', async () => {
    const res = await app.request('/api/runs/nope/events', { headers: { host: 'evil.tld' } });
    expect(res.status).toBe(403);
  });

  it('leaves /api/health open cross-origin on a loopback Host (the bookmarklet discovery probe) → 200', async () => {
    const res = await app.request('/api/health', {
      headers: { host: LOOPBACK, origin: 'https://github.com' },
    });
    expect(res.status).toBe(200);
  });

  it('answers the /api/health CORS preflight on a loopback Host → 204', async () => {
    const res = await app.request('/api/health', {
      method: 'OPTIONS',
      headers: { host: LOOPBACK, origin: 'https://github.com' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

/**
 * Hosted mode (CEZ_REMOTE=1 — spec §"Deployment modes"): cezar binds loopback
 * behind a reverse proxy that forwards the real public Host, so the loopback
 * allowlist must stand down there. CSRF protection stays on — Origin still has
 * to match the served Host.
 */
describe('request-origin guard — hosted mode (#426)', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  const savedRemote = process.env.CEZ_REMOTE;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-guard-hosted-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    process.env.CEZ_REMOTE = '1';
    const manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) =>
        store.createRun({ title: 't', workflow: '(planned)', task: input.task, steps: [] }),
    } as unknown as RunManager;
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = savedRemote;
  });

  const startBody = { task: 'do the thing', steps: [{ id: 'work', prompt: '{{task}}' }] };
  const postRuns = (headers: Record<string, string>) =>
    app.request('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(startBody),
    });

  it('allows the public-domain same-origin write (Origin === forwarded Host) → 201', async () => {
    const res = await postRuns({ host: 'cez.example.com', origin: 'https://cez.example.com' });
    expect(res.status).toBe(201);
    expect(store.listRuns()).toHaveLength(1);
  });

  it('still rejects a cross-origin write in hosted mode → 403', async () => {
    const res = await postRuns({ host: 'cez.example.com', origin: 'https://evil.tld' });
    expect(res.status).toBe(403);
    expect(store.listRuns()).toHaveLength(0);
  });
});
