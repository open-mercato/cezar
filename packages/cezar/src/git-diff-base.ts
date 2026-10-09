/**
 * "Which ref anchors *this task's* diff" — the single rule every task-diff
 * surface resolves through (#751).
 *
 * The normal answer is `merge-base(baseBranch, HEAD)`: it keeps a task's diff
 * to the task's own commits even after the base branch moves on, and even
 * after the task merges the base back in.
 *
 * Two things break that answer, and both are fixed here:
 *
 * **A stale local base ref.** `RunRecord.baseBranch` is a NAME (`main`),
 * resolved to a ref once, when the worktree was created. Nothing ever
 * fast-forwards the user's local `main` — cezar's agents only ever `git fetch`,
 * which moves `origin/main` — so on a repo the user does not pull, the local
 * ref drifts arbitrarily far behind. The merge-base then collapses onto that
 * stale tip and every upstream commit the task forked from or merged in counts
 * as the task's own work: an eight-line fix measured `+59514 −12160` against a
 * `main` that was 98 commits and one monorepo restructure behind origin. So the
 * base is re-resolved to the freshest ref it names at every call
 * (`freshestBaseRef`) — the read-time twin of `resolveBaseRef`, which does the
 * same thing at worktree-creation time and cannot know what happens later.
 *
 * **A repointed HEAD.** cezar hands the agent a worktree on the task's own
 * branch, but nothing stops the agent from checking out another branch in it —
 * every `review/pr-NNN` and QA run does exactly that, and so does every skill
 * that opens its work on a named `feat/…` branch. The merge-base then silently
 * redefines "this task's diff" as *the whole checked-out branch*, which is how
 * a task that committed nothing came to report `+22505 −2628`. #591 and #751
 * answered that with `HEAD` — uncommitted work only — which is right for a
 * pure review and badly wrong for the far more common case of an agent that
 * committed real work on a branch it created itself: those runs reported
 * `+0 −0` for changes that were genuinely theirs.
 *
 * The honest anchor for a repointed HEAD is the branch as it stood **when this
 * run first saw it** — its `<branch>@{<run start>}` reflog state. Diffing
 * against that attributes exactly what the run did to the tree and nothing
 * that was already there: a review run gets its `+0`, and a run that branched
 * off the base and committed gets its real numbers. Where that baseline is
 * itself stale — the run merged the base branch in afterwards, dragging the
 * whole upstream delta behind it — the ordinary merge-base is the tighter
 * answer, so the two candidates compete and the one that attributes FEWER
 * CHANGED LINES to the task wins. The reported number is then never more than
 * the least either measure can defend.
 *
 * It lives here so a third surface cannot get it wrong again — callers hand in
 * their own `git` runner (`git-worktree.ts` and `server/git-changes.ts` each
 * own a private one, and `git-changes` needs its scratch-`GIT_INDEX_FILE`
 * variant), so this module stays a pure decision with no process-spawning of
 * its own.
 */

import { isSafeGitRef } from './git-refs.ts';

/** What a caller's `git` runner must answer with. Both existing runners are
 *  wider than this; `code` is the process exit code only, and only when the
 *  caller could read one (a spawn-level failure such as ENOENT has no code). */
export interface GitRunResult {
  ok: boolean;
  stdout: string;
  code?: number;
}

/** A caller-supplied `git` invocation, already bound to a working directory (and env). */
export type GitRunner = (args: string[]) => Promise<GitRunResult>;

/** The task branch cezar created vs. the branch HEAD actually sits on. */
export interface RepointedHead {
  headBranch: string;
  taskBranch: string;
}

export interface TaskDiffBase {
  /** The ref to diff against. */
  base: string;
  /** Present only when HEAD left the task's branch — the reason `base` is what it is. */
  repointedHead?: RepointedHead;
}

/**
 * ISO-8601 instants only, for the `<branch>@{<date>}` revision below. The
 * timestamp comes from a stored run record, and a git revision expression is
 * the one place a stray value would be interpreted rather than compared —
 * `@{-1}` is "the previously checked-out branch", not a date. Anything that is
 * not plainly a timestamp simply disables the baseline anchor.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The freshest ref the configured base branch names: `origin/<base>` when the
 * local branch is behind it, the local branch when it is equal or ahead (or
 * origin has no such branch), and — when the two diverged — whichever side the
 * task actually forked from.
 *
 * Same rule as `resolveBaseRef` (`git-worktree.ts`), which picks the fork point
 * when the worktree is created; this one re-applies it every time a diff is
 * measured, because that is when the local ref's staleness actually shows up.
 * A base that is already remote-tracking, a commit sha pinned from a detached
 * HEAD, or a repo with no `origin` all fall through unchanged.
 */
