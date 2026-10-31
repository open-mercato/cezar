import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.js';
import type { RunManager } from '../workflows/run.js';
import { createApp } from './server.js';
import { apiRequest } from './loopback-request.testkit.js';

/** `POST /api/v1/runs/:id/start-now` maps the engine's answer to the wire; the engine half is
 *  pinned in `src/workflows/start-now.test.ts`. */
describe('POST /runs/:id/start-now', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let outcome: 'started' | 'not-queued' | 'held';
  let asked: string[];

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-start-now-api-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    asked = [];
    outcome = 'started';
    app = createApp({
      repoRoot,
      store,
      manager: {
        startNow: async (id: string) => {
          asked.push(id);
          return outcome;
        },
      } as unknown as RunManager,
      version: '0.0.0-test',
    });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const post = (id: string) => apiRequest(app, `/api/v1/runs/${id}/start-now`, { method: 'POST' });
  const queued = () => store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] }).id;

  it('answers started', async () => {
    const id = queued();
    const res = await post(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ started: true });
    expect(asked).toEqual([id]);
  });

  it('409s a run that is not queued', async () => {
    outcome = 'not-queued';
    const res = await post(queued());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'run is not queued' });
  });

  it('409s a run whose account is held by a usage limit', async () => {
    outcome = 'held';
    const res = await post(queued());
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('usage limit');
  });

  it('404s an unknown id without asking the manager', async () => {
    const res = await post('nope');
    expect(res.status).toBe(404);
    expect(asked).toEqual([]);
  });
});
