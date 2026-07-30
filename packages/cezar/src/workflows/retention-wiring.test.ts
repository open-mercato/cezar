import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorktree } from '../git-worktree.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * Retention wiring (#483 Step 1.5): finishing a run drives `dropActive`, which
 * enforces the keep-limit — reclaiming the oldest over-limit finished worktree
 * while sparing a run at the `review` gate. Uses the DRY_RUN mock backend so a
 * real run reaches a terminal status without any agent CLI.
 */
describe('worktree retention fires on a terminal transition (#483)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-retention-wire-'));
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    // keep=1: with two finished worktrees, the older is over budget.
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(
      join(repoRoot, '.ai/cezar/config.json'),
      JSON.stringify({ worktreeRetention: 1 }),
      'utf8',
    );
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('reclaims the oldest finished worktree and spares the review run', async () => {
    // Two finished worktrees (over the keep=1 budget) + one at the review gate.
    const oldId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const newId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const reviewId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    // Each prior run gets a real worktree (stable id → deterministic dir) and a
    // store record whose worktreePath points at it.
    const older = await seedWithId(store, repoRoot, oldId, 'done', '2026-07-01T00:00:00.000Z');
    const newer = await seedWithId(store, repoRoot, newId, 'done', '2026-07-09T00:00:00.000Z');
    const review = await seedWithId(store, repoRoot, reviewId, 'review', '2026-07-10T00:00:00.000Z');

    expect(existsSync(older.path)).toBe(true);
    expect(existsSync(newer.path)).toBe(true);
    expect(existsSync(review.path)).toBe(true);

    // Start and finish a real run (in repoRoot, no worktree of its own).
    const workflow: WorkflowDef = {
      name: '(planned)',
      source: 'built-in',
      steps: [{ id: 'task', name: 'Do it', prompt: '{{task}}' }],
    };
    const record = manager.startRun(workflow, { task: 'mock:done tidy up', worktree: false });

    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    const deadline = Date.now() + 20_000;
    while (!terminal.has(store.getRun(record.id)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('run did not finish in time');
      await new Promise((r) => setTimeout(r, 100));
    }

    // Retention fires fire-and-forget from dropActive. The stamp is the true
    // "reclaim complete" signal (the directory disappears one git call earlier),
    // so wait on that to avoid racing the enforcer mid-reclaim.
    const reclaimDeadline = Date.now() + 10_000;
    while (!store.getRun(older.recId)?.worktreeReclaimedAt) {
      if (Date.now() > reclaimDeadline) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    // Oldest finished worktree reclaimed (dir gone, stamp set); newer + review spared.
    expect(existsSync(older.path)).toBe(false);
    expect(store.getRun(older.recId)?.worktreeReclaimedAt).toBeTruthy();
    expect(existsSync(newer.path)).toBe(true);
    expect(store.getRun(newer.recId)?.worktreeReclaimedAt).toBeUndefined();
    expect(existsSync(review.path)).toBe(true);
    expect(store.getRun(review.recId)?.worktreeReclaimedAt).toBeUndefined();
  }, 40_000);
});

/** Create a real worktree for a stable id, then a store record pointing at it. */
async function seedWithId(
  store: RunStore,
  repoRoot: string,
  id: string,
  status: 'done' | 'review',
  finishedAt: string,
): Promise<{ recId: string; path: string }> {
  const wt = await createWorktree(repoRoot, id, 'main');
  const rec = store.createRun({ title: id, workflow: 'w', task: 't', steps: [] });
  store.updateRun(rec.id, { status, finishedAt, worktreePath: wt.path, branch: wt.branch });
  return { recId: rec.id, path: wt.path };
}
