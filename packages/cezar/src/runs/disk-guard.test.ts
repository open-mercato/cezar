import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RunRecord, RunStatus } from './store.ts';
import {
  DiskGuard,
  diskGuardWarning,
  freeFloorBytes,
  nextGuardCandidate,
  runDiskGuard,
  type DiskGuardDeps,
  type DiskGuardThresholds,
  type GuardProject,
} from './disk-guard.ts';

const GIB = 1024 ** 3;
const DEFAULTS: DiskGuardThresholds = { minFreePercent: 10, minFreeGb: 5, maxWorktreesGb: 20 };

function run(id: string, status: RunStatus, lastActivity: string, extra: Partial<RunRecord> = {}): RunRecord {
  return { id, status, createdAt: lastActivity, worktreePath: `/repo/.ai/cezar/worktrees/${id}`, steps: [], ...extra } as unknown as RunRecord;
}

/** One project on one volume. Reclaiming a tree frees its size on the fake volume. */
function world(opts: {
  runs: RunRecord[];
  sizes: Record<string, number>;
  freeBytes: number;
  totalBytes?: number;
  live?: string[];
  thresholds?: DiskGuardThresholds;
}) {
  const runs = opts.runs;
  let free = opts.freeBytes;
  const reclaimCalls: string[] = [];
  const store = {
    listRuns: () => runs,
    updateRun: (id: string, patch: { worktreeReclaimedAt?: string }) => {
      const r = runs.find((x) => x.id === id)!;
      Object.assign(r, patch);
    },
  };
  const project: GuardProject = { id: 'p', root: '/repo', store, isLive: (id) => (opts.live ?? []).includes(id) };
  const worktreesDir = join('/repo', '.ai/cezar/worktrees');
  const sizeOf = (path: string) => {
    if (path === worktreesDir) return runs.filter((r) => !r.worktreeReclaimedAt).reduce((sum, r) => sum + (opts.sizes[r.id] ?? 0), 0);
    return opts.sizes[path.split('/').pop()!];
  };
  const deps: DiskGuardDeps = {
    roots: async () => [{ id: 'p', root: '/repo' }],
    open: async () => project,
    thresholds: async () => opts.thresholds ?? DEFAULTS,
    probe: () => ({ freeBytes: free, totalBytes: opts.totalBytes ?? 100 * GIB }),
    volume: () => 'vol',
    size: async (dir) => sizeOf(dir),
    reclaim: async (_project, ids) => {
      const out: string[] = [];
      for (const id of ids) {
        reclaimCalls.push(id);
        const r = runs.find((x) => x.id === id)!;
        if (project.isLive(id)) continue;
        r.worktreeReclaimedAt = '2026-11-19T00:00:00.000Z';
        free += opts.sizes[id] ?? 0;
        out.push(id);
      }
      return out;
    },
    reclaimed: () => {},
    now: () => Date.parse('2026-11-19T12:00:00Z'),
  };
  return { deps, reclaimCalls, runs };
}

describe('freeFloorBytes', () => {
  it('uses the smaller of the percent and GB floors, each 0 = off', () => {
    expect(freeFloorBytes(100 * GIB, DEFAULTS)).toBe(5 * GIB);
    expect(freeFloorBytes(20 * GIB, DEFAULTS)).toBe(2 * GIB);
    expect(freeFloorBytes(100 * GIB, { ...DEFAULTS, minFreeGb: 0 })).toBe(10 * GIB);
    expect(freeFloorBytes(100 * GIB, { ...DEFAULTS, minFreePercent: 0, minFreeGb: 0 })).toBeUndefined();
  });
});

describe('nextGuardCandidate', () => {
  const candidates = [
    { projectId: 'a', runId: 'new', volume: 'v1', lastActivityMs: 3 },
    { projectId: 'a', runId: 'old', volume: 'v2', lastActivityMs: 1 },
    { projectId: 'b', runId: 'mid', volume: 'v1', lastActivityMs: 2 },
  ];
  it('picks nothing while under every threshold', () => {
    expect(nextGuardCandidate({ volumes: [{ key: 'v1', freeBytes: 50 * GIB, totalBytes: 100 * GIB }], worktreesBytes: GIB }, DEFAULTS, candidates)).toBeUndefined();
  });
  it('picks the oldest tree on the short volume', () => {
    const state = { volumes: [{ key: 'v1', freeBytes: GIB, totalBytes: 100 * GIB }, { key: 'v2', freeBytes: 50 * GIB, totalBytes: 100 * GIB }] };
    expect(nextGuardCandidate(state, DEFAULTS, candidates)?.runId).toBe('mid');
  });
  it('picks the oldest anywhere when the worktrees total is over', () => {
    expect(nextGuardCandidate({ volumes: [], worktreesBytes: 21 * GIB }, DEFAULTS, candidates)?.runId).toBe('old');
  });
});

