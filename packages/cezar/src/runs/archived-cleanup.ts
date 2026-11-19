// Archived tasks are deleted after N days (spec 2026-11-19-worktree-disk-usage, decision 5): the
// record, every per-task file (`RunStore.deleteRun`), the worktree and the `cez/<id8>` branch —
// unless the branch still carries work that exists nowhere else, or has an open pull request: then
// the branch stays and only the task goes. The 500-archived cap (`store.ts`) stays as the backstop.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { ghEnv } from '../core/gh-env.ts';
import { localBranchExists, removeWorktree, worktreeHasUnpreservedWork } from '../git-worktree.ts';
import { isSafeGitRef } from '../git-refs.ts';
import { resolveArchivedTaskDeleteDays } from '../config.ts';
import { lastActivityAt } from './retention.ts';
import type { RunRecord } from './store.ts';

const exec = promisify(execFile);

/** When the archived clock started: the archive stamp, else (records from before it was kept)
 *  when the task finished, else its last activity. */
export function archivedSince(run: RunRecord, activity: (run: RunRecord) => string = (r) => lastActivityAt(r)): number {
  for (const stamp of [run.archivedAt, run.finishedAt]) {
    const at = stamp ? Date.parse(stamp) : NaN;
    if (Number.isFinite(at)) return at;
  }
  return Date.parse(activity(run));
}

/** Archived, not live, not pinned, archived for more than `days` (0 = never). Oldest first. Pure. */
export function selectExpiredArchived(
  runs: readonly RunRecord[],
  days: number,
  isLive: (runId: string) => boolean,
  now = Date.now(),
  activity?: (run: RunRecord) => string,
): string[] {
  if (!Number.isFinite(days) || days <= 0) return [];
  const cutoff = now - days * 86_400_000;
  return runs
    .filter((run) => run.archived === true && !run.pinned && run.status !== 'running' && run.status !== 'queued' && !isLive(run.id))
    .map((run) => ({ id: run.id, at: archivedSince(run, activity) }))
    .filter((r) => r.at < cutoff)
    .sort((a, b) => a.at - b.at)
    .map((r) => r.id);
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    return (await exec('git', args, { cwd, maxBuffer: 1024 * 1024 })).stdout.trim();
  } catch {
    return null;
  }
}

