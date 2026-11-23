// The disk-space guard (spec 2026-11-19-worktree-disk-usage, decision 3). Each pass is one `statfs`
// per worktrees volume plus cached `du` sizes; only when a threshold is crossed does it open
// projects and reclaim idle trees, oldest activity first across every project, until back under.
// A pure planner decides the next tree; the enforcer only probes, reclaims and records.
import { join } from 'node:path';
import {
  adjustCachedDirSize,
  dirSizeForBackground,
  forgetDirSize,
  formatBytes,
  probeDiskSpace,
  volumeOf,
  type DiskSpace,
} from '../disk-space.ts';
import { WORKTREES_DIR, worktreeSizeBytes } from '../git-worktree.ts';
import { isIdleReclaimable, reclaimSelectedWorktrees, storeActivity, type ReclaimOptions, type RetentionStore } from './retention.ts';

const GIB = 1024 ** 3;

/** Every pass after boot: free space moves slowly next to a 10-minute `du` TTL. */
export const DISK_GUARD_INTERVAL_MS = 10 * 60_000;

export interface DiskGuardThresholds {
  minFreePercent: number;
  minFreeGb: number;
  maxWorktreesGb: number;
}

/** Free space below this triggers the guard: the SMALLER of the two free thresholds, each 0 = off.
 *  `undefined` when both are off. */
export function freeFloorBytes(totalBytes: number, thresholds: DiskGuardThresholds): number | undefined {
  const floors: number[] = [];
  if (thresholds.minFreePercent > 0) floors.push(totalBytes * (thresholds.minFreePercent / 100));
  if (thresholds.minFreeGb > 0) floors.push(thresholds.minFreeGb * GIB);
  return floors.length ? Math.min(...floors) : undefined;
}

export interface GuardVolume {
  key: string;
  freeBytes: number;
  totalBytes: number;
}

export interface GuardState {
  volumes: readonly GuardVolume[];
  /** All task worktrees, every project; undefined while no `du` has answered yet. */
  worktreesBytes?: number;
}

/** What is over: the volumes short of free space, and whether the worktrees total is too big. */
export function guardTriggers(state: GuardState, thresholds: DiskGuardThresholds): { shortVolumes: Set<string>; overTotal: boolean } {
  const shortVolumes = new Set<string>();
  for (const volume of state.volumes) {
    const floor = freeFloorBytes(volume.totalBytes, thresholds);
    if (floor !== undefined && volume.freeBytes < floor) shortVolumes.add(volume.key);
  }
  const overTotal = thresholds.maxWorktreesGb > 0 && state.worktreesBytes !== undefined
    && state.worktreesBytes > thresholds.maxWorktreesGb * GIB;
  return { shortVolumes, overTotal };
}

export interface GuardCandidate {
  projectId: string;
  runId: string;
  volume?: string;
  lastActivityMs: number;
}

/**
 * The next tree to reclaim, or undefined when nothing is over or no candidate helps: the oldest
 * activity first, among trees on a short volume — any tree when the worktrees total is over. Pure.
 */
export function nextGuardCandidate(
  state: GuardState,
  thresholds: DiskGuardThresholds,
  candidates: readonly GuardCandidate[],
): GuardCandidate | undefined {
  const { shortVolumes, overTotal } = guardTriggers(state, thresholds);
  if (!overTotal && shortVolumes.size === 0) return undefined;
  return [...candidates]
    .sort((a, b) => a.lastActivityMs - b.lastActivityMs)
    .find((candidate) => overTotal || (candidate.volume !== undefined && shortVolumes.has(candidate.volume)));
}

/** The warning the cockpit, the attention dot and the notification share. */
export function diskGuardWarning(worktreesBytes: number | undefined): string {
  if (worktreesBytes === undefined) return 'Disk almost full — task worktrees could not be reclaimed';
  // Whole GiB: health carries this and is CORS-open, like its other sizes (#431).
  return worktreesBytes < GIB
    ? 'Disk almost full — under 1 GB in task worktrees'
    : `Disk almost full — ${formatBytes(Math.round(worktreesBytes / GIB) * GIB)} in task worktrees`;
}

/** A registered project, cheap to list: no store, no manager. */
export interface GuardRoot {
  id: string;
  root: string;
}