async function freshestBaseRef(runGit: GitRunner, base: string): Promise<FreshestBase> {
  if (!isSafeGitRef(base) || base === 'HEAD' || base.startsWith('origin/')) return { base };
  const remote = `origin/${base}`;
  const hasRemote = await runGit(['rev-parse', '--verify', '--quiet', `${remote}^{commit}`]);
  if (!hasRemote.ok) return { base };
  // The tip the decision reads; the caller memoizes it so a fetch that advances
  // `origin/<base>` under an unchanged HEAD invalidates the cached anchor.
  const remoteTip = hasRemote.stdout.trim();
  // Exits 0 iff local is equal to or ahead of origin — the case where the local
  // ref carries unpushed base commits and is the better answer. A clean exit 1
  // is the only evidence that origin is strictly ahead; any other failure (a
  // broken object, a signal) says nothing about ancestry, so keep the local ref
  // rather than silently switching the diff base to origin.
  const localCurrent = await runGit(['merge-base', '--is-ancestor', remote, base]);
  if (localCurrent.ok) return { base, remoteTip };
  if (localCurrent.code !== 1) return { base, remoteTip };
  const localBehind = await runGit(['merge-base', '--is-ancestor', base, remote]);
  if (localBehind.ok) return { base: remote, remoteTip };
  // DIVERGED. `resolveBaseRef` forks a zero-config task from the user's own
  // diverged branch (`keepDiverged`) but a configured base from origin, and
  // only the fork shows which: the task forked from whichever side's
  // merge-base with HEAD is the newer one. Keep local only when its merge-base
  // strictly descends from origin's — otherwise the stale-base rule stands.
  const [mbLocal, mbRemote] = await Promise.all([
    runGit(['merge-base', base, 'HEAD']),
    runGit(['merge-base', remote, 'HEAD']),
  ]);
  const local = mbLocal.ok ? mbLocal.stdout.trim() : '';
  const upstream = mbRemote.ok ? mbRemote.stdout.trim() : '';
  if (!local || !upstream || local === upstream) return { base: remote, remoteTip };
  const forkedFromLocal = await runGit(['merge-base', '--is-ancestor', upstream, local]);
  return { base: forkedFromLocal.ok ? base : remote, remoteTip };
}

/** `freshestBaseRef`'s answer plus the `origin/<base>` tip it read (if any). */
interface FreshestBase {
  base: string;
  remoteTip?: string;
}

/**
 * Where the repointed branch stood when this run started — `git rev-parse
 * <branch>@{<runStartedAt>}`, i.e. its own reflog, read at a point in time.
 *
 * Git answers this generously by design: a timestamp older than the whole
 * reflog resolves to the branch's OLDEST recorded state, which for a branch the
 * agent created during the run is its creation commit — exactly the fork point
 * we want. A branch that already existed resolves to the tip it had before the
 * run touched it, so the previous author's commits stay theirs.
 *
 * Null (→ the caller keeps the conservative `HEAD` anchor) when there is no run
 * start to read at, when HEAD is detached (no branch reflog to consult), or
 * when reflogs are unavailable — a guess is worse than the narrow answer.
 */
async function checkoutBaseline(
  runGit: GitRunner,
  headBranch: string,
  runStartedAt: string | undefined,
): Promise<string | null> {
  if (!runStartedAt || !ISO_INSTANT.test(runStartedAt)) return null;
  if (headBranch === 'HEAD' || !isSafeGitRef(headBranch)) return null;
  const at = await runGit([
    'rev-parse',
    '--verify',
    '--quiet',
    `${headBranch}@{${runStartedAt}}^{commit}`,
  ]);
  const sha = at.ok ? at.stdout.trim() : '';
  return sha || null;
}

