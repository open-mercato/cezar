// Count-based worktree retention (#483). A busy cockpit leaves one full repo
// checkout per finished task under `.ai/cezar/worktrees/<runId>`; nothing bounds
// the total, so disk saturates. This module decides *which* finished worktrees
// to reclaim (directory only — the `cez/<id8>` branch is kept, so the work stays
// recoverable) and the thin I/O enforcer that performs the reclaim. The selector
// is pure and unit-testable; the enforcer never throws (helper discipline).
import { existsSync } from 'node:fs';
import { branchFor, createWorktree, localBranchExists, removeWorktree, worktreeHasUnpreservedWork } from '../git-worktree.ts';
import { prunePrHeadRefs } from '../automations/pr-head.ts';
import { holderOf, worktreeHolders, type WorktreeHolder } from '../worktree-in-use.ts';
import type { RunRecord, RunStatus } from './store.ts';
import { DEFAULT_WORKTREE_RETENTION, resolveWorktreeIdleDays, resolveWorktreeRetention } from '../config.ts';

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
 *  directory, has not already been reclaimed, and is not pinned — a pin is the user
 *  saying "keep this one", so it neither leaves nor counts toward `keep`. */
export function isReclaimable(run: RunRecord): boolean {
  return FINISHED.has(run.status) && !!run.worktreePath && !run.worktreeReclaimedAt && !run.pinned;
}

/**
 * Given every run and the keep-count `keep`, return the ids of the finished
 * worktrees whose *directory* should be reclaimed: keep the `keep`
 * most-recently-finished reclaimable worktrees, reclaim the rest.
 *
 * `keep === 0` means "unlimited — never auto-reclaim" and returns `[]`. Ids in `inUse` (a running
 * cezar or node process uses that worktree) are never selected and do not count toward `keep`.
 * Pure: no I/O, no mutation of the input.
 */
export function selectReclaimableWorktrees(runs: readonly RunRecord[], keep: number, inUse: ReadonlySet<string> = new Set()): string[] {
  if (!Number.isFinite(keep) || keep <= 0) return [];
  const reclaimable = runs
    .filter((run) => isReclaimable(run) && !inUse.has(run.id))
    .sort((a, b) => (recencyKey(a) < recencyKey(b) ? 1 : recencyKey(a) > recencyKey(b) ? -1 : 0));
  return reclaimable.slice(keep).map((r) => r.id);
}

/** The slice of the runs store the enforcer needs. Kept structural so the
 *  enforcer stays easy to test and never imports the concrete store. */
export interface RetentionStore {
  listRuns(): RunRecord[];
  updateRun(id: string, patch: { worktreeReclaimedAt?: string }): unknown;
  /** The run's event-log mtime (ms) — its truest "last activity". Optional for test fakes. */
  eventsMtimeMs?(id: string): number | undefined;
}

/** The slice of the store the re-materializer needs. */
export interface RematerializeStore {
  getRun(id: string): RunRecord | undefined;
  updateRun(id: string, patch: { worktreeReclaimedAt?: string }): unknown;
}

/**
 * A resume and a reclaim pass race on one directory (27d2e432): the pass snapshots the runs, then
 * spends seconds per `git worktree remove`, so a run Continued meanwhile was spawned in a tree the
 * pass then deleted. A resume claims its run before reading it, and awaits a reclaim already in
 * flight; the pass re-reads each run right before removing it and skips a claimed one. The claim
 * only has to outlive the resume's switch to `running`, after which the run is not reclaimable.
 */
const RESUME_CLAIM_MS = 10 * 60_000;
const resumeClaims = new Map<string, number>();
const reclaimsInFlight = new Map<string, Promise<unknown>>();

function claimedForResume(runId: string, now = Date.now()): boolean {
  const at = resumeClaims.get(runId);
  if (at === undefined) return false;
  if (now - at < RESUME_CLAIM_MS) return true;
  resumeClaims.delete(runId);
  return false;
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
  resumeClaims.set(runId, Date.now());
  await reclaimsInFlight.get(runId)?.catch(() => undefined);
  const run = store.getRun(runId);
  if (!run?.worktreePath || existsSync(run.worktreePath)) return false;
  try {
    // A directory removed outside cezar comes back the same way, but only onto its own surviving
    // branch: a fresh tree off the base would silently stand in for the task's work (27d2e432).
    if (!run.worktreeReclaimedAt && !await localBranchExists(repoRoot, run.branch ?? branchFor(runId))) return false;
    await createWorktree(repoRoot, runId, run.baseBranch ?? 'HEAD', { branch: run.branch });
    store.updateRun(runId, { worktreeReclaimedAt: undefined });
    return true;
  } catch {
    return false;
  }
}

