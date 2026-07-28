// Count-based worktree retention (#483). A busy cockpit leaves one full repo
// checkout per finished task under `.ai/cezar/worktrees/<runId>`; nothing bounds
// the total, so disk saturates. This module decides *which* finished worktrees
// to reclaim (directory only — the `cez/<id8>` branch is kept, so the work stays
// recoverable) and the thin I/O enforcer that performs the reclaim. The selector
// is pure and unit-testable; the enforcer never throws (helper discipline).
import { existsSync } from 'node:fs';
import { createWorktree, removeWorktree } from '../git-worktree.js';
import type { RunRecord, RunStatus } from './store.js';

/** The "finished" status set — mirrors `RunStore.archiveFinished`. A run at the
 *  `review` gate is deliberately excluded: it still needs its worktree to render
 *  the diff and open a draft PR, so reclaiming it would break the gate. */
const FINISHED: ReadonlySet<RunStatus> = new Set<RunStatus>(['done', 'failed', 'cancelled']);

/** Recency key for retention ordering: when a run finished, falling back to when
 *  it was created (a finished run should always have `finishedAt`, but old
 *  records may not). Lexicographic compare is correct for ISO-8601 timestamps. */
function recencyKey(run: RunRecord): string {
  return run.finishedAt ?? run.createdAt;
}

/** A run is reclaimable when it is finished, still has a materialized worktree
 *  directory, and has not already been reclaimed. */
export function isReclaimable(run: RunRecord): boolean {
  return FINISHED.has(run.status) && !!run.worktreePath && !run.worktreeReclaimedAt;
}

/**
 * Given every run and the keep-count `keep`, return the ids of the finished
 * worktrees whose *directory* should be reclaimed: keep the `keep`
 * most-recently-finished reclaimable worktrees, reclaim the rest.
 *
 * `keep === 0` means "unlimited — never auto-reclaim" and returns `[]`.
 * Pure: no I/O, no mutation of the input.
 */
export function selectReclaimableWorktrees(runs: readonly RunRecord[], keep: number): string[] {
  if (!Number.isFinite(keep) || keep <= 0) return [];
  const reclaimable = runs
    .filter(isReclaimable)
    .sort((a, b) => (recencyKey(a) < recencyKey(b) ? 1 : recencyKey(a) > recencyKey(b) ? -1 : 0));
  return reclaimable.slice(keep).map((r) => r.id);
}

/** The slice of the runs store the enforcer needs. Kept structural so the
 *  enforcer stays easy to test and never imports the concrete store. */
export interface RetentionStore {
  listRuns(): RunRecord[];
  updateRun(id: string, patch: { worktreeReclaimedAt?: string }): unknown;
}

/** The slice of the store the re-materializer needs. */
export interface RematerializeStore {
  getRun(id: string): RunRecord | undefined;
  updateRun(id: string, patch: { worktreeReclaimedAt?: string }): unknown;
}

/**
 * If retention (#483) reclaimed this run's worktree — branch kept, directory
 * gone, `worktreeReclaimedAt` stamped — re-materialize the directory (via the
 * idempotent `createWorktree`, which reattaches the surviving `cez/<id8>`
 * branch) and CLEAR the stamp. Called on the resume/continue path so a resumed
 * run regains its isolated tree and becomes eligible for retention again;
 * without it the run would keep a directory on disk while staying invisible to
 * the enforcer forever (a leak). Returns true when it re-materialized.
 * Best-effort: never throws (the caller falls back to the repo root).
 */
export async function rematerializeReclaimedWorktree(
  repoRoot: string,
  store: RematerializeStore,
  runId: string,
): Promise<boolean> {
  const run = store.getRun(runId);
  if (!run?.worktreePath || !run.worktreeReclaimedAt || existsSync(run.worktreePath)) return false;
  try {
    await createWorktree(repoRoot, runId, run.baseBranch ?? 'HEAD');
    store.updateRun(runId, { worktreeReclaimedAt: undefined });
    return true;
  } catch {
    return false;
  }
}

/**
 * Enforce the retention budget: reclaim the *directory* of every over-limit
 * finished worktree (branch kept via `removeWorktree` without the branch arg),
 * stamping `worktreeReclaimedAt` on each run actually reclaimed. Returns the
 * reclaimed run ids (for logging/SSE).
 *
 * Never throws (helper discipline). `removeWorktree` is best-effort and does not
 * report failure, so a run is stamped only once its directory is confirmed gone
 * — a locked/permission failure leaves the stamp unset so the next pass retries.
 * Idempotent under races: `removeWorktree` is `--force` + `prune` and a repeated
 * stamp is harmless.
 */
export interface ReclaimOptions {
  /** Timestamp source for the stamp — injectable for deterministic tests. */
  now?: () => string;
  /** Directory reclaimer — defaults to the real `removeWorktree` (branch kept).
   *  Injectable so tests can exercise the "removal failed" branch without brittle
   *  filesystem-permission tricks. */
  remove?: (repoRoot: string, worktreePath: string) => Promise<void>;
}

export async function reclaimWorktrees(
  repoRoot: string,
  store: RetentionStore,
  keep: number,
  opts: ReclaimOptions = {},
): Promise<string[]> {
  const now = opts.now ?? (() => new Date().toISOString());
  const remove = opts.remove ?? ((root, path) => removeWorktree(root, path)); // branch kept
  const runs = store.listRuns();
  const byId = new Map(runs.map((r) => [r.id, r]));
  const reclaimed: string[] = [];
  for (const id of selectReclaimableWorktrees(runs, keep)) {
    const run = byId.get(id);
    if (!run?.worktreePath) continue;
    try {
      await remove(repoRoot, run.worktreePath);
      if (existsSync(run.worktreePath)) continue; // reclaim failed; retry next pass
      store.updateRun(id, { worktreeReclaimedAt: now() });
      reclaimed.push(id);
    } catch {
      // best-effort: never let retention crash a terminal transition or startup.
    }
  }
  return reclaimed;
}
