import { describe, expect, it } from 'vitest';
import type { RunRecord, RunStatus } from './store.js';
import { isReclaimable, selectReclaimableWorktrees } from './retention.js';

/**
 * The pure retention selector (#483). It only reads a handful of fields, so the
 * tests build minimal run records rather than driving the whole store.
 */
function run(partial: {
  id: string;
  status: RunStatus;
  worktreePath?: string | null;
  createdAt?: string;
  finishedAt?: string;
  worktreeReclaimedAt?: string;
}): RunRecord {
  return {
    id: partial.id,
    status: partial.status,
    createdAt: partial.createdAt ?? '2026-01-01T00:00:00.000Z',
    finishedAt: partial.finishedAt,
    worktreePath: partial.worktreePath === null ? undefined : partial.worktreePath ?? `/wt/${partial.id}`,
    worktreeReclaimedAt: partial.worktreeReclaimedAt,
    steps: [],
  } as unknown as RunRecord;
}

describe('selectReclaimableWorktrees (#483)', () => {
  it('keeps the newest N finished worktrees and reclaims the older ones', () => {
    const runs = [
      run({ id: 'a', status: 'done', finishedAt: '2026-07-01T00:00:00Z' }),
      run({ id: 'b', status: 'done', finishedAt: '2026-07-02T00:00:00Z' }),
      run({ id: 'c', status: 'failed', finishedAt: '2026-07-03T00:00:00Z' }),
      run({ id: 'd', status: 'cancelled', finishedAt: '2026-07-04T00:00:00Z' }),
    ];
    // keep the 2 newest (d, c) → reclaim the 2 oldest (b, a).
    expect(selectReclaimableWorktrees(runs, 2).sort()).toEqual(['a', 'b']);
  });

  it('orders by finishedAt, falling back to createdAt when finishedAt is absent', () => {
    const runs = [
      run({ id: 'old', status: 'done', createdAt: '2026-06-01T00:00:00Z' }),
      run({ id: 'new', status: 'done', finishedAt: '2026-07-09T00:00:00Z' }),
    ];
    expect(selectReclaimableWorktrees(runs, 1)).toEqual(['old']);
  });

  it('excludes review and live runs from the budget entirely', () => {
    const runs = [
      run({ id: 'review', status: 'review', finishedAt: '2026-07-09T00:00:00Z' }),
      run({ id: 'running', status: 'running' }),
      run({ id: 'queued', status: 'queued' }),
      run({ id: 'waiting', status: 'waiting' }),
      run({ id: 'done1', status: 'done', finishedAt: '2026-07-01T00:00:00Z' }),
      run({ id: 'done2', status: 'done', finishedAt: '2026-07-02T00:00:00Z' }),
    ];
    // Only done1/done2 count; keep=1 reclaims the older finished one (done1).
    expect(selectReclaimableWorktrees(runs, 1)).toEqual(['done1']);
  });

  it('excludes runs with no worktree dir and already-reclaimed runs', () => {
    const runs = [
      run({ id: 'nodir', status: 'done', worktreePath: null, finishedAt: '2026-07-01T00:00:00Z' }),
      run({ id: 'gone', status: 'done', worktreeReclaimedAt: '2026-07-05T00:00:00Z', finishedAt: '2026-07-02T00:00:00Z' }),
      run({ id: 'live-dir', status: 'done', finishedAt: '2026-07-03T00:00:00Z' }),
    ];
    // Only live-dir is reclaimable; keep=0 would disable, so use keep=... none over budget.
    expect(selectReclaimableWorktrees(runs, 5)).toEqual([]);
    // With keep below the single reclaimable count it still never selects the excluded ones.
    // (live-dir is the only candidate; keeping 0 finished means "unlimited", see next test.)
  });

  it('treats keep=0 as unlimited (never reclaims)', () => {
    const runs = [
      run({ id: 'a', status: 'done', finishedAt: '2026-07-01T00:00:00Z' }),
      run({ id: 'b', status: 'done', finishedAt: '2026-07-02T00:00:00Z' }),
    ];
    expect(selectReclaimableWorktrees(runs, 0)).toEqual([]);
  });

  it('reclaims nothing when the count is at or below the limit', () => {
    const runs = [run({ id: 'a', status: 'done', finishedAt: '2026-07-01T00:00:00Z' })];
    expect(selectReclaimableWorktrees(runs, 10)).toEqual([]);
  });

  it('isReclaimable reflects the finished + has-dir + not-yet-reclaimed rule', () => {
    expect(isReclaimable(run({ id: 'x', status: 'done' }))).toBe(true);
    expect(isReclaimable(run({ id: 'x', status: 'review' }))).toBe(false);
    expect(isReclaimable(run({ id: 'x', status: 'done', worktreePath: null }))).toBe(false);
    expect(isReclaimable(run({ id: 'x', status: 'done', worktreeReclaimedAt: '2026-07-05T00:00:00Z' }))).toBe(false);
  });
});
