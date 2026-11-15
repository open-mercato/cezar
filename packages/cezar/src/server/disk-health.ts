// The `disk` field of `GET /api/v1/health` (telemetry 9cdcedc3). One `statfs` per snapshot; the
// worktrees size is a cached background `du`, asked for only once the disk is short.
import { join } from 'node:path';
import { cachedDirSize, diskLevel, probeDiskSpace, type DiskLevel, type DiskSpace } from '../disk-space.ts';
import { WORKTREES_DIR, worktreeSizeBytes } from '../git-worktree.ts';

const MIB = 1024 ** 2;

/** Health publishes only on change, and free space moves on every write: report it in steps
 *  (1 GiB while fine, 100 MiB once short) so a busy disk does not republish every tick. */
function quantize(bytes: number, step: number): number {
  return Math.floor(bytes / step) * step;
}

interface DiskHealth {
  disk?: { freeBytes: number; totalBytes: number; level: DiskLevel; worktreesBytes?: number };
}

export function diskHealth(
  repoRoot: string,
  probe: (path: string) => DiskSpace | undefined = probeDiskSpace,
  sizer: (path: string) => Promise<number | null> = worktreeSizeBytes,
): DiskHealth {
  const worktrees = join(repoRoot, WORKTREES_DIR);
  const space = probe(worktrees);
  if (!space) return {};
  const level = diskLevel(space);
  const freeBytes = quantize(space.freeBytes, level === 'ok' ? 1024 * MIB : 100 * MIB);
  // Spread, never `worktreesBytes: undefined` — the contract says optional (contract-parity).
  const worktreesBytes = level === 'ok' ? undefined : cachedDirSize(worktrees, sizer);
  return {
    // Whole GiB: health is CORS-open (#431), and an exact volume size is a stable cross-origin fingerprint.
    disk: { freeBytes, totalBytes: quantize(space.totalBytes, 1024 * MIB), level, ...(worktreesBytes !== undefined ? { worktreesBytes } : {}) },
  };
}
