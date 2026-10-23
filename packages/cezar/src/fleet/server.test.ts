import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { FleetHub } from './hub.ts';
import { createFleetApp, fleetAuth, tokenMatches } from './server.ts';

const TOKEN = 'a'.repeat(32);
const call = (app: Hono, path: string, init: RequestInit = {}, token?: string) =>
  app.request(path, {
    ...init,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}) },
  });

describe('tokenMatches', () => {
  it('accepts only the exact token', () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(tokenMatches('b'.repeat(32), TOKEN)).toBe(false);
    expect(tokenMatches(undefined, TOKEN)).toBe(false);
  });
  it('fails closed when the configured token is too short', () => {
    expect(tokenMatches('short', 'short')).toBe(false);
  });
});

describe('fleet listener', () => {
  const app = () => createFleetApp(new FleetHub(), TOKEN);

  it('answers 401 without, with a wrong, or with a short bearer token', async () => {
    for (const token of [undefined, 'b'.repeat(32), 'short']) {
      const res = await call(app(), '/api/v1/fleet/status', {}, token);
      expect(res.status).toBe(401);
    }
    const res = await app().request('/api/v1/fleet/status', { headers: { authorization: `Basic ${TOKEN}` } });
    expect(res.status).toBe(401);
  });

  it('serves status, submit and cancel with the right token', async () => {
    const a = app();
    const created = await call(a, '/api/v1/fleet/jobs', { method: 'POST', body: JSON.stringify({ repoUrl: 'a/b', task: 'do it' }) }, TOKEN);
    expect(created.status).toBe(201);
    const job = (await created.json()) as { id: string; openPr: boolean; status: string };
    expect(job).toMatchObject({ openPr: true, status: 'pending' });
    const status = await (await call(a, '/api/v1/fleet/status', {}, TOKEN)).json();
    expect(status).toMatchObject({ jobs: [{ id: job.id }] });
    const cancelled = await call(a, `/api/v1/fleet/jobs/${job.id}/cancel`, { method: 'POST' }, TOKEN);
    expect(((await cancelled.json()) as { status: string }).status).toBe('cancelled');
    expect((await call(a, '/api/v1/fleet/jobs/nope/cancel', { method: 'POST' }, TOKEN)).status).toBe(404);
  });

  it('rejects malformed bodies with the { error } shape', async () => {
    const res = await call(app(), '/api/v1/fleet/jobs', { method: 'POST', body: JSON.stringify({ task: '' }) }, TOKEN);
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty('error');
  });

  it('refuses a non-JSON content type and an oversized body before parsing', async () => {
    const a = app();
    const text = await a.request('/api/v1/fleet/jobs', { method: 'POST', body: 'task=x', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'text/plain' } });
    expect(text.status).toBe(400);
    const big = JSON.stringify({ repoUrl: 'a/b', task: 'x'.repeat(300 * 1024) });
    const res = await a.request('/api/v1/fleet/jobs', {
      method: 'POST', body: big, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'content-length': String(big.length) },
    });
    expect(res.status).toBe(413);
  });

  it('refuses an option-like base branch', async () => {
    const res = await call(app(), '/api/v1/fleet/jobs', { method: 'POST', body: JSON.stringify({ repoUrl: 'a/b', task: 't', baseBranch: '--upload-pack=x' }) }, TOKEN);
    expect(res.status).toBe(400);
  });

  it('exposes nothing outside /api/v1/fleet', async () => {
    for (const path of ['/api/v1/health', '/api/v1/runs', '/']) {
      expect((await call(app(), path, {}, TOKEN)).status).toBe(404);
    }
  });

  it('fleetAuth lets a valid request through to the next handler', async () => {
    const guarded = new Hono().use('*', fleetAuth(TOKEN)).get('/x', (c) => c.text('ok'));
    expect((await call(guarded, '/x', {}, TOKEN)).status).toBe(200);
  });
});
