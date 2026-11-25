import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RunRecord, RunStatus } from './store.ts';
import { enforceWorktreeRetention, freePrCheckoutsOf, isReclaimable, rematerializeReclaimedWorktree, selectReclaimableWorktrees, reclaimIdlePrCheckouts, reclaimSelectedWorktrees, reclaimWorktrees } from './retention.ts';

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
  pinned?: boolean;
}): RunRecord {
  return {
    id: partial.id,
    status: partial.status,
    createdAt: partial.createdAt ?? '2026-01-01T00:00:00.000Z',
    finishedAt: partial.finishedAt,
    worktreePath: partial.worktreePath === null ? undefined : partial.worktreePath ?? `/wt/${partial.id}`,
    worktreeReclaimedAt: partial.worktreeReclaimedAt,
    ...(partial.pinned ? { pinned: true } : {}),
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

  it('never reclaims a pinned task and does not count it toward keep', () => {
    const runs = [
      run({ id: 'pinned-old', status: 'done', finishedAt: '2026-07-01T00:00:00Z', pinned: true }),
      run({ id: 'a', status: 'done', finishedAt: '2026-07-02T00:00:00Z' }),
      run({ id: 'b', status: 'done', finishedAt: '2026-07-03T00:00:00Z' }),
    ];
    expect(selectReclaimableWorktrees(runs, 1)).toEqual(['a']);
    expect(isReclaimable(runs[0]!)).toBe(false);
  });

  it('isReclaimable reflects the finished + has-dir + not-yet-reclaimed rule', () => {
    expect(isReclaimable(run({ id: 'x', status: 'done' }))).toBe(true);
    expect(isReclaimable(run({ id: 'x', status: 'review' }))).toBe(false);
    expect(isReclaimable(run({ id: 'x', status: 'done', worktreePath: null }))).toBe(false);
    expect(isReclaimable(run({ id: 'x', status: 'done', worktreeReclaimedAt: '2026-07-05T00:00:00Z' }))).toBe(false);
  });
});