/**
 * Restore a reclaimed tree for publishing (the PR path), only onto its surviving branch: a branch
 * deleted since (merged and cleaned up) must not come back as a fresh tree off the base.
 */
export async function restoreReclaimedForPublish(repoRoot: string, store: RematerializeStore, runId: string): Promise<boolean> {
  const run = store.getRun(runId);
  if (!run?.worktreeReclaimedAt || !await localBranchExists(repoRoot, run.branch ?? branchFor(runId))) return false;
  return rematerializeReclaimedWorktree(repoRoot, store, runId);
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
  lifecycle?: { requiresGate(runId: string): Promise<boolean>; reclaim(runId: string): Promise<boolean> };
  /** Directory reclaimer — defaults to the real `removeWorktree` (branch kept).
   *  Injectable so tests can exercise the "removal failed" branch without brittle
   *  filesystem-permission tricks. */
  remove?: (repoRoot: string, worktreePath: string) => Promise<void>;
  /** Does this tree hold uncommitted content? Defaults to a real `git status`; injectable for tests. */
  hasUnpreservedWork?: (path: string) => Promise<boolean>;
  /** What runs from which path — defaults to the live probe (`worktree-in-use.ts`). */
  holders?: () => Promise<readonly WorktreeHolder[]>;
}

/** The finished worktrees a running process uses right now, run id → reason. Only probes when
 *  there is something over the limit to protect — retention runs after every terminal transition. */
export async function worktreesInUse(
  runs: readonly RunRecord[],
  holders: () => Promise<readonly WorktreeHolder[]> = () => worktreeHolders(),
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const candidates = runs.filter((run) => run.worktreePath && existsSync(run.worktreePath));
  if (candidates.length === 0) return out;
  const all = await holders().catch(() => [] as WorktreeHolder[]);
  for (const run of candidates) {
    const holder = holderOf(run.worktreePath!, all);
    if (holder) out.set(run.id, holder.reason);
  }
  return out;
}

export async function reclaimWorktrees(
  repoRoot: string,
  store: RetentionStore,
  keep: number,
  opts: ReclaimOptions = {},
): Promise<string[]> {
  const runs = store.listRuns();
  const over = Number.isFinite(keep) && keep > 0 && runs.filter(isReclaimable).length > keep;
  const inUse = over ? await worktreesInUse(runs.filter(isReclaimable), opts.holders) : new Map<string, string>();
  const reclaimed = await reclaimRunWorktrees(repoRoot, store, selectReclaimableWorktrees(runs, keep, new Set(inUse.keys())), isReclaimable, opts);
  await sweepPrHeadRefs(repoRoot, store);
  return reclaimed;
}

/** Runs whose worktree age retention and the disk guard may reclaim: every settled status,
 *  `review` and `waiting` included — Continue restores the tree from the kept branch. */
const IDLE_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['review', 'waiting', 'done', 'failed', 'cancelled']);

/**
 * When this run last did anything: the latest of its record timestamps and, when given, its event
 * log's mtime (every turn, note and status change appends there). ISO string, or undefined.
 */
export function lastActivityAt(run: RunRecord, eventsMtimeMs?: number): string {
  const stamps = [run.createdAt, run.startedAt, run.finishedAt, run.idleClosedAt, run.archivedAt]
    .filter((s): s is string => typeof s === 'string' && Number.isFinite(Date.parse(s)))
    .map((s) => Date.parse(s));
  if (eventsMtimeMs !== undefined && Number.isFinite(eventsMtimeMs)) stamps.push(eventsMtimeMs);
  return new Date(stamps.length ? Math.max(...stamps) : Date.parse(run.createdAt) || 0).toISOString();
}

/**
 * Not active, has a materialized tree, not already reclaimed, not pinned, and nothing scheduled
 * to wake it (a usage-limit resume or a monitoring wake would land in a tree this pass removed).
 * Liveness (`isLive`: a queued/starting/live session in the manager) is checked by the caller.
 */
export function isIdleReclaimable(run: RunRecord): boolean {
  return IDLE_STATUSES.has(run.status) && !!run.worktreePath && !run.worktreeReclaimedAt && !run.pinned
    && !run.autoResumeAt && !run.monitoringWakeAt;
}

/**
 * Age retention: ids of idle-reclaimable runs whose last activity is more than `days` old, oldest
 * first. `days <= 0` = off. `activity` maps a run to its last-activity ISO stamp. Pure.
 */