/**
 * How many changed lines an anchor attributes to the task — the comparison that
 * picks between two candidates, never a number anyone sees (the callers do their
 * own parsing for that, `parseShortstat`). Both candidates cover the same
 * uncommitted work, so the comparison is fair whatever the index holds.
 *
 * This is the one part of the decision that reads the index rather than just
 * refs, and `git diff` rewrites the index it reads (a stat refresh). Callers
 * that keep their diffs off an index they do not own — `collectChanges` and its
 * scratch `GIT_INDEX_FILE` — must therefore hand this module a runner carrying
 * that same environment, and the two probes below run one after the other so
 * they never refresh one index file concurrently.
 */
async function changedLines(runGit: GitRunner, ref: string): Promise<number | null> {
  const res = await runGit(['diff', '--shortstat', ref]);
  if (!res.ok) return null;
  let total = 0;
  for (const m of res.stdout.matchAll(/(\d+) (?:insertions?\(\+\)|deletions?\(-\))/g)) {
    total += Number(m[1]);
  }
  return total;
}

/**
 * Resolve the diff anchor for a task worktree. Never throws: a failing git call
 * degrades to the base branch name, which is what the un-guarded callers did
 * before this helper existed.
 *
 * `taskBranch` is optional because not every caller has one (the main working
 * tree has no task branch at all). Without it there is nothing to compare HEAD
 * against, so the merge-base anchor is used unchanged.
 *
 * `runStartedAt` is what makes the repointed-HEAD answer a measurement instead
 * of a guess; without it the anchor stays `HEAD` (uncommitted work only), the
 * conservative #751 answer that can never claim someone else's commits.
 */
export async function resolveTaskDiffBase(
  runGit: GitRunner,
  baseBranch: string,
  opts: { taskBranch?: string; runStartedAt?: string; cacheKey?: string } = {},
): Promise<TaskDiffBase> {
  if (opts.cacheKey) {
    const hit = await cachedBase(runGit, baseBranch, opts);
    if (hit) return hit;
  }
  const { result, headSha, remoteTip } = await computeTaskDiffBase(runGit, baseBranch, opts);
  // Only the repointed path is worth caching: it costs a reflog probe and two
  // shortstat comparisons, while the normal merge-base is a single spawn. The
  // cache is validated against HEAD and the `origin/<base>` tip the resolution
  // read, so a new commit, a fresh branch or an advancing upstream base misses.
  if (opts.cacheKey && result.repointedHead && headSha) {
    storeBase(result, headSha, baseBranch, opts, remoteTip);
  }
  return result;
}

/**
 * Memoized diff anchors, validated on read against the caller's HEAD (sha AND
 * branch, read in one spawn) and a short TTL. Keyed by a caller-supplied
 * identity (the worktree path) rather than by a git object this module would
 * have to spawn to discover.
 */
const RESOLVE_CACHE_TTL_MS = 5_000;
interface ResolveCacheEntry {
  base: string;
  headSha: string;
  /** The branch the cached sha sat on. A sha alone cannot tell two branches
   *  apart — checking out the task's own branch again usually leaves HEAD at
   *  the same commit — so the entry is valid only while both match. */
  headBranch: string;
  /** The `origin/<base>` tip the cached resolution read, when that ref existed.
   *  Upstream resolves the base against the freshly fetched remote tip
   *  (`freshestBaseRef`), so an advancing `origin/<base>` can change the anchor
   *  under an unchanged HEAD; the hit re-validates it. Absent when the base is
   *  local-only, remote-tracking or pinned, where the tip is not an input. */
  remoteTip?: string;
  repointedHead?: RepointedHead;
  baseBranch: string;
  taskBranch?: string;
  runStartedAt?: string;
  at: number;
}
const RESOLVE_CACHE_MAX = 50;
const resolveCache = new Map<string, ResolveCacheEntry>();

/** Drop memoized anchors — tests and any caller that repoints HEAD directly. */
export function clearTaskDiffBaseCache(): void {
  resolveCache.clear();
}

