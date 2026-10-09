import { DEFAULT_WORKTREE_RETENTION, resolveWorktreeRetention } from '../config.ts';
import { pruneOrphans } from '../git-worktree.ts';
import { reclaimWorktrees } from './retention.ts';
import type { RunStore } from './store.ts';

/**
 * Boot-time worktree sweep for one project: orphan pruning (spec 006) and count-based
 * retention (#483). Best-effort, never throws. It may run while the cockpit already serves, so
 * a run created mid-sweep must count as live: this process's runs are read from the store per
 * entry, and the persisted index is consulted for runs another cockpit owns. Memory alone is not
 * enough — a second cockpit's live run has no record in this process's map, and pruning its
 * worktree would delete a running task's tree and its `cez/<id8>` branch.
 */
export async function sweepStartupWorktrees(
  repoRoot: string,
  store: RunStore,
): Promise<{ orphans: string[]; reclaimed: string[] }> {
  let persisted: ReadonlySet<string>;
  try {
    persisted = new Set(store.listPersistedRuns().map((run) => run.id));
  } catch {
    // Unreadable index: fall back to in-memory membership rather than risk deleting live work.
    persisted = new Set(store.listRuns().map((run) => run.id));
  }
  const orphans = await pruneOrphans(repoRoot, {
    has: (id) => store.getRun(id) !== undefined || persisted.has(id),
  }).catch(
    () => [] as string[],
  );
  // Reclaims finished worktrees beyond the keep-limit (directory only — `cez/<id8>` branch kept,
  // so recoverable).
  const keep = await resolveWorktreeRetention(repoRoot).catch(() => DEFAULT_WORKTREE_RETENTION);
  const reclaimed = await reclaimWorktrees(repoRoot, store, keep).catch(() => [] as string[]);
  return { orphans, reclaimed };
}