export function selectIdleWorktrees(
  runs: readonly RunRecord[],
  days: number,
  now: number,
  activity: (run: RunRecord) => string = (run) => lastActivityAt(run),
  excluded: ReadonlySet<string> = new Set(),
): string[] {
  if (!Number.isFinite(days) || days <= 0) return [];
  const cutoff = now - days * 86_400_000;
  return runs
    .filter((run) => isIdleReclaimable(run) && !excluded.has(run.id))
    .map((run) => ({ id: run.id, at: Date.parse(activity(run)) }))
    .filter((r) => r.at < cutoff)
    .sort((a, b) => a.at - b.at)
    .map((r) => r.id);
}

/** Extra inputs for passes that may touch `review`/`waiting` runs. */
export interface IdleReclaimOptions extends ReclaimOptions {
  /** True while the manager owns the run (queued, starting, live or parked session). Required:
   *  a parked `waiting` session still runs from its tree. */
  isLive: (runId: string) => boolean;
  /** Last-activity stamp per run — the store's event-log mtime when available. */
  activity?: (run: RunRecord) => string;
  /** Wall clock — injectable for tests. */
  nowMs?: () => number;
}

/**
 * Age retention: reclaim the tree of every non-active run idle for more than `days` (0 = off).
 * Same reclaim as the count pass — branch kept, `worktreeReclaimedAt` stamped, restorable on
 * Continue. Never throws.
 */
export async function reclaimIdleWorktrees(
  repoRoot: string,
  store: RetentionStore,
  days: number,
  opts: IdleReclaimOptions,
): Promise<string[]> {
  if (!Number.isFinite(days) || days <= 0) return [];
  const runs = store.listRuns().filter((run) => isIdleReclaimable(run) && !opts.isLive(run.id));
  const ids = selectIdleWorktrees(runs, days, (opts.nowMs ?? Date.now)(), opts.activity);
  return reclaimSelectedWorktrees(repoRoot, store, ids, opts);
}

/**
 * Reclaim these runs' trees when each is still idle-reclaimable, not live and not used by a
 * running process — archive, the disk guard and `cez worktrees` go through here. Branch kept,
 * restorable on Continue. Never throws; returns the ids actually reclaimed.
 */
export async function reclaimSelectedWorktrees(
  repoRoot: string,
  store: RetentionStore,
  ids: readonly string[],
  opts: IdleReclaimOptions,
): Promise<string[]> {
  if (ids.length === 0) return [];
  try {
    const wanted = new Set(ids);
    const inUse = await worktreesInUse(store.listRuns().filter((run) => wanted.has(run.id)), opts.holders);
    const reclaimed = await reclaimRunWorktrees(
      repoRoot, store, ids.filter((id) => !inUse.has(id)),
      (run) => isIdleReclaimable(run) && !opts.isLive(run.id), opts,
    );
    if (reclaimed.length > 0) await sweepPrHeadRefs(repoRoot, store);
    return reclaimed;
  } catch {
    return [];
  }
}

/**
 * Reclaim the trees of exactly these runs (archive, the disk guard, the CLI) — each re-checked
 * against `eligible` right before removal. Branch kept; never throws.
 */
export async function reclaimRunWorktrees(
  repoRoot: string,
  store: RetentionStore,
  ids: readonly string[],
  eligible: (run: RunRecord) => boolean,
  opts: ReclaimOptions = {},
): Promise<string[]> {
  const now = opts.now ?? (() => new Date().toISOString());
  const remove = opts.remove ?? ((root, path) => removeWorktree(root, path)); // branch kept
  const reclaimed: string[] = [];
  for (const id of ids) {
    // A snapshot taken by the caller is seconds old by now; a run Continued since must keep its tree.
    const run = store.listRuns().find((candidate) => candidate.id === id);
    if (!run?.worktreePath || run.worktreeReclaimedAt || !eligible(run) || claimedForResume(id)) continue;
    // Another pass (guard, sweep, archive, CLI) is already reclaiming this tree.
    if (reclaimsInFlight.has(id)) continue;
    let settle!: () => void;
    reclaimsInFlight.set(id, new Promise<void>((resolve) => { settle = resolve; }));
    try {
      // Retention keeps the branch, which restores only committed work. A tree the final autosave
      // refused or failed to commit (or whose state git cannot read) stays on disk (#2215).
      if (await (opts.hasUnpreservedWork ?? worktreeHasUnpreservedWork)(run.worktreePath)) continue;
      if (opts.lifecycle && await opts.lifecycle.requiresGate(id)) {
        await opts.lifecycle.reclaim(id);
        continue;
      }
      await remove(repoRoot, run.worktreePath);
      if (existsSync(run.worktreePath)) continue; // reclaim failed; retry next pass
      store.updateRun(id, { worktreeReclaimedAt: now() });
      reclaimed.push(id);
    } catch {
      // best-effort: never let retention crash a terminal transition or startup.
    } finally {
      reclaimsInFlight.delete(id);
      settle();
    }
  }
  return reclaimed;
}

