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
 * The PER-TASK off switch for a usage-limit resume (spec
 * 2026-08-03-auto-resume-after-usage-limit): `DELETE /api/v1/runs/:id/auto-resume`, and the same
 * retirement riding the archive route because archiving is how a user resigns from a task.
 *
 * The manager is a spy rather than a real one: what the ROUTES owe is calling
 * `cancelAutoResume` for the right run at the right moment — the timer/record half is the
 * engine's, pinned in `src/workflows/auto-resume.test.ts`.
 */
describe('per-task auto-resume cancellation', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let cancelled: string[];

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-auto-resume-api-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    cancelled = [];
    app = createApp({
      repoRoot,
      store,
      manager: {
        cancelAutoResume: (id: string) => {
          cancelled.push(id);
          const run = store.getRun(id);
          if (!run) return false;
          store.updateRun(id, { autoResumeAt: undefined, autoResumeAttempts: undefined });
          return true;
        },
      } as unknown as RunManager,
      version: '0.0.0-test',
    });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** A run parked exactly as a usage limit leaves it: failed, with a resume promised. */
  function limited(): string {
    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
    store.updateRun(run.id, {
      status: 'failed',
      error: 'Claude AI usage limit reached|1785782478',
      finishedAt: '2026-08-03T18:40:00.000Z',
      autoResumeAt: '2026-08-03T18:41:48.000Z',
    });
    return run.id;
  }

  it('retires the pending resume and answers cancelled', async () => {
    const id = limited();
    const res = await apiRequest(app, `/api/v1/runs/${id}/auto-resume`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cancelled: true });
    expect(cancelled).toEqual([id]);
    expect(store.getRun(id)?.autoResumeAt).toBeUndefined();
  });

  it('is idempotent — a task with nothing scheduled answers the same way', async () => {
    const id = limited();
    await apiRequest(app, `/api/v1/runs/${id}/auto-resume`, { method: 'DELETE' });
    const again = await apiRequest(app, `/api/v1/runs/${id}/auto-resume`, { method: 'DELETE' });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ cancelled: true });
  });

  it('404s an unknown id, and never touches the manager for one', async () => {
    const res = await apiRequest(app, '/api/v1/runs/nope/auto-resume', { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(cancelled).toEqual([]);
  });

  it('answers under the project-scoped alias too', async () => {
    const id = limited();
    const res = await apiRequest(app, `/api/v1/p/default/runs/${id}/auto-resume`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(cancelled).toEqual([id]);
  });

  it('archiving a task resigns from its resume as well', async () => {
    // No manager call here on purpose: the rule is `setArchived`'s, so the bulk sweep obeys it
    // too (pinned in `src/runs/store.test.ts`). The route only has to keep going through it.
    const id = limited();
    const res = await apiRequest(app, `/api/v1/runs/${id}/archive`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()) as RunRecord).toMatchObject({ archived: true });
    expect(store.getRun(id)?.autoResumeAt).toBeUndefined();
  });

  it('UN-archiving does not silently re-promise a resume', async () => {
    const id = limited();
    await apiRequest(app, `/api/v1/runs/${id}/archive`, { method: 'POST' });
    const res = await apiRequest(app, `/api/v1/runs/${id}/archive`, {
      method: 'POST',
      body: JSON.stringify({ archived: false }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(store.getRun(id)?.autoResumeAt).toBeUndefined();
  });
});
