import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';

/**
 * `POST /api/v1/runs/:id/promote` — "Run next" (brief
 * .ai/specs/briefs/2026-09-23-queued-task-run-next.md). The engine half (queue order, caps,
 * restart) is pinned in `workflows/run-next.test.ts`; this pins the route's three answers.
 */
describe('POST /runs/:id/promote', () => {
  const savedRemote = process.env.CEZ_REMOTE;
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let queued: Set<string>;

  beforeEach(() => {
    delete process.env.CEZ_REMOTE;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-promote-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    queued = new Set();
    // The engine's answer is the whole contract the route relies on: true when the run was
    // waiting in the queue (and the record now carries `promotedAt`), false otherwise.
    const manager = {
      promote: (id: string) => {
        if (!queued.has(id)) return false;
        store.updateRun(id, { promotedAt: '2026-09-23T10:00:00.000Z' });
        return true;
      },
    } as unknown as RunManager;
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test', providerAuth: connectedProviderAuth() });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = savedRemote;
  });

  it('promotes a queued run and answers the updated record', async () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] });
    store.updateRun(run.id, { status: 'queued' });
    queued.add(run.id);
    const res = await apiRequest(app, `/api/v1/runs/${run.id}/promote`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: run.id, promotedAt: '2026-09-23T10:00:00.000Z' });
  });

  it('answers 409 when the run is not waiting in the queue', async () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] });
    store.updateRun(run.id, { status: 'running' });
    const res = await apiRequest(app, `/api/v1/runs/${run.id}/promote`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'run is not queued' });
    expect(store.getRun(run.id)?.promotedAt).toBeUndefined();
  });

  it('answers 404 for a run that does not exist', async () => {
    const res = await apiRequest(app, '/api/v1/runs/no-such-run/promote', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});
