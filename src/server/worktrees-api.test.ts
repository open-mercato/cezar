import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorktree } from '../git-worktree.js';
import { RunStore } from '../runs/store.js';
import type { RunManager } from '../workflows/run.js';
import { createApp } from './server.js';
import { apiRequest } from './loopback-request.testkit.js';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * The worktree management panel API (#483 Phase 2). `GET /api/worktrees` lists
 * materialized worktrees with disk usage + retention state; `POST
 * /api/worktrees/reclaim` force-runs the enforcer. Both additive and
 * best-effort — never error.
 */
describe('the worktrees API', () => {
  let repoRoot: string;
  let cezHome: string;
  let store: RunStore;
  let app: Hono;
  const savedHome = process.env.CEZ_HOME;

  beforeEach(async () => {
    // `keep` now falls back to the workspace default, so pin CEZ_HOME at an
    // empty temp dir — the suite must never read the developer's real ~/.cezar.
    cezHome = mkdtempSync(join(tmpdir(), 'cez-wtapi-home-'));
    process.env.CEZ_HOME = cezHome;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-wtapi-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'base.txt'), 'base\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(cezHome, { recursive: true, force: true });
  });

  async function seed(
    id: string,
    status: 'done' | 'review' | 'running',
    finishedAt?: string,
  ): Promise<string> {
    const wt = await createWorktree(repoRoot, id, 'main');
    const rec = store.createRun({ title: `run ${id.slice(0, 4)}`, workflow: 'w', task: 't', steps: [] });
    store.updateRun(rec.id, { status, finishedAt, worktreePath: wt.path, branch: wt.branch });
    return rec.id;
  }

  const getWorktrees = async () =>
    (await (
      await apiRequest(app, '/api/worktrees')
    ).json()) as {
      worktrees: Array<{
        runId: string;
        title: string;
        status: string;
        branch: string | null;
        sizeBytes: number | null;
        finishedAt: string | null;
        reclaimable: boolean;
      }>;
      totalBytes: number | null;
      keep: number;
    };

  it('lists materialized worktrees with sizes, the keep-limit, and a reclaimable flag', async () => {
    const doneId = await seed('11111111-1111-4111-8111-111111111111', 'done', '2026-07-01T00:00:00Z');
    const reviewId = await seed('22222222-2222-4222-8222-222222222222', 'review', '2026-07-02T00:00:00Z');
    const runningId = await seed('33333333-3333-4333-8333-333333333333', 'running');

    const body = await getWorktrees();
    expect(body.keep).toBe(10); // schema default
    expect(body.worktrees).toHaveLength(3);

    const byRun = Object.fromEntries(body.worktrees.map((w) => [w.runId, w]));
    // reclaimable flag matches the selector's rule: finished + has dir + not stamped.
    expect(byRun[doneId]!.reclaimable).toBe(true);
    expect(byRun[reviewId]!.reclaimable).toBe(false); // review is spared
    expect(byRun[runningId]!.reclaimable).toBe(false); // live work

    // Shape + real du sizes on this (POSIX) host.
    expect(byRun[doneId]!.branch).toMatch(/^cez\//);
    expect(typeof byRun[doneId]!.sizeBytes).toBe('number');
    expect(body.totalBytes).not.toBeNull();
  });

  it('reflects the configured keep-limit', async () => {
    writeFileSync(join(repoRoot, '.ai/cezar/config.json'), JSON.stringify({ worktreeRetention: 2 }), 'utf8');
    expect((await getWorktrees()).keep).toBe(2);
  });

  it('inherits the workspace default when the repo sets no retention of its own', async () => {
    writeFileSync(
      join(cezHome, 'config.json'),
      JSON.stringify({ resources: { worktreeRetentionDefault: 4 } }),
      'utf8',
    );
    expect((await getWorktrees()).keep).toBe(4);
    // A repo that sets its own still wins — the workspace value only seeds.
    writeFileSync(join(repoRoot, '.ai/cezar/config.json'), JSON.stringify({ worktreeRetention: 2 }), 'utf8');
    expect((await getWorktrees()).keep).toBe(2);
  });

  it('POST /reclaim reclaims down to the limit and returns the reclaimed ids', async () => {
    writeFileSync(join(repoRoot, '.ai/cezar/config.json'), JSON.stringify({ worktreeRetention: 1 }), 'utf8');
    const oldId = await seed('44444444-4444-4444-8444-444444444444', 'done', '2026-07-01T00:00:00Z');
    await seed('55555555-5555-4555-8555-555555555555', 'done', '2026-07-09T00:00:00Z');

    const res = await apiRequest(app, '/api/worktrees/reclaim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const { reclaimed } = (await res.json()) as { reclaimed: string[] };
    expect(reclaimed).toEqual([oldId]); // the oldest over the keep=1 budget

    // The reclaimed worktree drops out of the listing (its dir is gone).
    const body = await getWorktrees();
    expect(body.worktrees.map((w) => w.runId)).not.toContain(oldId);
  });

  it('POST /reclaim is a 200 no-op on empty state', async () => {
    const res = await apiRequest(app, '/api/worktrees/reclaim', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reclaimed: [] });
  });

  it('GET returns an empty listing when there are no materialized worktrees', async () => {
    const body = await getWorktrees();
    expect(body.worktrees).toEqual([]);
    expect(body.totalBytes).toBe(0);
  });

  it('omits worktrees whose directory no longer exists on disk', async () => {
    const id = await seed('66666666-6666-4666-8666-666666666666', 'done', '2026-07-01T00:00:00Z');
    const wtPath = store.getRun(id)?.worktreePath as string;
    rmSync(wtPath, { recursive: true, force: true });
    expect(existsSync(wtPath)).toBe(false);
    expect((await getWorktrees()).worktrees.map((w) => w.runId)).not.toContain(id);
  });
});