async function cachedBase(
  runGit: GitRunner,
  baseBranch: string,
  opts: { taskBranch?: string; runStartedAt?: string; cacheKey?: string },
): Promise<TaskDiffBase | null> {
  const cached = resolveCache.get(opts.cacheKey as string);
  if (
    !cached ||
    cached.baseBranch !== baseBranch ||
    cached.taskBranch !== opts.taskBranch ||
    cached.runStartedAt !== opts.runStartedAt ||
    Date.now() - cached.at >= RESOLVE_CACHE_TTL_MS
  ) {
    return null;
  }
  const head = await runGit(['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD']);
  if (!head.ok) return null;
  const [headSha = '', headBranch = ''] = head.stdout.trim().split('\n');
  if (headSha !== cached.headSha || headBranch !== cached.headBranch) return null;
  if (cached.remoteTip !== undefined) {
    const remote = await runGit(['rev-parse', '--verify', '--quiet', `origin/${baseBranch}^{commit}`]);
    if (!remote.ok || remote.stdout.trim() !== cached.remoteTip) return null;
  }
  return { base: cached.base, ...(cached.repointedHead ? { repointedHead: cached.repointedHead } : {}) };
}

function storeBase(
  result: TaskDiffBase,
  headSha: string,
  baseBranch: string,
  opts: { taskBranch?: string; runStartedAt?: string; cacheKey?: string },
  remoteTip?: string,
): void {
  resolveCache.delete(opts.cacheKey as string);
  resolveCache.set(opts.cacheKey as string, {
    base: result.base,
    headSha,
    headBranch: result.repointedHead?.headBranch ?? '',
    ...(remoteTip !== undefined ? { remoteTip } : {}),
    ...(result.repointedHead ? { repointedHead: result.repointedHead } : {}),
    baseBranch,
    taskBranch: opts.taskBranch,
    runStartedAt: opts.runStartedAt,
    at: Date.now(),
  });
  while (resolveCache.size > RESOLVE_CACHE_MAX) resolveCache.delete(resolveCache.keys().next().value!);
}

async function computeTaskDiffBase(
  runGit: GitRunner,
  baseBranch: string,
  opts: { taskBranch?: string; runStartedAt?: string },
): Promise<{ result: TaskDiffBase; headSha: string; remoteTip?: string }> {
  const { base, remoteTip } = await freshestBaseRef(runGit, baseBranch);
  const mergeBase = async (): Promise<string> => {
    const res = await runGit(['merge-base', base, 'HEAD']);
    return res.ok && res.stdout.trim() ? res.stdout.trim() : base;
  };

  if (!opts.taskBranch) return { result: { base: await mergeBase() }, headSha: '', remoteTip };

  // One `rev-parse` reads both the commit HEAD names (the cache key) and the
  // branch it sits on. An unreadable HEAD (no commits yet, broken worktree) is
  // NOT evidence of a repoint — fall through to the merge-base anchor rather
  // than narrowing on a guess. A detached HEAD, on the other hand, is by
  // definition not the task's branch and takes the repointed path below.
  const headRef = await runGit(['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD']);
  const [headSha = '', headBranch = ''] = headRef.ok ? headRef.stdout.trim().split('\n') : [];
  if (!headBranch || headBranch === opts.taskBranch) {
    return { result: { base: await mergeBase() }, headSha, remoteTip };
  }

  const repointedHead = { headBranch, taskBranch: opts.taskBranch };
  const baseline = await checkoutBaseline(runGit, headBranch, opts.runStartedAt);
  if (!baseline) return { result: { base: 'HEAD', repointedHead }, headSha, remoteTip };

  const anchor = await mergeBase();
  // The two anchors usually resolve to the same commit; there is nothing to
  // compare then, and skipping the two shortstat probes keeps the repointed
  // path down to the ref lookups.
  if (baseline === anchor) return { result: { base: baseline, repointedHead }, headSha, remoteTip };

  // Two defensible anchors, so report the tighter one: the number must never
  // claim more than the least either measure attributes to this task. The
  // baseline is usually it — but not when the run merged the base branch in
  // afterwards, which drags the whole upstream delta past a pre-merge baseline
  // and leaves the merge-base as the only anchor that still measures the task.
  const viaBaseline = await changedLines(runGit, baseline);
  if (viaBaseline === null) return { result: { base: anchor, repointedHead }, headSha, remoteTip };
  const viaMergeBase = await changedLines(runGit, anchor);
  if (viaMergeBase === null || viaBaseline <= viaMergeBase) {
    return { result: { base: baseline, repointedHead }, headSha, remoteTip };
  }
  return { result: { base: anchor, repointedHead }, headSha, remoteTip };
}
