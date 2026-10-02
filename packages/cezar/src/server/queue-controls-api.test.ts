import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWorktree } from '../git-worktree.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * The Tasks header's three queue controls, at the HTTP boundary: `GET`/`POST /runs/queue`,
 * `POST /runs/start-queued` and `POST /runs/delete-all`.
 *
 * The manager is a stub rather than a real engine here — `queue-controls.test.ts` covers what the
 * hold does to `pump()`. What this file owns is the part only the route can get wrong:
 *
 *  - the literal `queue` / `start-queued` / `delete-all` paths are not swallowed by `/runs/:id`
 *    and answered as a 404 lookup of a task that does not exist (the registration-order trap the
 *    two existing sweeps carry the same guard for);
 *  - `POST /runs/queue` REQUIRES `paused`, so a dropped or empty body cannot silently resume a
 *    queue the operator had deliberately held;
 *  - the delete-all answer carries the `unsettled` count rather than a bare success.
 */
describe('the queue controls API', () => {
  let repoRoot: string;
  let cezHome: string;
  let store: RunStore;
  let app: Hono;
  let manager: {
    queueState: ReturnType<typeof vi.fn>;
    setQueuePaused: ReturnType<typeof vi.fn>;
    startQueued: ReturnType<typeof vi.fn>;
    deleteAllRuns: ReturnType<typeof vi.fn>;
  };
  const savedHome = process.env.CEZ_HOME;

  beforeEach(async () => {
    cezHome = mkdtempSync(join(tmpdir(), 'cez-queueapi-home-'));
    process.env.CEZ_HOME = cezHome;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-queueapi-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'base.txt'), 'base\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));

    manager = {
      queueState: vi.fn(() => ({ paused: false, queued: 0 })),
      setQueuePaused: vi.fn((paused: boolean) => ({ paused, queued: 0 })),
      startQueued: vi.fn(async () => ({ released: 0 })),
      deleteAllRuns: vi.fn(async () => ({ deleted: 0, cancelled: 0, unsettled: 0 })),
    };
    app = createApp({
      repoRoot,
      store,
      manager: manager as unknown as RunManager,
      version: '0.0.0-test',
    });
  });

  afterEach(() => {
    store.flush();
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(cezHome, { recursive: true, force: true });
  });

  it('reads the hold and the work behind it', async () => {
    manager.queueState.mockReturnValue({ paused: true, queued: 3 });
    const res = await apiRequest(app, '/api/v1/runs/queue');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ paused: true, queued: 3 });
  });

  it('sets and lifts the hold, answering the state the engine settled on', async () => {
    // The engine, not the request, is the source of truth: a client that raced another tab gets
    // what is true back rather than an echo of what it asked for.
    manager.setQueuePaused.mockReturnValue({ paused: false, queued: 2 });
    const res = await apiRequest(app, '/api/v1/runs/queue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paused: false }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ paused: false, queued: 2 });
    expect(manager.setQueuePaused).toHaveBeenCalledWith(false);
  });

  it('refuses a bodyless POST — a dropped request must not resume a held queue', async () => {
    // The mirror of `archiveSchema`'s "absent means do the thing", and deliberately unlike it: a
    // bare POST on a two-state resource has no safe default, and defaulting it to "resume" would
    // start work the operator had paused.
    const res = await apiRequest(app, '/api/v1/runs/queue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(manager.setQueuePaused).not.toHaveBeenCalled();
  });

  it('rejects a wrong-typed flag through the validator middleware, not the handler', async () => {
    const res = await apiRequest(app, '/api/v1/runs/queue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paused: 'yes' }),
    });
    expect(res.status).toBe(400);
    expect(manager.setQueuePaused).not.toHaveBeenCalled();
  });

  it('drains the queue and reports how many runs were RELEASED', async () => {
    // A count, not a boolean: the sweep starts only what `maxParallel` allows, so five queued
    // tasks under a cap of two releases two.
    manager.startQueued.mockResolvedValue({ released: 2 });
    const res = await apiRequest(app, '/api/v1/runs/start-queued', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ released: 2 });
  });

  it('empties the project and reports the split, unsettled included', async () => {
    manager.deleteAllRuns.mockResolvedValue({ deleted: 12, cancelled: 2, unsettled: 0 });
    const res = await apiRequest(app, '/api/v1/runs/delete-all', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 12, cancelled: 2, unsettled: 0 });
  });

  it('surfaces a non-zero unsettled count rather than a clean sweep', async () => {
    // A provider that never acknowledged its cancellation leaves a process whose record is gone.
    // Reporting `deleted: 12` alone would tell the operator everything is clean when it is not.
    manager.deleteAllRuns.mockResolvedValue({ deleted: 12, cancelled: 2, unsettled: 1 });
    const res = await apiRequest(app, '/api/v1/runs/delete-all', { method: 'POST' });
    expect(await res.json()).toEqual({ deleted: 12, cancelled: 2, unsettled: 1 });
  });

  it('the literal paths are not swallowed by /runs/:id', async () => {
    // The registration-order guard the two existing sweeps carry. Registered after `/runs/:id/...`,
    // each of these would match as a run id and 404 on a lookup of a task that does not exist.
    const cases: [string, RequestInit | undefined][] = [
      ['/api/v1/runs/queue', undefined],
      ['/api/v1/runs/start-queued', { method: 'POST' }],
      ['/api/v1/runs/delete-all', { method: 'POST' }],
    ];
    for (const [path, init] of cases) {
      const res = await apiRequest(app, path, init);
      expect(res.status, `${path} must not be read as a run id`).toBe(200);
    }
  });

  it('answers under the project-scoped alias too', async () => {
    // `route-parity.test.ts` walks the manifest for this, but the alias is what the cockpit
    // actually calls, so it is pinned here as well.
    manager.queueState.mockReturnValue({ paused: false, queued: 1 });
    const res = await apiRequest(app, '/api/v1/p/default/runs/queue');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ paused: false, queued: 1 });
  });

  it('really deletes the records it claims to, worktree included', async () => {
    // Guards the route against a future refactor that answers a count without doing the work.
    const wt = await createWorktree(repoRoot, 'gone', 'main');
    const rec = store.createRun({ title: 'doomed', workflow: 'w', task: 't', steps: [] });
    store.updateRun(rec.id, { status: 'done', worktreePath: wt.path, branch: wt.branch });
    manager.deleteAllRuns.mockImplementation(async () => {
      const deleted = store.deleteRun(rec.id) ? 1 : 0;
      return { deleted, cancelled: 0, unsettled: 0 };
    });

    const res = await apiRequest(app, '/api/v1/runs/delete-all', { method: 'POST' });
    expect(await res.json()).toEqual({ deleted: 1, cancelled: 0, unsettled: 0 });
    expect(store.getRun(rec.id)).toBeUndefined();
  });
});
