import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { branchFor, createWorktree, removeWorktree } from '../git-worktree.ts';
import {
  isReclaimable,
  reclaimWorktrees,
  rematerializeReclaimedWorktree,
  type RematerializeStore,
} from './retention.ts';
import type { RunRecord } from './store.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixtureRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'cez-retention-remat-'));
  roots.push(root);
  await run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, 'base.txt'), 'base\n');
  await run('git', ['add', '-A'], { cwd: root });
  await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: root });
  return root;
}

async function branchExists(repo: string, runId: string): Promise<boolean> {
  return run('git', ['show-ref', '--verify', `refs/heads/${branchFor(runId)}`], { cwd: repo }).then(
    () => true,
    () => false,
  );
}

function fakeStore(record: RunRecord): RematerializeStore {
  return {
    getRun: (id) => (id === record.id ? record : undefined),
    updateRun: (id, patch) => {
      if (id === record.id) Object.assign(record, patch);
      return record;
    },
  };
}

/**
 * Step 1.5a (the must-not-miss behavior). A reclaimed worktree — branch kept,
 * directory gone, `worktreeReclaimedAt` stamped — must, on resume, be
 * re-materialized and un-stamped so it is once more eligible for retention.
 */
describe('rematerializeReclaimedWorktree (#483)', () => {
  it('re-creates the directory, keeps the branch, and clears the stamp', async () => {
    const repo = await fixtureRepo();
    const runId = '11111111-1111-4111-8111-111111111111';
    const wt = await createWorktree(repo, runId, 'main');
    // Reclaim: directory gone, branch kept, stamp set (what retention leaves).
    await removeWorktree(repo, wt.path);
    const record = {
      id: runId,
      status: 'review',
      createdAt: '2026-07-01T00:00:00.000Z',
      finishedAt: '2026-07-01T00:00:00.000Z',
      worktreePath: wt.path,
      branch: wt.branch,
      baseBranch: 'main',
      worktreeReclaimedAt: '2026-07-18T00:00:00.000Z',
      steps: [],
    } as unknown as RunRecord;
    expect(existsSync(wt.path)).toBe(false);
    expect(await branchExists(repo, runId)).toBe(true);

    const store = fakeStore(record);
    const did = await rematerializeReclaimedWorktree(repo, store, runId);

    expect(did).toBe(true);
    expect(existsSync(wt.path)).toBe(true); // directory back
    expect(record.worktreeReclaimedAt).toBeUndefined(); // stamp cleared
    expect(await branchExists(repo, runId)).toBe(true); // branch still there

    // A now-finished re-materialized run is once more reclaimable (no permanent
    // exemption / disk leak).
    record.status = 'done';
    expect(isReclaimable(record)).toBe(true);
  });

  it('is a no-op when the worktree was never reclaimed (dir present, no stamp)', async () => {
    const repo = await fixtureRepo();
    const runId = '22222222-2222-4222-8222-222222222222';
    const wt = await createWorktree(repo, runId, 'main');
    const record = {
      id: runId,
      status: 'done',
      createdAt: '2026-07-01T00:00:00.000Z',
      worktreePath: wt.path,
      branch: wt.branch,
      steps: [],
    } as unknown as RunRecord;

    expect(await rematerializeReclaimedWorktree(repo, fakeStore(record), runId)).toBe(false);
    expect(existsSync(wt.path)).toBe(true);
  });

  it('is a no-op for a run that never had a worktree', async () => {
    const repo = await fixtureRepo();
    const runId = '33333333-3333-4333-8333-333333333333';
    const record = {
      id: runId,
      status: 'done',
      createdAt: '2026-07-01T00:00:00.000Z',
      steps: [],
    } as unknown as RunRecord;
    expect(await rematerializeReclaimedWorktree(repo, fakeStore(record), runId)).toBe(false);
  });
});

