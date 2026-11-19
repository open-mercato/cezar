import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorktree, localBranchExists } from '../git-worktree.ts';
import { archivedSince, deleteExpiredArchivedTasks, selectExpiredArchived } from './archived-cleanup.ts';
import { RunStore, type RunRecord } from './store.ts';

const exec = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-19T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

// Spec 2026-11-19-worktree-disk-usage, decision 5.
describe('archived task selection', () => {
  const rec = (id: string, extra: Partial<RunRecord>) =>
    ({ id, status: 'done', createdAt: daysAgo(400), steps: [], ...extra }) as unknown as RunRecord;

  it('counts from archivedAt, oldest first; 0 days is never', () => {
    const runs = [
      rec('young', { archived: true, archivedAt: daysAgo(10) }),
      rec('old', { archived: true, archivedAt: daysAgo(200) }),
      rec('older', { archived: true, archivedAt: daysAgo(300) }),
    ];
    expect(selectExpiredArchived(runs, 90, () => false, NOW)).toEqual(['older', 'old']);
    expect(selectExpiredArchived(runs, 0, () => false, NOW)).toEqual([]);
  });

  it('falls back to finishedAt, then last activity, for records archived before the stamp existed', () => {
    expect(archivedSince(rec('a', { archived: true, finishedAt: daysAgo(100) }))).toBe(NOW - 100 * DAY);
    expect(archivedSince(rec('b', { archived: true, createdAt: daysAgo(120) }))).toBe(NOW - 120 * DAY);
    expect(selectExpiredArchived([rec('c', { archived: true, finishedAt: daysAgo(100) })], 90, () => false, NOW)).toEqual(['c']);
  });

  it('never selects an unarchived, live, running, queued or pinned task', () => {
    const runs = [
      rec('unarchived', { archived: false, archivedAt: undefined, finishedAt: daysAgo(400) }),
      rec('live', { archived: true, archivedAt: daysAgo(400) }),
      rec('running', { archived: true, archivedAt: daysAgo(400), status: 'running' }),
      rec('queued', { archived: true, archivedAt: daysAgo(400), status: 'queued' }),
      rec('pinned', { archived: true, archivedAt: daysAgo(400), pinned: true }),
    ];
    expect(selectExpiredArchived(runs, 90, (id) => id === 'live', NOW)).toEqual([]);
  });
});

describe('deleteExpiredArchivedTasks against a real repo', () => {
  let repo: string;
  let dataDir: string;
  let store: RunStore;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cez-archived-'));
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    await exec('git', ['add', '-A'], { cwd: repo });
    await exec('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repo });
    dataDir = join(repo, '.ai/cezar');
    mkdirSync(dataDir, { recursive: true });
    store = RunStore.open(dataDir);
  });
  afterEach(() => {
    store.flush();
    rmSync(repo, { recursive: true, force: true });
  });

  /** An archived task with a worktree; `commit` leaves work on its branch, `merge` merges it. */
  async function archived(opts: { commit?: boolean; merge?: boolean; pr?: string } = {}): Promise<RunRecord> {
    const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] });
    const wt = await createWorktree(repo, run.id, 'main');
    if (opts.commit) {
      writeFileSync(join(wt.path, `${run.id}.txt`), 'work\n');
      await exec('git', ['add', '-A'], { cwd: wt.path });
      await exec('git', [...GIT_ID, 'commit', '-q', '-m', 'work'], { cwd: wt.path });
      if (opts.merge) await exec('git', [...GIT_ID, 'merge', '-q', '--ff-only', wt.branch], { cwd: repo });
    }
    mkdirSync(join(dataDir, 'artifacts', run.id), { recursive: true });
    return store.updateRun(run.id, {
      status: 'done', archived: true, archivedAt: daysAgo(100), worktreePath: wt.path, branch: wt.branch, baseBranch: 'main',
      ...(opts.pr ? { pullRequestUrl: opts.pr } : {}),
    })!;
  }

  const opts = (extra: Partial<Parameters<typeof deleteExpiredArchivedTasks>[3]> = {}) => ({
    isLive: () => false, now: NOW, openPr: async () => false as boolean | null, ...extra,
  });

  it('deletes the task, its files, its worktree and a branch that holds nothing unique', async () => {
    const run = await archived({ commit: true, merge: true });
    const result = await deleteExpiredArchivedTasks(repo, store, 90, opts());
    expect(result.deleted).toEqual([run.id]);
    expect(result.keptBranches).toEqual([]);
    expect(store.getRun(run.id)).toBeUndefined();
    expect(existsSync(run.worktreePath!)).toBe(false);
    expect(existsSync(join(dataDir, 'artifacts', run.id))).toBe(false);
    expect(await localBranchExists(repo, run.branch!)).toBe(false);
  });

  it('keeps a branch with commits neither merged nor pushed, deleting only the task', async () => {
    const run = await archived({ commit: true });
    const result = await deleteExpiredArchivedTasks(repo, store, 90, opts());
    expect(result.deleted).toEqual([run.id]);
    expect(result.keptBranches).toEqual([{ runId: run.id, branch: run.branch, reason: '1 commit(s) neither merged nor pushed' }]);
    expect(store.getRun(run.id)).toBeUndefined();
    expect(await localBranchExists(repo, run.branch!)).toBe(true);
  });

  it('keeps a branch with an open pull request, and one whose PR state cannot be read', async () => {
    const open = await archived({ commit: true, merge: true });
    const unknown = await archived({ commit: true, merge: true, pr: 'https://github.com/acme/demo/pull/3' });
    const result = await deleteExpiredArchivedTasks(repo, store, 90, opts({
      openPr: async (_root, branch) => (branch === open.branch ? true : null),
    }));
    expect(result.keptBranches.map((k) => [k.runId, k.reason]).sort()).toEqual(
      [[open.id, 'open pull request'], [unknown.id, 'pull request state unknown']].sort(),
    );
    expect(await localBranchExists(repo, open.branch!)).toBe(true);
    expect(await localBranchExists(repo, unknown.branch!)).toBe(true);
  });

  it('a dry run reports and touches nothing', async () => {
    const run = await archived({ commit: true, merge: true });
    const result = await deleteExpiredArchivedTasks(repo, store, 90, opts({ dryRun: true }));
    expect(result.deleted).toEqual([run.id]);
    expect(store.getRun(run.id)).toBeDefined();
    expect(existsSync(run.worktreePath!)).toBe(true);
    expect(await localBranchExists(repo, run.branch!)).toBe(true);
  });

  it('never touches a task that was unarchived since, nor one with uncommitted work', async () => {
    const unarchived = await archived();
    store.setArchived(unarchived.id, false);
    const dirty = await archived();
    writeFileSync(join(dirty.worktreePath!, 'unsaved.txt'), 'x');
    const result = await deleteExpiredArchivedTasks(repo, store, 90, opts());
    expect(result.deleted).toEqual([]);
    expect(result.skipped).toEqual([{ runId: dirty.id, reason: 'worktree has uncommitted changes' }]);
    expect(store.getRun(unarchived.id)).toBeDefined();
    expect(store.getRun(dirty.id)).toBeDefined();
  });
});
