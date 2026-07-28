import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.js';
import type { RunManager } from '../workflows/run.js';
import { createApp } from './server.js';
import { apiRequest } from './loopback-request.testkit.js';

/**
 * Group-pick winner-park under the optional review gate (#489). The
 * `POST /api/groups/:groupId/pick` endpoint inlines the `settleSuccess`
 * review-park rule; it must honor the same gate — flip the winner to `review`
 * only when the gate is enabled AND the winner is not autonomous. Driven against
 * a real fixture worktree with a genuine diff vs its base.
 */
function g(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}
function initRepo(dir: string): void {
  g(dir, 'init', '-b', 'main');
  g(dir, 'config', 'user.email', 'test@cezar.local');
  g(dir, 'config', 'user.name', 'cezar-test');
  g(dir, 'config', 'commit.gpgsign', 'false');
}

describe('POST /api/groups/:groupId/pick — review gate', () => {
  const savedGate = process.env.CEZ_REVIEW_GATE;
  let repoRoot: string;
  let worktree: string;
  let store: RunStore;
  let app: Hono;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-pick-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({
      repoRoot,
      store,
      // The endpoint only asks the manager whether the winner is still active.
      manager: { isActive: () => false, cancel: () => {} } as unknown as RunManager,
      version: '0.0.0-test',
    });
    worktree = join(repoRoot, 'wt');
    mkdirSync(worktree);
    initRepo(worktree);
    writeFileSync(join(worktree, 'base.txt'), 'base\n');
    g(worktree, 'add', '-A');
    g(worktree, 'commit', '-m', 'base');
    g(worktree, 'checkout', '-b', 'task');
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedGate === undefined) delete process.env.CEZ_REVIEW_GATE;
    else process.env.CEZ_REVIEW_GATE = savedGate;
  });

  /** A finished (`done`) group winner whose worktree holds a real diff vs base. */
  function winnerRun(autonomous?: boolean): RunRecord {
    const run = store.createRun({ title: 't', workflow: 'w', task: 't', autonomous, steps: [] });
    store.updateRun(run.id, {
      groupId: 'g1',
      variant: 'A',
      status: 'done',
      worktreePath: worktree,
      baseBranch: 'main',
      branch: 'task',
    });
    writeFileSync(join(worktree, 'base.txt'), 'base changed\n'); // uncommitted diff vs main
    return store.getRun(run.id) as RunRecord;
  }

  const pick = (id: string) =>
    apiRequest(app, '/api/groups/g1/pick', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: id }),
    });

  it('gate off (default): a changed winner stays done', async () => {
    delete process.env.CEZ_REVIEW_GATE;
    const winner = winnerRun();
    const res = await pick(winner.id);
    expect(res.status).toBe(200);
    expect(store.getRun(winner.id)?.status).toBe('done');
  });

  it('gate on + non-autonomous: the changed winner flips to review', async () => {
    process.env.CEZ_REVIEW_GATE = '1';
    const winner = winnerRun();
    await pick(winner.id);
    expect(store.getRun(winner.id)?.status).toBe('review');
  });

  it('gate on + autonomous: the winner stays done (autonomous wins)', async () => {
    process.env.CEZ_REVIEW_GATE = '1';
    const winner = winnerRun(true);
    await pick(winner.id);
    expect(store.getRun(winner.id)?.status).toBe('done');
  });
});