async function sweepPrHeadRefs(repoRoot: string, store: RetentionStore): Promise<void> {
  // A reclaimed pull-request head run no longer needs its `refs/cezar/pr/<n>` (spec
  // 2026-10-06-agentic-e2e-checks Phase 3). Swept here because this runs at startup (after the
  // orphan prune) and after every terminal transition — the paths a worktree disappears by.
  // Unconditional (one `for-each-ref`): a ref whose every run was deleted is found here too.
  const needed = new Set<number>();
  for (const run of store.listRuns()) {
    if (run.prHead && run.worktreePath && !run.worktreeReclaimedAt && existsSync(run.worktreePath)) {
      needed.add(run.prHead.number);
    }
  }
  await prunePrHeadRefs(repoRoot, needed).catch(() => undefined);
}

/** A store's last-activity function: record stamps plus the event-log mtime when it has one. */
export function storeActivity(store: RetentionStore): (run: RunRecord) => string {
  return (run) => lastActivityAt(run, store.eventsMtimeMs?.(run.id));
}

/**
 * Every retention pass this repo is configured for — count (#483) then age — through the same
 * resolvers Settings writes. Called at boot, after terminal transitions, hourly, and by "Reclaim
 * now". Never throws; returns every run id reclaimed.
 */
export async function enforceWorktreeRetention(
  repoRoot: string,
  store: RetentionStore,
  opts: ReclaimOptions & { isLive: (runId: string) => boolean },
): Promise<string[]> {
  const keep = await resolveWorktreeRetention(repoRoot).catch(() => DEFAULT_WORKTREE_RETENTION);
  const byCount = await reclaimWorktrees(repoRoot, store, keep, opts).catch(() => [] as string[]);
  const days = await resolveWorktreeIdleDays(repoRoot).catch(() => 0);
  const byAge = await reclaimIdleWorktrees(repoRoot, store, days, { activity: storeActivity(store), ...opts });
  // An archived task's tree goes whatever its age (archive frees disk); this retries one that was
  // still in use when it was archived.
  const archived = store.listRuns().filter((run) => run.archived && isIdleReclaimable(run) && !opts.isLive(run.id));
  const byArchive = await reclaimSelectedWorktrees(repoRoot, store, archived.map((run) => run.id), opts);
  return [...byCount, ...byAge, ...byArchive];
}

/** What a manual reclaim (`POST /worktrees/reclaim`, `cez worktrees reclaim`) asks for. */
export interface ManualReclaimRequest {
  olderThanDays?: number;
  allInactive?: boolean;
  runIds?: readonly string[];
}

/**
 * The runs a manual reclaim targets, oldest activity first — or `null` for an empty request, which
 * means "the configured retention". Only idle-reclaimable, non-live runs qualify: an explicit
 * `runIds` entry that is active is left out (the caller reports it). Pure.
 */
export function selectManualReclaim(
  runs: readonly RunRecord[],
  request: ManualReclaimRequest,
  isLive: (runId: string) => boolean,
  activity: (run: RunRecord) => string = (run) => lastActivityAt(run),
  now = Date.now(),
): string[] | null {
  const eligible = runs.filter((run) => isIdleReclaimable(run) && !isLive(run.id));
  if (request.runIds) {
    const wanted = new Set(request.runIds);
    return eligible.filter((run) => wanted.has(run.id)).map((run) => run.id);
  }
  if (request.allInactive) return selectIdleWorktrees(eligible, Number.MIN_VALUE, Number.POSITIVE_INFINITY, activity);
  if (request.olderThanDays !== undefined) {
    // 0 days = everything idle at all; selectIdleWorktrees treats <= 0 as "off", so go via allInactive.
    if (request.olderThanDays <= 0) return selectIdleWorktrees(eligible, Number.MIN_VALUE, Number.POSITIVE_INFINITY, activity);
    return selectIdleWorktrees(eligible, request.olderThanDays, now, activity);
  }
  return null;
}

/** What the configured retention (count + age) would reclaim now — a dry run of
 *  `enforceWorktreeRetention`, before the in-use and unpreserved-work checks. */
export async function configuredReclaimCandidates(
  repoRoot: string,
  store: RetentionStore,
  isLive: (runId: string) => boolean,
  now = Date.now(),
): Promise<string[]> {
  const runs = store.listRuns();
  const keep = await resolveWorktreeRetention(repoRoot).catch(() => DEFAULT_WORKTREE_RETENTION);
  const days = await resolveWorktreeIdleDays(repoRoot).catch(() => 0);
  const byCount = selectReclaimableWorktrees(runs, keep);
  const byAge = selectIdleWorktrees(runs.filter((run) => !isLive(run.id)), days, now, storeActivity(store));
  return [...new Set([...byCount, ...byAge])];
}