/** A project opened for reclaiming. */
export interface GuardProject extends GuardRoot {
  store: RetentionStore;
  /** True while the project's manager owns the run (`RunManager.isActive`). */
  isLive: (runId: string) => boolean;
  lifecycle?: ReclaimOptions['lifecycle'];
}

export interface DiskGuardDeps {
  /** Every registered project with a root on disk — the registry, never a context build. */
  roots: () => Promise<readonly GuardRoot[]>;
  /** Open one project to reclaim in it (builds its context); undefined when it cannot. */
  open: (id: string) => Promise<GuardProject | undefined>;
  thresholds: () => Promise<DiskGuardThresholds>;
  probe?: (path: string) => DiskSpace | undefined;
  volume?: (path: string) => string | undefined;
  /** Cached size of a directory, awaiting one `du` only when nothing is cached. */
  size?: (dir: string) => Promise<number | undefined>;
  /** Reclaim these runs' trees; returns the ids reclaimed. Defaults to `reclaimSelectedWorktrees`. */
  reclaim?: (project: GuardProject, ids: readonly string[]) => Promise<string[]>;
  /** Tell the cached sizes a tree of `bytes` under `worktreesDir` is gone. */
  reclaimed?: (worktreesDir: string, worktreePath: string, bytes: number | undefined) => void;
  now?: () => number;
}

export interface DiskGuardStatus {
  thresholds?: DiskGuardThresholds;
  checkedAt?: string;
  /** The tightest worktrees volume. */
  freeBytes?: number;
  totalBytes?: number;
  worktreesBytes?: number;
  lastAction?: { at: string; reclaimed: number; freedBytes?: number };
  /** Set while a threshold is still crossed after reclaiming everything it could. */
  warning?: string;
}

export interface DiskGuardPass {
  reclaimed: { projectId: string; runId: string }[];
  status: DiskGuardStatus;
}

const defaultSize = (dir: string) => dirSizeForBackground(dir, worktreeSizeBytes);

function defaultReclaimed(worktreesDir: string, worktreePath: string, bytes: number | undefined): void {
  forgetDirSize(worktreePath);
  if (bytes !== undefined) adjustCachedDirSize(worktreesDir, -bytes);
}

function defaultReclaim(project: GuardProject, ids: readonly string[]): Promise<string[]> {
  return reclaimSelectedWorktrees(project.root, project.store, ids, {
    isLive: project.isLive,
    activity: storeActivity(project.store),
    ...(project.lifecycle ? { lifecycle: project.lifecycle } : {}),
  });
}

/**
 * One guard pass. Never throws and never touches a live, pinned, scheduled or in-use run
 * (`reclaimSelectedWorktrees` re-checks each right before removal). Re-probes the volume and
 * subtracts the tree's cached size after every reclaim, and stops as soon as nothing is over.
 */
