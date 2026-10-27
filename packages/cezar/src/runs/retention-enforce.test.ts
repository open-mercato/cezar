import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { branchFor, createWorktree, removeWorktree } from '../git-worktree.ts';
import { reclaimWorktrees, type RetentionStore } from './retention.ts';
import { RunStore, type RunRecord } from './store.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const roots: string[] = [];
const stores: RunStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.flush();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixtureRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'cez-retention-'));
  roots.push(root);
  await run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, 'base.txt'), 'base\n');
  await run('git', ['add', '-A'], { cwd: root });
  await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: root });
  return root;
}

async function branchExists(repo: string, runId: string): Promise<boolean> {
  const res = await run('git', ['show-ref', '--verify', `refs/heads/${branchFor(runId)}`], {
    cwd: repo,
  }).then(
    () => true,
    () => false,
  );
  return res;
}

/** A tiny in-memory store exposing only what the enforcer touches. */
function fakeStore(runs: RunRecord[]): RetentionStore & { runs: RunRecord[] } {
  return {
    runs,
    listRuns: () => runs,
    getRun: (id) => runs.find((x) => x.id === id),
    updateRun: (id, patch) => {
      const r = runs.find((x) => x.id === id);
      if (r) Object.assign(r, patch);
      return r;
    },
  };
}

function finishedRun(id: string, path: string, finishedAt: string): RunRecord {
  return {
    id,
    status: 'done',
    createdAt: finishedAt,
    finishedAt,
    worktreePath: path,
    steps: [],
  } as unknown as RunRecord;
}