describe('runDiskGuard', () => {
  it('does nothing and opens no project while under the thresholds', async () => {
    const w = world({ runs: [run('a', 'done', '2026-01-01T00:00:00Z')], sizes: { a: GIB }, freeBytes: 50 * GIB });
    const open = vi.fn(w.deps.open);
    const pass = await runDiskGuard({ ...w.deps, open });
    expect(pass.reclaimed).toEqual([]);
    expect(open).not.toHaveBeenCalled();
    expect(pass.status.warning).toBeUndefined();
    expect(pass.status.worktreesBytes).toBe(GIB);
  });

  it('reclaims oldest activity first and stops once back under the threshold', async () => {
    const w = world({
      runs: [
        run('newest', 'review', '2026-11-18T00:00:00Z'),
        run('oldest', 'done', '2026-09-01T00:00:00Z'),
        run('middle', 'waiting', '2026-10-01T00:00:00Z'),
      ],
      sizes: { newest: 2 * GIB, oldest: 2 * GIB, middle: 2 * GIB },
      freeBytes: 2 * GIB, // floor is 5 GB: two reclaims (→ 6 GB) are enough
    });
    const pass = await runDiskGuard(w.deps);
    expect(w.reclaimCalls).toEqual(['oldest', 'middle']);
    expect(pass.reclaimed.map((r) => r.runId)).toEqual(['oldest', 'middle']);
    expect(pass.status.warning).toBeUndefined();
    expect(pass.status.lastAction).toEqual({ at: '2026-11-19T12:00:00.000Z', reclaimed: 2, freedBytes: 4 * GIB });
  });

  it('reclaims for the worktrees total, subtracting cached sizes', async () => {
    const w = world({
      runs: [run('a', 'done', '2026-01-01T00:00:00Z'), run('b', 'done', '2026-02-01T00:00:00Z'), run('c', 'done', '2026-03-01T00:00:00Z')],
      sizes: { a: 2 * GIB, b: 2 * GIB, c: 18 * GIB },
      freeBytes: 500 * GIB,
      totalBytes: 1000 * GIB,
    });
    const pass = await runDiskGuard(w.deps);
    // 22 GB > 20 GB: one 2 GB tree brings it to 20, which is not over.
    expect(pass.reclaimed.map((r) => r.runId)).toEqual(['a']);
    expect(pass.status.worktreesBytes).toBe(20 * GIB);
  });

  it('never touches active, live, pinned or scheduled runs', async () => {
    const w = world({
      runs: [
        run('running', 'running', '2026-01-01T00:00:00Z'),
        run('queued', 'queued', '2026-01-01T00:00:00Z'),
        run('parked', 'waiting', '2026-01-01T00:00:00Z'),
        run('pinned', 'done', '2026-01-01T00:00:00Z', { pinned: true }),
        run('waking', 'waiting', '2026-01-01T00:00:00Z', { monitoringWakeAt: '2026-11-20T00:00:00Z' }),
        run('idle', 'done', '2026-06-01T00:00:00Z'),
      ],
      sizes: { running: GIB, queued: GIB, parked: GIB, pinned: GIB, waking: GIB, idle: GIB },
      freeBytes: GIB,
      live: ['parked'],
    });
    const pass = await runDiskGuard(w.deps);
    expect(w.reclaimCalls).toEqual(['idle']);
    expect(pass.reclaimed.map((r) => r.runId)).toEqual(['idle']);
  });

  it('warns with the worktrees total when reclaiming is not enough', async () => {
    const w = world({
      runs: [run('active', 'running', '2026-01-01T00:00:00Z'), run('idle', 'done', '2026-01-01T00:00:00Z')],
      sizes: { active: 12 * GIB, idle: GIB },
      freeBytes: GIB,
    });
    const pass = await runDiskGuard(w.deps);
    expect(pass.reclaimed.map((r) => r.runId)).toEqual(['idle']);
    expect(pass.status.warning).toBe('Disk almost full — 12.0 GB in task worktrees');
    expect(pass.status.freeBytes).toBe(2 * GIB);
  });

  it('every threshold at 0 turns the guard off', async () => {
    const w = world({ runs: [run('a', 'done', '2026-01-01T00:00:00Z')], sizes: { a: 30 * GIB }, freeBytes: 0, thresholds: { minFreePercent: 0, minFreeGb: 0, maxWorktreesGb: 0 } });
    const pass = await runDiskGuard(w.deps);
    expect(pass.reclaimed).toEqual([]);
    expect(pass.status.warning).toBeUndefined();
  });
});

describe('DiskGuard', () => {
  it('keeps the last action across passes that reclaim nothing, and stops its timer', async () => {
    const w = world({ runs: [run('a', 'done', '2026-01-01T00:00:00Z')], sizes: { a: GIB }, freeBytes: 4.5 * GIB });
    const guard = new DiskGuard(w.deps, 60_000);
    await guard.runOnce();
    expect(guard.status().lastAction?.reclaimed).toBe(1);
    await guard.runOnce();
    expect(guard.status().lastAction?.reclaimed).toBe(1);
    expect(guard.status().warning).toBeUndefined();
    guard.start();
    guard.stop();
  });

  it('words the warning without a size when none is known', () => {
    expect(diskGuardWarning(undefined)).toBe('Disk almost full — task worktrees could not be reclaimed');
  });

  it('never rounds a small worktrees total up to a gigabyte it does not hold', () => {
    expect(diskGuardWarning(48 * 1024)).toBe('Disk almost full — under 1 GB in task worktrees');
    expect(diskGuardWarning(17.4 * 1024 ** 3)).toBe('Disk almost full — 17.0 GB in task worktrees');
  });
});
