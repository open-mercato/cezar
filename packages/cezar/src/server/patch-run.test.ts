import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.js';
import type { RunManager } from '../workflows/run.js';
import { createApp } from './server.js';
import { apiRequest } from './loopback-request.testkit.js';

/**
 * `PATCH /api/runs/:id` (#389) through the real Hono app. The route touches
 * only the store, so the manager can be an empty stub — no fakes beyond that
 * were needed (the createApp harness concern from the review didn't bite here).
 */
describe('PATCH /api/runs/:id', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let run: RunRecord;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-patch-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({
      repoRoot,
      store,
      manager: {} as unknown as RunManager, // the PATCH route never touches it
      version: '0.0.0-test',
    });
    run = store.createRun({ title: 'fix the login bug', workflow: 'quick-task', task: 'fix the login bug', steps: [] });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const patch = (id: string, body: unknown) =>
    apiRequest(app, `/api/runs/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('renames: the edit lands in BOTH title and titleSummary, so it wins over any auto-summary', async () => {
    // An auto-summary is already there — the edit must displace it.
    store.updateRun(run.id, { titleSummary: 'Auto-derived summary of the turn' });

    const res = await patch(run.id, { title: 'Login 500 fix' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RunRecord;
    expect(body.title).toBe('Login 500 fix');
    expect(body.titleSummary).toBe('Login 500 fix');
    // Persisted, not just echoed.
    expect(store.getRun(run.id)?.titleSummary).toBe('Login 500 fix');
    // The rename marks the title user-owned — the namer's live updates stop here
    // (spec 2026-07-17-task-auto-naming).
    expect(body.titleOrigin).toBe('user');
    expect(store.getRun(run.id)?.titleOrigin).toBe('user');
  });

  it('trims the title', async () => {
    const res = await patch(run.id, { title: '  padded  ' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as RunRecord).title).toBe('padded');
  });

  it('404s an unknown id', async () => {
    const res = await patch('nope', { title: 'x' });
    expect(res.status).toBe(404);
  });

  it('400s an empty (all-whitespace) title', async () => {
    const res = await patch(run.id, { title: '   ' });
    expect(res.status).toBe(400);
    expect(store.getRun(run.id)?.title).toBe('fix the login bug');
  });

  it('400s a title over 300 chars', async () => {
    const res = await patch(run.id, { title: 'x'.repeat(301) });
    expect(res.status).toBe(400);
  });

  it('400s a non-JSON body', async () => {
    const res = await apiRequest(app, `/api/runs/${run.id}`, { method: 'PATCH', body: 'not json' });
    expect(res.status).toBe(400);
  });

  it('an empty patch is a valid no-op that answers the record', async () => {
    const res = await patch(run.id, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as RunRecord;
    expect(body.title).toBe('fix the login bug');
    expect(body.titleSummary).toBeUndefined();
  });
});