export async function runDiskGuard(deps: DiskGuardDeps): Promise<DiskGuardPass> {
  const probe = deps.probe ?? probeDiskSpace;
  const volumeKey = deps.volume ?? volumeOf;
  const size = deps.size ?? defaultSize;
  const reclaim = deps.reclaim ?? defaultReclaim;
  const onReclaimed = deps.reclaimed ?? defaultReclaimed;
  const now = deps.now ?? Date.now;
  const thresholds = await deps.thresholds();
  const roots = await deps.roots().catch(() => [] as GuardRoot[]);

  const volumes = new Map<string, GuardVolume>();
  const volumeOfProject = new Map<string, string>();
  const dirOfProject = new Map<string, string>();
  let worktreesBytes: number | undefined;
  for (const project of roots) {
    const dir = join(project.root, WORKTREES_DIR);
    dirOfProject.set(project.id, dir);
    const space = probe(dir);
    const key = volumeKey(dir) ?? dir;
    volumeOfProject.set(project.id, key);
    if (space) volumes.set(key, { key, ...space });
    const bytes = await size(dir).catch(() => undefined);
    if (bytes !== undefined) worktreesBytes = (worktreesBytes ?? 0) + bytes;
  }
  const state = (): GuardState => ({ volumes: [...volumes.values()], ...(worktreesBytes !== undefined ? { worktreesBytes } : {}) });
  const reclaimed: DiskGuardPass['reclaimed'] = [];
  let freedBytes: number | undefined;

  const triggered = () => {
    const { shortVolumes, overTotal } = guardTriggers(state(), thresholds);
    return overTotal || shortVolumes.size > 0;
  };

  if (triggered()) {
    // Only now pay for opening projects: the common pass ends above with a statfs and cached sizes.
    const opened = new Map<string, GuardProject>();
    const candidates: GuardCandidate[] = [];
    for (const root of roots) {
      const project = await deps.open(root.id).catch(() => undefined);
      if (!project) continue;
      opened.set(root.id, project);
      const activity = storeActivity(project.store);
      for (const run of project.store.listRuns()) {
        if (!isIdleReclaimable(run) || project.isLive(run.id)) continue;
        const volume = volumeOfProject.get(root.id);
        candidates.push({ projectId: root.id, runId: run.id, lastActivityMs: Date.parse(activity(run)) || 0, ...(volume ? { volume } : {}) });
      }
    }
    let remaining = candidates;
    for (let next = nextGuardCandidate(state(), thresholds, remaining); next; next = nextGuardCandidate(state(), thresholds, remaining)) {
      const picked = next;
      remaining = remaining.filter((candidate) => candidate !== picked);
      const project = opened.get(picked.projectId)!;
      const path = project.store.listRuns().find((run) => run.id === picked.runId)?.worktreePath;
      const bytes = path ? await size(path).catch(() => undefined) : undefined;
      const done = await reclaim(project, [picked.runId]).catch(() => [] as string[]);
      if (!done.includes(picked.runId)) continue;
      reclaimed.push({ projectId: picked.projectId, runId: picked.runId });
      const dir = dirOfProject.get(picked.projectId)!;
      if (path) onReclaimed(dir, path, bytes);
      if (bytes !== undefined) {
        freedBytes = (freedBytes ?? 0) + bytes;
        if (worktreesBytes !== undefined) worktreesBytes = Math.max(0, worktreesBytes - bytes);
      }
      const space = probe(dir);
      const key = volumeOfProject.get(picked.projectId)!;
      if (space) volumes.set(key, { key, ...space });
    }
  }

  const tightest = [...volumes.values()].sort((a, b) => a.freeBytes - b.freeBytes)[0];
  const at = new Date(now()).toISOString();
  const status: DiskGuardStatus = {
    thresholds,
    checkedAt: at,
    ...(tightest ? { freeBytes: tightest.freeBytes, totalBytes: tightest.totalBytes } : {}),
    ...(worktreesBytes !== undefined ? { worktreesBytes } : {}),
    ...(reclaimed.length > 0 ? { lastAction: { at, reclaimed: reclaimed.length, ...(freedBytes !== undefined ? { freedBytes } : {}) } } : {}),
    ...(triggered() ? { warning: diskGuardWarning(worktreesBytes) } : {}),
  };
  return { reclaimed, status };
}

/**
 * The workspace-level guard: one pass at start (boot, after the retention sweep), then every
 * `intervalMs` on an unref'd timer. Passes never overlap. `status()` is what health and the
 * status route read — a pass that reclaimed nothing keeps the previous `lastAction`.
 */
export class DiskGuard {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<DiskGuardPass> | undefined;
  private last: DiskGuardStatus = {};
  private stopped = false;

  constructor(
    private readonly deps: DiskGuardDeps,
    private readonly intervalMs = DISK_GUARD_INTERVAL_MS,
    private readonly log: (message: string) => void = () => {},
  ) {}

  start(): void {
    if (this.timer || this.stopped) return;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  status(): DiskGuardStatus {
    return this.last;
  }

  runOnce(): Promise<DiskGuardPass> {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        const pass = await runDiskGuard(this.deps);
        const lastAction = pass.status.lastAction ?? this.last.lastAction;
        this.last = { ...pass.status, ...(lastAction ? { lastAction } : {}) };
        if (pass.reclaimed.length > 0) {
          this.log(`disk guard reclaimed ${pass.reclaimed.length} idle worktree(s), branch kept: ${pass.reclaimed.map((r) => r.runId.slice(0, 8)).join(', ')}`);
        }
        return pass;
      } catch {
        return { reclaimed: [], status: this.last };
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }
}