/** The repository's default branch as a local ref: `origin/HEAD`'s target, else `main`/`master`. */
async function defaultBranch(repoRoot: string): Promise<string | null> {
  const head = await git(repoRoot, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const candidates = [head?.replace(/^[^/]+\//, ''), 'main', 'master'].filter((b): b is string => !!b);
  for (const name of candidates) if (await localBranchExists(repoRoot, name)) return name;
  return null;
}

/**
 * Commits on `branch` that are neither merged into the default branch nor on any remote. `null`
 * when git cannot say — the caller keeps the branch.
 */
export async function unpreservedCommits(repoRoot: string, branch: string): Promise<number | null> {
  if (!isSafeGitRef(branch)) return null;
  const base = await defaultBranch(repoRoot);
  const count = await git(repoRoot, ['rev-list', '--count', branch, '--not', '--remotes', ...(base ? [base] : [])]);
  const n = count === null ? NaN : Number(count);
  return Number.isFinite(n) ? n : null;
}

/** Does `branch` have an open pull request? `null` when `gh` cannot answer. */
export async function hasOpenPr(repoRoot: string, branch: string): Promise<boolean | null> {
  if (process.env.CEZ_DRY_RUN === '1' || !isSafeGitRef(branch)) return null;
  try {
    const { stdout } = await exec('gh', ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number', '--limit', '1'], {
      cwd: repoRoot, env: ghEnv(), timeout: 20_000,
    });
    const parsed: unknown = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed.length > 0 : null;
  } catch {
    return null;
  }
}

export interface ArchivedCleanupOptions {
  isLive: (runId: string) => boolean;
  dryRun?: boolean;
  now?: number;
  activity?: (run: RunRecord) => string;
  /** Worktree lifecycle (#gated removal): a gated tree is left for its own flow, the task kept. */
  lifecycle?: { requiresGate(runId: string): Promise<boolean> };
  /** Test seams. */
  openPr?: (repoRoot: string, branch: string) => Promise<boolean | null>;
  unpreserved?: (repoRoot: string, branch: string) => Promise<number | null>;
  hasUnpreservedWork?: (path: string) => Promise<boolean>;
  onDeleted?: (run: RunRecord) => void;
}

export interface ArchivedCleanupStore {
  listRuns(): RunRecord[];
  getRun(id: string): RunRecord | undefined;
  deleteRun(id: string): boolean;
}

export interface ArchivedCleanupResult {
  /** Tasks deleted (or, on a dry run, that would be). */
  deleted: string[];
  /** Of those, the ones whose branch was kept, and why. */
  keptBranches: Array<{ runId: string; branch: string; reason: string }>;
  /** Tasks left in place this pass, and why. */
  skipped: Array<{ runId: string; reason: string }>;
}

/** Why `run`'s branch must outlive it, or `null` when it may go. */
async function branchKeepReason(repoRoot: string, run: RunRecord, opts: ArchivedCleanupOptions): Promise<string | null> {
  const branch = run.branch;
  if (!branch || !await localBranchExists(repoRoot, branch)) return null;
  const open = await (opts.openPr ?? hasOpenPr)(repoRoot, branch);
  if (open === true) return 'open pull request';
  // `gh` could not answer for a task that opened one: assume it may still be open.
  if (open === null && run.pullRequestUrl) return 'pull request state unknown';
  const commits = await (opts.unpreserved ?? unpreservedCommits)(repoRoot, branch);
  if (commits === null) return 'could not check its commits';
  if (commits > 0) return `${commits} commit(s) neither merged nor pushed`;
  return null;
}

/**
 * Delete every archived task older than `days`. Never throws; never touches a live, unarchived
 * or pinned task; a tree holding uncommitted work keeps its task for the user to look at.
 */
export async function deleteExpiredArchivedTasks(
  repoRoot: string,
  store: ArchivedCleanupStore,
  days: number,
  opts: ArchivedCleanupOptions,
): Promise<ArchivedCleanupResult> {
  const result: ArchivedCleanupResult = { deleted: [], keptBranches: [], skipped: [] };
  const ids = selectExpiredArchived(store.listRuns(), days, opts.isLive, opts.now, opts.activity);
  for (const id of ids) {
    try {
      // Re-read: an unarchive or a Continue since the selection wins.
      const run = store.getRun(id);
      if (!run?.archived || opts.isLive(id) || run.status === 'running' || run.status === 'queued') continue;
      const tree = run.worktreePath && existsSync(run.worktreePath) ? run.worktreePath : undefined;
      if (tree && await (opts.hasUnpreservedWork ?? worktreeHasUnpreservedWork)(tree)) {
        result.skipped.push({ runId: id, reason: 'worktree has uncommitted changes' });
        continue;
      }
      if (tree && opts.lifecycle && await opts.lifecycle.requiresGate(id)) {
        result.skipped.push({ runId: id, reason: 'worktree removal runs lifecycle scripts' });
        continue;
      }
      const keep = await branchKeepReason(repoRoot, run, opts);
      if (keep && run.branch) result.keptBranches.push({ runId: id, branch: run.branch, reason: keep });
      result.deleted.push(id);
      if (opts.dryRun) continue;
      const branch = keep ? undefined : run.branch;
      if (tree) await removeWorktree(repoRoot, tree, branch);
      else if (branch && await localBranchExists(repoRoot, branch)) await git(repoRoot, ['branch', '-D', branch]);
      if (tree && existsSync(tree)) {
        // In use by a process: the task stays until the next pass.
        result.deleted.pop();
        if (keep) result.keptBranches.pop();
        result.skipped.push({ runId: id, reason: 'worktree in use' });
        continue;
      }
      store.deleteRun(id);
      opts.onDeleted?.(run);
    } catch {
      // best effort: the next pass retries
    }
  }
  return result;
}

/**
 * The configured pass — at boot and with the retention sweeps (hourly). Logs one summary line
 * when it deleted anything. Never throws.
 */
export async function enforceArchivedTaskRetention(
  repoRoot: string,
  store: ArchivedCleanupStore & { eventsMtimeMs?(id: string): number | undefined },
  opts: Omit<ArchivedCleanupOptions, 'dryRun'>,
  log: (line: string) => void = (line) => console.log(line),
): Promise<ArchivedCleanupResult> {
  const days = await resolveArchivedTaskDeleteDays(repoRoot).catch(() => 0);
  const result = await deleteExpiredArchivedTasks(repoRoot, store, days, { activity: (run) => lastActivityAt(run, store.eventsMtimeMs?.(run.id)), ...opts })
    .catch(() => ({ deleted: [], keptBranches: [], skipped: [] }) as ArchivedCleanupResult);
  if (result.deleted.length > 0) {
    const kept = result.keptBranches.length > 0 ? `, ${result.keptBranches.length} branch(es) kept (unmerged work or open PR)` : '';
    log(`  deleted ${result.deleted.length} task(s) archived over ${days} days${kept}`);
  }
  return result;
}
