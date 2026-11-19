import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorktree, localBranchExists } from '../git-worktree.ts';
import {
  isIdleReclaimable,
  lastActivityAt,
  reclaimIdleWorktrees,
  reclaimRunWorktrees,
  rematerializeReclaimedWorktree,
  selectIdleWorktrees,
  selectManualReclaim,
} from './retention.ts';
import { RunStore, type RunRecord } from './store.ts';

const exec = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-19T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

function rec(id: string, status: RunRecord['status'], at: string, extra: Partial<RunRecord> = {}): RunRecord {
  return { id, status, createdAt: at, finishedAt: at, worktreePath: `/wt/${id}`, steps: [], ...extra } as unknown as RunRecord;
}

// Spec 2026-11-19-worktree-disk-usage, decision 1.
describe('age retention selection', () => {
  it('takes every settled status — review and waiting included — idle past the limit, oldest first', () => {
    const runs = [
      rec('review-old', 'review', daysAgo(30)),
      rec('waiting-old', 'waiting', daysAgo(10)),
      rec('done-old', 'done', daysAgo(8)),
      rec('done-new', 'done', daysAgo(2)),
      rec('running-old', 'running', daysAgo(40)),
      rec('queued-old', 'queued', daysAgo(40)),
    ];
    expect(selectIdleWorktrees(runs, 7, NOW)).toEqual(['review-old', 'waiting-old', 'done-old']);
  });

  it('0 days is off', () => {
    expect(selectIdleWorktrees([rec('a', 'done', daysAgo(400))], 0, NOW)).toEqual([]);
  });

  it('spares pinned, already reclaimed and wake-scheduled runs', () => {
    expect(isIdleReclaimable(rec('p', 'review', daysAgo(30), { pinned: true }))).toBe(false);
    expect(isIdleReclaimable(rec('r', 'review', daysAgo(30), { worktreeReclaimedAt: daysAgo(1) }))).toBe(false);
    expect(isIdleReclaimable(rec('w', 'waiting', daysAgo(30), { monitoringWakeAt: daysAgo(-1) }))).toBe(false);
    expect(isIdleReclaimable(rec('u', 'failed', daysAgo(30), { autoResumeAt: daysAgo(-1) }))).toBe(false);
  });

  it('counts the event log as activity', () => {
    const run = rec('a', 'review', daysAgo(30));
    expect(lastActivityAt(run, NOW - DAY)).toBe(daysAgo(1));
    expect(selectIdleWorktrees([run], 7, NOW, (r) => lastActivityAt(r, NOW - DAY))).toEqual([]);
  });

  it('manual selectors never pick a live run', () => {
    const runs = [rec('a', 'review', daysAgo(30)), rec('b', 'done', daysAgo(1))];
    const live = (id: string) => id === 'a';
    expect(selectManualReclaim(runs, { allInactive: true }, live)).toEqual(['b']);
    expect(selectManualReclaim(runs, { runIds: ['a', 'b'] }, live)).toEqual(['b']);
    expect(selectManualReclaim(runs, { olderThanDays: 7 }, () => false, undefined, NOW)).toEqual(['a']);
    expect(selectManualReclaim(runs, {}, () => false)).toBeNull();
  });
});

describe('reclaimIdleWorktrees against a real repo', () => {
  let repo: string;
  let store: RunStore;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cez-idle-'));
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    await exec('git', ['add', '-A'], { cwd: repo });
    await exec('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repo });
    mkdirSync(join(repo, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repo, '.ai/cezar'));
  });
  afterEach(() => {
    store.flush();
    rmSync(repo, { recursive: true, force: true });
  });

  async function seed(status: RunRecord['status'], finishedAt: string): Promise<RunRecord> {
    const run = store.createRun({ title: status, workflow: 'w', task: 't', steps: [] });
    const wt = await createWorktree(repo, run.id, 'main');
    // Committed work on the branch: what a review run's diff and PR are made of.
    writeFileSync(join(wt.path, 'feature.txt'), `${status}\n`);
    await exec('git', ['add', '-A'], { cwd: wt.path });
    await exec('git', [...GIT_ID, 'commit', '-q', '-m', 'work'], { cwd: wt.path });
    return store.updateRun(run.id, { status, createdAt: finishedAt, startedAt: finishedAt, finishedAt, worktreePath: wt.path, branch: wt.branch, baseBranch: 'main' })!;
  }

  const opts = (live: Set<string> = new Set()) => ({
    isLive: (id: string) => live.has(id),
    activity: (r: RunRecord) => lastActivityAt(r),
    nowMs: () => NOW,
    holders: async () => [],
  });

  it('reclaims an idle review run, keeps its branch, and Continue restores the tree with the work', async () => {
    const review = await seed('review', daysAgo(9));
    const fresh = await seed('done', daysAgo(1));

    expect(await reclaimIdleWorktrees(repo, store, 7, opts())).toEqual([review.id]);

    expect(existsSync(review.worktreePath!)).toBe(false);
    expect(store.getRun(review.id)?.worktreeReclaimedAt).toBeDefined();
    expect(await localBranchExists(repo, review.branch!)).toBe(true);
    expect(existsSync(fresh.worktreePath!)).toBe(true);

    expect(await rematerializeReclaimedWorktree(repo, store, review.id)).toBe(true);
    expect(existsSync(join(review.worktreePath!, 'feature.txt'))).toBe(true);
    expect(store.getRun(review.id)?.worktreeReclaimedAt).toBeUndefined();
  });

  it('never touches a live run (a parked session) or a running one', async () => {
    const parked = await seed('waiting', daysAgo(30));
    const running = await seed('running', daysAgo(30));
    expect(await reclaimIdleWorktrees(repo, store, 7, opts(new Set([parked.id])))).toEqual([]);
    expect(existsSync(parked.worktreePath!)).toBe(true);
    expect(existsSync(running.worktreePath!)).toBe(true);
  });

  it('two passes reclaiming the same tree at once remove it once', async () => {
    const run = await seed('done', daysAgo(30));
    let removals = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const remove = async (_root: string, path: string) => {
      removals += 1;
      await gate;
      rmSync(path, { recursive: true, force: true });
    };
    const options = { remove, hasUnpreservedWork: async () => false };
    const first = reclaimRunWorktrees(repo, store, [run.id], () => true, options);
    await new Promise((r) => setTimeout(r, 20));
    const second = await reclaimRunWorktrees(repo, store, [run.id], () => true, options);
    release();
    expect(await first).toEqual([run.id]);
    expect(second).toEqual([]);
    expect(removals).toBe(1);
  });

  it('leaves a tree with uncommitted work on disk', async () => {
    const dirty = await seed('review', daysAgo(30));
    writeFileSync(join(dirty.worktreePath!, 'unsaved.txt'), 'x');
    expect(await reclaimIdleWorktrees(repo, store, 7, opts())).toEqual([]);
    expect(existsSync(dirty.worktreePath!)).toBe(true);
  });
});
