// Free-space awareness (telemetry 9cdcedc3: `codex: ENOSPC: no space left on device, write`).
// Every task owns a full worktree, so cezar is a likely contributor to a full disk. This module
// probes the volume cheaply (one `statfs`), names the floor below which an agent must not start,
// and words the one actionable message the spawn guard, health and the ENOSPC error share.
// Cleanup is NOT invented here: worktree retention (#483, runs/retention.ts) already reclaims
// finished tasks' worktrees, so every message points at it.
import * as fs from 'node:fs';
import { dirname, resolve } from 'node:path';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** Below this an agent is refused: 1 GiB, or 2% of the volume when that is smaller (a small
 *  disk must not be blocked forever by a floor sized for a large one). */
export function diskFloorBytes(totalBytes: number): number {
  return Math.min(GIB, Math.floor(totalBytes * 0.02));
}

/** Below this health warns, without blocking anything. */
export const DISK_SOFT_BYTES = 5 * GIB;

export interface DiskSpace {
  freeBytes: number;
  totalBytes: number;
}

export type DiskLevel = 'ok' | 'low' | 'critical';

export function diskLevel(space: DiskSpace): DiskLevel {
  if (space.freeBytes < diskFloorBytes(space.totalBytes)) return 'critical';
  return space.freeBytes < DISK_SOFT_BYTES ? 'low' : 'ok';
}

/** The nearest existing ancestor of `path` — the worktrees dir may not exist yet, but the
 *  volume it will live on does. */
function existingAncestor(path: string): string {
  let current = resolve(path);
  while (!fs.existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

/**
 * Free and total bytes on the volume holding `path`, or `undefined` where `statfs` is missing
 * (Node < 18.15) or fails. One syscall; never throws — a probe that cannot answer never blocks.
 */
export function probeDiskSpace(path: string): DiskSpace | undefined {
  const statfsSync = (fs as { statfsSync?: typeof fs.statfsSync }).statfsSync;
  if (typeof statfsSync !== 'function') return undefined;
  try {
    const stats = statfsSync(existingAncestor(path));
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    if (!Number.isFinite(freeBytes) || !Number.isFinite(totalBytes) || totalBytes <= 0) return undefined;
    return { freeBytes, totalBytes };
  } catch {
    return undefined;
  }
}

export function formatBytes(bytes: number): string {
  return bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GB` : `${Math.max(0, Math.round(bytes / MIB))} MB`;
}

/** Where the existing cleanup lives (#483). */
const RECLAIM_HINT =
  "free space — Settings → Worktrees → Reclaim now removes finished tasks' worktrees (their branches are kept), and deleting old tasks removes theirs — then Continue";

/** What a run refused at spawn reports. */
export function lowDiskSpaceMessage(backend: string, path: string, freeBytes: number): string {
  return `${backend}: cannot start — only ${formatBytes(freeBytes)} free on the disk holding ${path}. Please ${RECLAIM_HINT}.`;
}

/** The pre-spawn verdict: an error message below the floor, else `null` (also when the probe
 *  cannot answer — never block on an unknown). */
export function diskFloorRefusal(backend: string, path: string, probe = probeDiskSpace): string | null {
  const space = probe(path);
  if (!space || space.freeBytes >= diskFloorBytes(space.totalBytes)) return null;
  return lowDiskSpaceMessage(backend, path, space.freeBytes);
}

/** An agent error that is the disk running out (Node's `ENOSPC` wording or the code itself). */
export function isDiskFullError(text: string): boolean {
  return /\bENOSPC\b|no space left on device/i.test(text);
}

/**
 * The actionable text for an ENOSPC agent error, or `null` when `text` is not one. For the
 * agent-error classifier (runs/failure-kind.ts, owned elsewhere) to adopt: it keeps the original
 * error and adds the free space now (when `path` is given and probe-able) and the cleanup hint.
 */
export function diskFullAgentErrorText(text: string, path?: string, probe = probeDiskSpace): string | null {
  if (!isDiskFullError(text)) return null;
  const space = path ? probe(path) : undefined;
  const where = space ? ` (${formatBytes(space.freeBytes)} free now on the disk holding ${path})` : '';
  return `${text.trim()} — the disk is full${where}. Please ${RECLAIM_HINT}.`;
}

/** How long a worktrees-size estimate is reused: `du` over many checkouts is seconds of I/O. */
const SIZE_TTL_MS = 10 * 60_000;
const sizeCache = new Map<string, { at: number; bytes: number | null }>();
const sizeInFlight = new Set<string>();

/**
 * The cached size of `dir`, refreshed in the BACKGROUND when stale — never awaited, so a request
 * path pays nothing; the first call answers `undefined`. `sizer` is `worktreeSizeBytes` (POSIX
 * `du`, `null` on Windows), passed in so this module stays free of git.
 */
export function cachedDirSize(
  dir: string,
  sizer: (path: string) => Promise<number | null>,
  now = Date.now(),
): number | undefined {
  const hit = sizeCache.get(dir);
  if ((!hit || now - hit.at > SIZE_TTL_MS) && !sizeInFlight.has(dir)) {
    sizeInFlight.add(dir);
    void sizer(dir)
      .catch(() => null)
      .then((bytes) => sizeCache.set(dir, { at: Date.now(), bytes }))
      .finally(() => sizeInFlight.delete(dir));
  }
  return hit?.bytes ?? undefined;
}

/** Test seam: forget cached sizes. */
export function resetDirSizeCacheForTests(): void {
  sizeCache.clear();
  sizeInFlight.clear();
}