describe('reclamation lifecycle gate', () => {
  it('reports only verified removals and keeps scanning after gated or malformed candidates', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-retention-lifecycle-'));
    try {
      const records = ['malformed', 'gated', 'ordinary', 'newest'].map((id, index) => {
        const path = join(root, id); mkdirSync(path);
        return run({ id, status: 'done', worktreePath: path, finishedAt: `2026-07-0${index + 1}T00:00:00Z` });
      });
      const update = vi.fn((id: string, patch: {worktreeReclaimedAt?: string}) => Object.assign(records.find(record => record.id === id)!, patch));
      const gatedReclaim = vi.fn(async () => false);
      const remove = vi.fn(async (_root: string, path: string) => { rmSync(path, { recursive: true }); });
      const reclaimed = await reclaimWorktrees(root, { listRuns: () => records, updateRun: update }, 1, {
        remove, hasUnpreservedWork: async () => false,
        lifecycle: {
          requiresGate: async id => { if (id === 'malformed') throw new Error('malformed config'); return id === 'gated'; },
          reclaim: gatedReclaim,
        },
      });
      expect(reclaimed).toEqual(['ordinary']);
      expect(gatedReclaim).toHaveBeenCalledWith('gated');
      expect(remove).toHaveBeenCalledTimes(1);
      expect(existsSync(join(root, 'ordinary'))).toBe(false);
      expect(existsSync(join(root, 'gated'))).toBe(true);
      expect(existsSync(join(root, 'malformed'))).toBe(true);
      expect(existsSync(join(root, 'newest'))).toBe(true);
      expect(update).toHaveBeenCalledTimes(1);
      expect(records.find(record => record.id === 'gated')?.worktreeReclaimedAt).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('reclaimIdlePrCheckouts', () => {
  it('reclaims tree/ for idle runs older than days (in-place included) while keeping diff/meta and protecting active or recent runs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-pr-retention-'));
    try {
      const nowMs = Date.parse('2026-07-15T00:00:00Z');
      const old = '2026-07-01T00:00:00Z';
      const fresh = '2026-07-12T00:00:00Z';
      const records: RunRecord[] = [
        run({ id: 'idle-done', status: 'done', finishedAt: old }),
        run({ id: 'idle-inplace', status: 'review', worktreePath: null, finishedAt: old }),
        run({ id: 'recent', status: 'done', finishedAt: fresh }),
        run({ id: 'pinned', status: 'done', finishedAt: old, pinned: true }),
        run({ id: 'live', status: 'waiting', finishedAt: old }),
        run({ id: 'running', status: 'running', createdAt: old }),
        Object.assign(run({ id: 'waking', status: 'waiting', finishedAt: old }), { monitoringWakeAt: '2026-07-15T01:00:00Z' }),
        Object.assign(run({ id: 'resuming', status: 'waiting', finishedAt: old }), { autoResumeAt: '2026-07-15T01:00:00Z' }),
        run({ id: 'claimed', status: 'done', worktreePath: root, finishedAt: old }),
      ];
      for (const r of records) {
        mkdirSync(join(root, r.id, 'tree'), { recursive: true });
        writeFileSync(join(root, r.id, 'tree', 'a.txt'), 'pr\n');
        writeFileSync(join(root, r.id, 'pr-7.diff'), 'diff\n');
      }
      const store = { listRuns: () => records, updateRun: vi.fn(), prCheckoutDir: (id: string) => join(root, id) };
      // A Continue claims its run before reading it; its export must survive the pass.
      await rematerializeReclaimedWorktree(root, { getRun: (id) => records.find((r) => r.id === id), updateRun: vi.fn() }, 'claimed');
      expect(reclaimIdlePrCheckouts(store, 0, { isLive: (id) => id === 'live', nowMs: () => nowMs })).toEqual([]);
      expect(reclaimIdlePrCheckouts(store, 7, { isLive: (id) => id === 'live', nowMs: () => nowMs })).toEqual(['idle-done', 'idle-inplace']);
      for (const id of ['idle-done', 'idle-inplace']) {
        expect(existsSync(join(root, id, 'tree'))).toBe(false);
        expect(existsSync(join(root, id, 'pr-7.diff'))).toBe(true);
      }
      for (const id of ['recent', 'pinned', 'live', 'running', 'waking', 'resuming', 'claimed']) {
        expect(existsSync(join(root, id, 'tree'))).toBe(true);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  /** A run's PR export as the checkout leaves it: a tree, and read-only diff and metadata. */
  function exportFor(root: string, id: string) {
    mkdirSync(join(root, id, 'tree'), { recursive: true });
    writeFileSync(join(root, id, 'tree', 'a.txt'), 'pr\n');
    for (const f of ['pr-7.diff', 'pr-7.json']) rmSync(join(root, id, f), { force: true });
    writeFileSync(join(root, id, 'pr-7.diff'), 'diff\n', { mode: 0o444 });
    writeFileSync(join(root, id, 'pr-7.json'), JSON.stringify({ number: 7, checkedOut: true, tree: join(root, id, 'tree') }), { mode: 0o444 });
  }

  it("says so in pr-N.json once the tree is gone, and keeps it read-only", () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-pr-retention-'));
    try {
      exportFor(root, 'r1');
      // The user's copy in the artifacts, as the checkout leaves it.
      const artifacts = join(root, 'artifacts', 'r1');
      mkdirSync(artifacts, { recursive: true });
      writeFileSync(join(artifacts, 'pr-7.json'), readFileSync(join(root, 'r1', 'pr-7.json')), { mode: 0o444 });
      const store = {
        listRuns: () => [run({ id: 'r1', status: 'done', finishedAt: '2026-07-01T00:00:00Z' })], updateRun: vi.fn(),
        prCheckoutDir: (id: string) => join(root, id), artifactsDir: (id: string) => join(root, 'artifacts', id),
      };
      expect(reclaimIdlePrCheckouts(store, 7, { isLive: () => false, nowMs: () => Date.parse('2026-07-15T00:00:00Z') })).toEqual(['r1']);
      const meta = JSON.parse(readFileSync(join(root, 'r1', 'pr-7.json'), 'utf8'));
      expect(meta).toMatchObject({ number: 7, checkedOut: false });
      expect(meta.tree).toBeUndefined();
      expect(typeof meta.treeReclaimedAt).toBe('string');
      expect(statSync(join(root, 'r1', 'pr-7.json')).mode & 0o222).toBe(0);
      // ...and the copy Assets shows says the same, still read-only.
      const copy = JSON.parse(readFileSync(join(artifacts, 'pr-7.json'), 'utf8'));
      expect(copy).toMatchObject({ number: 7, checkedOut: false, treeReclaimedAt: meta.treeReclaimedAt });
      expect(copy.tree).toBeUndefined();
      expect(statSync(join(artifacts, 'pr-7.json')).mode & 0o222).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('never writes through a symlink planted at the artifacts copy of pr-N.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-pr-retention-'));
    try {
      exportFor(root, 'r1');
      const victim = join(root, 'victim.json');
      writeFileSync(victim, JSON.stringify({ secret: true }));
      const artifacts = join(root, 'artifacts', 'r1');
      mkdirSync(artifacts, { recursive: true });
      symlinkSync(victim, join(artifacts, 'pr-7.json'));
      const store = {
        listRuns: () => [run({ id: 'r1', status: 'done', finishedAt: '2026-07-01T00:00:00Z' })], updateRun: vi.fn(),
        prCheckoutDir: (id: string) => join(root, id), artifactsDir: (id: string) => join(root, 'artifacts', id),
      };
      expect(reclaimIdlePrCheckouts(store, 7, { isLive: () => false, nowMs: () => Date.parse('2026-07-15T00:00:00Z') })).toEqual(['r1']);
      expect(readFileSync(victim, 'utf8')).toBe(JSON.stringify({ secret: true }));
      expect(lstatSync(join(artifacts, 'pr-7.json')).isSymbolicLink()).toBe(false);
      expect(statSync(join(artifacts, 'pr-7.json')).mode & 0o222).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('frees an archived or manually reclaimed run whatever its age, but never a live or pinned one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-pr-retention-'));
    try {
      const fresh = new Date().toISOString();
      const records: RunRecord[] = [
        run({ id: 'picked', status: 'done', worktreePath: null, finishedAt: fresh }),
        run({ id: 'live', status: 'done', worktreePath: null, finishedAt: fresh }),
        run({ id: 'pinned', status: 'done', worktreePath: null, finishedAt: fresh, pinned: true }),
        run({ id: 'other', status: 'done', worktreePath: null, finishedAt: fresh }),
      ];
      for (const r of records) exportFor(root, r.id);
      const store = { listRuns: () => records, updateRun: vi.fn(), prCheckoutDir: (id: string) => join(root, id) };
      const isLive = (id: string) => id === 'live';
      expect(freePrCheckoutsOf(store, ['picked', 'live', 'pinned'], isLive)).toEqual(['picked']);
      exportFor(root, 'picked');
      // "Reclaim now" for chosen runs and archive both go through reclaimSelectedWorktrees.
      await reclaimSelectedWorktrees(root, store, ['picked'], { isLive });
      expect(existsSync(join(root, 'picked', 'tree'))).toBe(false);
      for (const id of ['live', 'pinned', 'other']) expect(existsSync(join(root, id, 'tree'))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('runs inside enforceWorktreeRetention: the idle pass and the archive pass both free exports', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-pr-retention-'));
    try {
      const records: RunRecord[] = [
        // Idle past the default 7 days.
        run({ id: 'idle', status: 'done', worktreePath: null, finishedAt: '2020-01-01T00:00:00Z' }),
        Object.assign(run({ id: 'archived', status: 'done', worktreePath: null, finishedAt: new Date().toISOString() }), { archived: true }),
        run({ id: 'recent', status: 'done', worktreePath: null, finishedAt: new Date().toISOString() }),
      ];
      for (const r of records) exportFor(root, r.id);
      const store = { listRuns: () => records, updateRun: vi.fn(), prCheckoutDir: (id: string) => join(root, id) };
      await enforceWorktreeRetention(root, store, { isLive: () => false });
      expect(existsSync(join(root, 'idle', 'tree'))).toBe(false);
      expect(existsSync(join(root, 'archived', 'tree'))).toBe(false);
      expect(existsSync(join(root, 'recent', 'tree'))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