describe('reclaimWorktrees (real git, #483)', () => {
  it('reclaims the oldest over-limit worktree: dir removed, branch kept, field stamped', async () => {
    const repo = await fixtureRepo();
    const oldId = '11111111-1111-4111-8111-111111111111';
    const newId = '22222222-2222-4222-8222-222222222222';
    const oldWt = await createWorktree(repo, oldId, 'main');
    const newWt = await createWorktree(repo, newId, 'main');

    const store = fakeStore([
      finishedRun(oldId, oldWt.path, '2026-07-01T00:00:00.000Z'),
      finishedRun(newId, newWt.path, '2026-07-09T00:00:00.000Z'),
    ]);

    const reclaimed = await reclaimWorktrees(repo, store, 1, {
      now: () => '2026-07-18T00:00:00.000Z',
    });

    expect(reclaimed).toEqual([oldId]);
    // Oldest: directory gone, branch preserved (recoverable), stamp written.
    expect(existsSync(oldWt.path)).toBe(false);
    expect(await branchExists(repo, oldId)).toBe(true);
    expect(store.runs.find((r) => r.id === oldId)?.worktreeReclaimedAt).toBe(
      '2026-07-18T00:00:00.000Z',
    );
    // Newest: untouched.
    expect(existsSync(newWt.path)).toBe(true);
    expect(store.runs.find((r) => r.id === newId)?.worktreeReclaimedAt).toBeUndefined();
  });

  it('does not stamp a run whose directory still exists after a no-op remove (retries next pass)', async () => {
    const repo = await fixtureRepo();
    const oldId = '44444444-4444-4444-8444-444444444444';
    const newId = '55555555-5555-4555-8555-555555555555';
    const oldWt = await createWorktree(repo, oldId, 'main');
    const newWt = await createWorktree(repo, newId, 'main');
    const store = fakeStore([
      finishedRun(oldId, oldWt.path, '2026-07-01T00:00:00.000Z'),
      finishedRun(newId, newWt.path, '2026-07-09T00:00:00.000Z'),
    ]);

    const reclaimed = await reclaimWorktrees(repo, store, 1, {
      remove: async () => {
        /* pretend removal failed: dir stays */
      },
    });

    expect(reclaimed).toEqual([]);
    expect(existsSync(oldWt.path)).toBe(true);
    expect(store.runs.find((r) => r.id === oldId)?.worktreeReclaimedAt).toBeUndefined();
  });

  it('keep=0 reclaims nothing (unlimited)', async () => {
    const repo = await fixtureRepo();
    const id = '66666666-6666-4666-8666-666666666666';
    const wt = await createWorktree(repo, id, 'main');
    const store = fakeStore([finishedRun(id, wt.path, '2026-07-01T00:00:00.000Z')]);
    expect(await reclaimWorktrees(repo, store, 0)).toEqual([]);
    expect(existsSync(wt.path)).toBe(true);
  });

  it('keeps a continued run\'s worktree when its status flips after the retention snapshot', async () => {
    const repo = await fixtureRepo();
    const store = RunStore.open(join(repo, '.ai/cezar'));
    stores.push(store);
    const a = store.createRun({ title: 'a', workflow: 'quick-task', task: 'a', steps: [] });
    const b = store.createRun({ title: 'b', workflow: 'quick-task', task: 'b', steps: [] });
    const c = store.createRun({ title: 'c', workflow: 'quick-task', task: 'c', steps: [] });
    const aWt = await createWorktree(repo, a.id, 'main');
    const bWt = await createWorktree(repo, b.id, 'main');
    const cWt = await createWorktree(repo, c.id, 'main');
    store.updateRun(a.id, { status: 'done', finishedAt: '2026-07-01T00:00:00.000Z', worktreePath: aWt.path });
    store.updateRun(b.id, { status: 'done', finishedAt: '2026-07-02T00:00:00.000Z', worktreePath: bWt.path });
    store.updateRun(c.id, { status: 'done', finishedAt: '2026-07-03T00:00:00.000Z', worktreePath: cWt.path });

    // keep=1 selects b then a (c is the newest). While b comes down the user
    // resumes a — its worktree must survive the sweep.
    const reclaimed = await reclaimWorktrees(repo, store, 1, {
      remove: async (root, path) => {
        if (path === bWt.path) store.updateRun(a.id, { status: 'running' });
        await removeWorktree(root, path);
      },
    });

    expect(reclaimed).toEqual([b.id]);
    expect(existsSync(aWt.path)).toBe(true);
    expect(store.getRun(a.id)?.worktreeReclaimedAt).toBeUndefined();
  }, 30_000);

  it('keeps a continued run\'s worktree when only its step list grew after the snapshot', async () => {
    const repo = await fixtureRepo();
    const store = RunStore.open(join(repo, '.ai/cezar'));
    stores.push(store);
    const a = store.createRun({ title: 'a', workflow: 'quick-task', task: 'a', steps: [] });
    const b = store.createRun({ title: 'b', workflow: 'quick-task', task: 'b', steps: [] });
    const c = store.createRun({ title: 'c', workflow: 'quick-task', task: 'c', steps: [] });
    const aWt = await createWorktree(repo, a.id, 'main');
    const bWt = await createWorktree(repo, b.id, 'main');
    const cWt = await createWorktree(repo, c.id, 'main');
    store.updateRun(a.id, { status: 'done', finishedAt: '2026-07-01T00:00:00.000Z', worktreePath: aWt.path });
    store.updateRun(b.id, { status: 'done', finishedAt: '2026-07-02T00:00:00.000Z', worktreePath: bWt.path });
    store.updateRun(c.id, { status: 'done', finishedAt: '2026-07-03T00:00:00.000Z', worktreePath: cWt.path });

    // A Continue records its step before the status flips to running: the sweep
    // must treat the grown step list itself as "this run is live again".
    const reclaimed = await reclaimWorktrees(repo, store, 1, {
      remove: async (root, path) => {
        if (path === bWt.path) store.addStep(a.id, { id: 'continue-1', name: 'Continue', kind: 'agent' });
        await removeWorktree(root, path);
      },
    });

    expect(reclaimed).toEqual([b.id]);
    expect(existsSync(aWt.path)).toBe(true);
  }, 30_000);
});