/** 27d2e432: claude was spawned in a task worktree that then disappeared under it. */
describe('a resume racing a retention pass (27d2e432)', () => {
  const finished = (id: string, path: string, branch: string, finishedAt: string): RunRecord =>
    ({ id, status: 'failed', createdAt: finishedAt, finishedAt, worktreePath: path, branch, baseBranch: 'main', steps: [] }) as unknown as RunRecord;

  function listStore(records: RunRecord[]) {
    return {
      listRuns: () => records.map((r) => ({ ...r })),
      getRun: (id: string) => records.find((r) => r.id === id),
      updateRun: (id: string, patch: Partial<RunRecord>) => Object.assign(records.find((r) => r.id === id)!, patch),
    };
  }

  it('never removes the tree of a run that went back to running after the pass started', async () => {
    const repo = await fixtureRepo();
    // The pass reclaims newest-first: `first` goes, then `resumed` — unless it was Continued meanwhile.
    const resumed = await createWorktree(repo, 'a1aaaaaa-0000-4000-8000-000000000001', 'main');
    const first = await createWorktree(repo, 'a2aaaaaa-0000-4000-8000-000000000001', 'main');
    const kept = await createWorktree(repo, 'a3aaaaaa-0000-4000-8000-000000000001', 'main');
    const records = [
      finished('a1aaaaaa-0000-4000-8000-000000000001', resumed.path, resumed.branch, '2026-07-01T00:00:00.000Z'),
      finished('a2aaaaaa-0000-4000-8000-000000000001', first.path, first.branch, '2026-07-02T00:00:00.000Z'),
      finished('a3aaaaaa-0000-4000-8000-000000000001', kept.path, kept.branch, '2026-07-03T00:00:00.000Z'),
    ];
    const store = listStore(records);
    const reclaimed = await reclaimWorktrees(repo, store, 1, {
      remove: async (root, path) => {
        // While the first removal runs, the user Continues the older run and its agent starts.
        if (path === first.path) store.updateRun(records[0]!.id, { status: 'running' });
        await removeWorktree(root, path);
      },
    });

    expect(reclaimed).toEqual([records[1]!.id]);
    expect(existsSync(resumed.path)).toBe(true);
    expect(records[0]!.worktreeReclaimedAt).toBeUndefined();
  });

  it('skips a run a resume has claimed, even before it reads as running', async () => {
    const repo = await fixtureRepo();
    const a = await createWorktree(repo, 'b1bbbbbb-0000-4000-8000-000000000001', 'main');
    const b = await createWorktree(repo, 'b2bbbbbb-0000-4000-8000-000000000001', 'main');
    const records = [
      finished('b1bbbbbb-0000-4000-8000-000000000001', a.path, a.branch, '2026-07-01T00:00:00.000Z'),
      finished('b2bbbbbb-0000-4000-8000-000000000001', b.path, b.branch, '2026-07-02T00:00:00.000Z'),
    ];
    const store = listStore(records);
    // The resume path claims the run first; its status flips to running only later.
    expect(await rematerializeReclaimedWorktree(repo, store, records[0]!.id)).toBe(false);

    expect(await reclaimWorktrees(repo, store, 1)).toEqual([]);
    expect(existsSync(a.path)).toBe(true);
  });

  it('re-attaches a worktree removed outside cezar onto its surviving branch', async () => {
    const repo = await fixtureRepo();
    const runId = 'cccccccc-0000-4000-8000-000000000001';
    const wt = await createWorktree(repo, runId, 'main');
    rmSync(wt.path, { recursive: true, force: true }); // no stamp: nothing in cezar did this
    const record = finished(runId, wt.path, wt.branch, '2026-07-01T00:00:00.000Z');

    expect(await rematerializeReclaimedWorktree(repo, fakeStore(record), runId)).toBe(true);
    expect(existsSync(join(wt.path, 'base.txt'))).toBe(true);
  });

  it('does not invent a fresh tree when the task branch is gone too', async () => {
    const repo = await fixtureRepo();
    const runId = 'dddddddd-0000-4000-8000-000000000001';
    const wt = await createWorktree(repo, runId, 'main');
    await removeWorktree(repo, wt.path, wt.branch);
    const record = finished(runId, wt.path, wt.branch, '2026-07-01T00:00:00.000Z');

    expect(await rematerializeReclaimedWorktree(repo, fakeStore(record), runId)).toBe(false);
    expect(existsSync(wt.path)).toBe(false);
  });
});
