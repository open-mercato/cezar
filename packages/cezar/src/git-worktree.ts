import { execFile } from 'node:child_process';
import { existsSync, realpathSync, type Dirent } from 'node:fs';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { resolveTaskDiffBase } from './git-diff-base.ts';
import { isSafeGitRef } from './git-refs.ts';

/**
 * Git worktree per task (spec 006). Each run gets its own branch
 * `cez/<id8>` checked out into `.ai/cezar/worktrees/<runId>` so agents never
 * touch the user's working tree. Pattern ported from github-janitor's
 * `git.ts` (createWorktree / autosaveCommit), minus the bare clone — we're
 * already inside a working copy. Everything degrades: helpers never throw
 * except `createWorktree`, whose failure the caller turns into a note.
 */

/** Repo-relative home of all task worktrees (gitignored via .ai/cezar/.gitignore). */
export const WORKTREES_DIR = '.ai/cezar/worktrees';

const DIFF_CAP = 400_000;

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

interface RegisteredWorktree {
  path: string;
  branch?: string;
}

/** Run git, never throw — degradation is the caller's policy. */
function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' }),
    );
  });
}

export function branchFor(runId: string): string {
  return `cez/${runId.slice(0, 8)}`;
}

/**
 * Resolve the configured base branch to something `git worktree add` can
 * fork from: the local branch, its remote-tracking ref, or null — the caller
 * falls back to the current branch with a note. Never throws.
 *
 * When BOTH the local branch and `origin/<base>` exist, prefer whichever is up
 * to date. A stale LOCAL base (behind origin, because nothing fetched it into
 * this worktree's repo) is the classic inflated-diff trap: the merge-base every
 * diff is measured from collapses onto the stale tip, so all of the history
 * merged into origin since then counts as the task's own changes — the phantom
 * 142k-line diff. `origin/<base>` is the source of truth for a review base, so
 * only keep the local ref when it is equal to or ahead of origin (unpushed base
 * commits); otherwise use origin.
 *
 * This answers the question once, when the worktree is forked. The local ref
 * goes stale AFTERWARDS too — agents fetch, they never pull — so every diff
 * re-applies the same rule at read time through `freshestBaseRef`
 * (`git-diff-base.ts`). Keep the two in agreement.
 */
export async function resolveBaseRef(repoRoot: string, base: string): Promise<string | null> {
  if (!isSafeGitRef(base)) return null;
  const verify = (ref: string) =>
    git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).then((r) => r.ok);
  const [hasLocal, hasRemote] = await Promise.all([verify(base), verify(`origin/${base}`)]);
  if (hasLocal && hasRemote) {
    // `--is-ancestor origin/<base> <base>` succeeds iff local is equal-or-ahead.
    const localCurrent = await git(repoRoot, ['merge-base', '--is-ancestor', `origin/${base}`, base]);
    return localCurrent.ok ? base : `origin/${base}`;
  }
  if (hasLocal) return base;
  if (hasRemote) return `origin/${base}`;
  return null;
}

export function worktreePathFor(repoRoot: string, runId: string): string {
  return join(repoRoot, WORKTREES_DIR, runId);
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  /** Branch name the worktree was forked from (commit sha when HEAD was detached). */
  baseBranch: string;
}

/** Parse `git worktree list --porcelain` without assuming paths contain no spaces. */
async function registeredWorktrees(repoRoot: string): Promise<RegisteredWorktree[]> {
  const res = await git(repoRoot, ['worktree', 'list', '--porcelain']);
  if (!res.ok) return [];
  const worktrees: RegisteredWorktree[] = [];
  let current: RegisteredWorktree | undefined;
  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) worktrees.push(current);
      current = { path: line.slice('worktree '.length) };
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length);
    } else if (!line && current) {
      worktrees.push(current);
      current = undefined;
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

function worktreeInfo(path: string, branch: string, baseBranch: string): WorktreeInfo {
  return { path, branch, baseBranch };
}

/** Git canonicalizes symlinked path prefixes (macOS `/var` → `/private/var`). */
function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Establish the task worktree idempotently. Besides the fresh
 * `git worktree add -b` path, recover the two normal restart/deletion cases:
 * reuse an already-registered task worktree, or reattach a surviving task
 * branch after its directory/registration was removed. Existing non-empty
 * unregistered paths are never deleted because they may hold recoverable
 * uncommitted work.
 */
export async function createWorktree(
  repoRoot: string,
  runId: string,
  baseBranch: string,
): Promise<WorktreeInfo> {
  let base = baseBranch;
  if (!base || base === 'HEAD') {
    // Detached HEAD — pin the base to the current commit so the record and
    // later diffs stay meaningful.
    const head = await git(repoRoot, ['rev-parse', 'HEAD']);
    if (!head.ok) throw new Error(`git rev-parse HEAD failed: ${head.stderr.trim()}`);
    base = head.stdout.trim();
  }
  // Dash-guard (#431): `base` is spliced in as a positional git operand; an
  // option-like value would be argument injection.
  if (!isSafeGitRef(base)) throw new Error(`refusing option-like base ref: ${base}`);
  const branch = branchFor(runId);
  const absolutePath = join(canonicalPath(repoRoot), WORKTREES_DIR, runId);
  const branchRef = `refs/heads/${branch}`;

  // A missing directory can leave stale administrative metadata behind.
  // Prune first so the checks below describe the filesystem as it exists now.
  await git(repoRoot, ['worktree', 'prune']);
  const canonicalTarget = canonicalPath(absolutePath);
  let registered = await registeredWorktrees(repoRoot);
  let atPath = registered.find((item) => canonicalPath(item.path) === canonicalTarget);
  if (atPath) {
    if (atPath.branch !== branchRef) {
      throw new Error(
        `managed worktree path is registered to ${atPath.branch ?? 'a detached HEAD'}, expected ${branchRef}`,
      );
    }
    return worktreeInfo(atPath.path, branch, base);
  }

  // If the directory survived but its administrative entry did not, let Git
  // repair it. This is non-destructive; an unrepairable non-empty directory is
  // preserved and reported instead of being recursively removed.
  if (existsSync(absolutePath)) {
    await git(repoRoot, ['worktree', 'repair', absolutePath]);
    registered = await registeredWorktrees(repoRoot);
    atPath = registered.find((item) => canonicalPath(item.path) === canonicalTarget);
    if (atPath) {
      if (atPath.branch !== branchRef) {
        throw new Error(
          `managed worktree path is registered to ${atPath.branch ?? 'a detached HEAD'}, expected ${branchRef}`,
        );
      }
      return worktreeInfo(atPath.path, branch, base);
    }
    const entries = await readdir(absolutePath).catch(() => ['unreadable']);
    if (entries.length > 0) {
      throw new Error(`managed worktree path already exists and could not be repaired: ${absolutePath}`);
    }
  }

  const branchExists = await git(repoRoot, ['show-ref', '--verify', '--quiet', branchRef]);
  if (branchExists.ok) {
    // The task branch may still be checked out after its directory was moved.
    // Reuse only a path whose basename is the full run id; a same-prefix UUID
    // collision must fail rather than point two tasks at one worktree.
    const byBranch = registered.find((item) => item.branch === branchRef);
    if (byBranch) {
      if (basename(byBranch.path) !== runId) {
        throw new Error(`task branch ${branch} is already checked out at ${byBranch.path}`);
      }
      return worktreeInfo(byBranch.path, branch, base);
    }
    const attach = await git(repoRoot, ['worktree', 'add', absolutePath, branch]);
    if (!attach.ok) {
      throw new Error(`git worktree reattach failed: ${attach.stderr.trim() || attach.stdout.trim()}`);
    }
    return worktreeInfo(absolutePath, branch, base);
  }

  const create = await git(repoRoot, ['worktree', 'add', '-b', branch, absolutePath, base]);
  if (!create.ok) {
    throw new Error(`git worktree add failed: ${create.stderr.trim() || create.stdout.trim()}`);
  }
  return worktreeInfo(absolutePath, branch, base);
}

/**
 * Best-effort on-disk size of a worktree directory in bytes, via POSIX
 * `du -sk` (kibibytes → bytes). Returns `null` when `du` is unavailable —
 * including all of Windows, where `du` is not a command — or on any error.
 * Never throws and never blocks: worktree retention is count-based, so a null
 * size only blanks the panel's size column, it does not affect reclamation.
 */
export function worktreeSizeBytes(path: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('du', ['-sk', path], { encoding: 'utf8' }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const kib = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? '', 10);
      resolve(Number.isFinite(kib) ? kib * 1024 : null);
    });
  });
}

/** Remove a task worktree and its branch. Best effort — never throws. */
export async function removeWorktree(
  repoRoot: string,
  worktreePath: string,
  branch?: string,
): Promise<void> {
  await git(repoRoot, ['worktree', 'remove', '--force', worktreePath]);
  await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
  await git(repoRoot, ['worktree', 'prune']);
  if (branch) await git(repoRoot, ['branch', '-D', branch]);
}

/**
 * Why an autosave commit happened. Only `periodic` is gated (behind
 * `CEZ_AUTOSAVE=1`, #471) — the three flushes always run so the branch ends
 * holding the finished state. Before this was recorded, all four wrote the bare
 * message `cezar autosave`, so a user who had opted out of the periodic timer
 * still saw `cezar autosave` in `git log` and reasonably concluded the opt-out
 * was broken. Only commit *spacing* (~90 s ⇒ timer) told them apart.
 */
export type AutosaveReason = 'periodic' | 'turn end' | 'run finalize' | 'pre-PR';

/**
 * What an autosave attempt did. `refused` and `failed` are distinct from
 * `nothing-to-do` because one call site must act on them: the pre-PR flush is
 * the *last* one, so anything other than `committed`/`nothing-to-do` there
 * means the branch leaves the box without the run's final state and the user
 * has to be told (see createDraftPr). A bare boolean could not carry that.
 */
export type AutosaveResult = 'committed' | 'nothing-to-do' | 'refused' | 'failed';

/**
 * Leftover merge-conflict markers, anchored at line start as git writes them.
 * All three must appear *in order*: a bare `=======` line is ordinary Markdown
 * (a setext heading underline), and any of the three alone — or the pair
 * `<<<<<<<`/`>>>>>>>` in either order — occurs legitimately in checked-in
 * patch fixtures and in docs that demonstrate conflict markers. Requiring the
 * full ordered triple is what separates a real conflict from a file that
 * merely talks about one.
 */
const CONFLICT_START = /^<{7}(?:\s|$)/;
const CONFLICT_MID = /^={7}(?:\s|$)/;
const CONFLICT_END = /^>{7}(?:\s|$)/;

/**
 * Largest file the marker scan will read. Autosave runs as often as every 90 s,
 * and decoding a large tracked file into a JS string each time is a real memory
 * cost for a check that only ever looks at a few marker lines. Oversized files
 * are skipped, which fails *open* — consistent with the rest of this guard,
 * where a false negative costs noise and a false positive costs the recovery
 * point.
 */
const MARKER_SCAN_MAX_BYTES = 2_000_000;

/** Does this file carry a complete, ordered conflict hunk? */
function hasConflictMarkers(text: string): boolean {
  let want: 0 | 1 | 2 = 0; // 0: `<<<<<<<`, 1: `=======`, 2: `>>>>>>>`
  for (const line of text.split('\n')) {
    if (want === 0) {
      if (CONFLICT_START.test(line)) want = 1;
    } else if (want === 1) {
      if (CONFLICT_MID.test(line)) want = 2;
    } else if (CONFLICT_END.test(line)) {
      return true;
    }
  }
  return false;
}

/**
 * Stage and commit everything in the worktree as a "cezar autosave" commit
 * (janitor pattern) — the agent's progress is always recoverable from the
 * `cez/<id8>` branch history. Quietly a no-op when nothing changed.
 *
 * The message carries `reason` so the opt-in periodic timer and the always-on
 * flushes are distinguishable in `git log`; the `cezar autosave` prefix is kept
 * so existing log greps still match.
 *
 * Refuses to commit a worktree that is mid-merge or still carries conflict
 * markers: the incident behind #471 was an autosave capturing a half-resolved
 * merge, and a blind `git add -A` would do it again.
 */
export async function autosaveCommit(dir: string, reason: AutosaveReason): Promise<AutosaveResult> {
  const status = await git(dir, ['status', '--porcelain']);
  if (!status.ok || !status.stdout.trim()) return 'nothing-to-do';
  const unresolved = await unresolvedConflicts(dir, status.stdout);
  if (unresolved) {
    // Losing one recovery point beats poisoning the branch with a commit that
    // does not build. For the periodic and turn-end flushes the next one picks
    // the work up once the merge resolves; the pre-PR flush has no next one,
    // which is why callers get `refused` rather than a bare `false`.
    console.warn(`[cezar] skipping ${reason} autosave in ${dir}: ${unresolved}`);
    return 'refused';
  }
  await git(dir, ['add', '-A']);
  // Commit as the CURRENT git user, so the branch's commits (and any PR opened from it) are
  // attributed to the real author and pass CLA / attribution checks. The old hardcoded
  // `cezar <cezar@local>` identity made every autosave look like a non-GitHub user. Fall back to
  // that identity ONLY when the machine has no git identity configured — otherwise `git commit`
  // would fail and the autosave (the run's recovery point) would be lost.
  const identityArgs = (await gitHasIdentity(dir))
    ? []
    : ['-c', 'user.name=cezar', '-c', 'user.email=cezar@local'];
  const commit = await git(dir, [
    ...identityArgs,
    'commit',
    '--no-verify',
    '-m',
    `cezar autosave (${reason})`,
  ]);
  return commit.ok ? 'committed' : 'failed';
}

/**
 * Is the worktree mid-merge or still carrying conflict markers? Returns a
 * human-readable reason, or `null` when it is safe to autosave.
 *
 * Two independent checks, because they catch different failures: porcelain `U`
 * codes catch an *unresolved* merge, while the marker scan catches the worse
 * case — someone ran `git add` on a file they had not finished resolving, which
 * clears the `U` code but leaves `<<<<<<<` in the text.
 */
async function unresolvedConflicts(dir: string, porcelain: string): Promise<string | null> {
  const entries = porcelain.split('\n').filter(Boolean);
  const unmerged = entries.filter((line) => {
    const xy = line.slice(0, 2);
    // Unmerged per `git status` docs: any side U, plus the AA / DD collisions.
    return xy.includes('U') || xy === 'AA' || xy === 'DD';
  });
  const firstUnmerged = unmerged[0];
  if (firstUnmerged) {
    return `${unmerged.length} unmerged path(s), e.g. ${firstUnmerged.slice(3)}`;
  }
  // Deleted paths have no content to scan. Untracked (`??`) ones are skipped
  // even though `git add -A` will commit them: a conflict always lands in a
  // tracked file, whereas an untracked fixture or doc that legitimately
  // contains marker-shaped lines would otherwise wedge every autosave. False
  // negatives here cost noise; false positives would cost the recovery point.
  const candidates = entries
    .filter((line) => !line.startsWith('D ') && !line.startsWith(' D') && !line.startsWith('??'))
    .map((line) => {
      // A rename reads `old -> new`; the new path is what gets committed.
      const raw = line.slice(3).trim();
      const path = raw.includes(' -> ') ? (raw.split(' -> ')[1] ?? raw) : raw;
      return unquotePath(path);
    });
  for (const path of candidates) {
    // Read the working tree, not the index: this runs before `git add -A`, so
    // the on-disk copy is what would be committed. Binary files decode to
    // mojibake rather than throwing, but cannot match the anchored marker
    // pattern; unreadable paths (races, symlinks) are skipped, not fatal.
    let text: string;
    try {
      const full = join(dir, path);
      if ((await stat(full)).size > MARKER_SCAN_MAX_BYTES) continue;
      text = await readFile(full, 'utf8');
    } catch {
      continue;
    }
    if (hasConflictMarkers(text)) {
      return `leftover conflict markers in ${path}`;
    }
  }
  return null;
}

/**
 * Undo `git status --porcelain` path quoting. Git quotes a path containing a
 * space or a non-ASCII byte, escaping the latter as octal — `café.txt` reads
 * back as `"caf\303\251.txt"`. Stripping the quotes alone leaves those escapes
 * literal, so the file would not open and a real conflict in it would go
 * unnoticed. Decoding the octal bytes as UTF-8 restores the actual name.
 */
function unquotePath(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  const inner = path.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] !== '\\') {
      bytes.push(...Buffer.from(inner[i] as string, 'utf8'));
      continue;
    }
    const next = inner[i + 1] as string | undefined;
    if (next === undefined) break;
    const octal = inner.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 3;
      continue;
    }
    // C-style single-character escapes git also emits.
    const simple: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92 };
    const escaped = simple[next];
    if (escaped === undefined) bytes.push(...Buffer.from(next, 'utf8'));
    else bytes.push(escaped);
    i += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Does this repo/worktree resolve a git author identity (name + email)? Ambient config wins so
 *  autosave commits carry the user's own identity — see autosaveCommit. */
async function gitHasIdentity(dir: string): Promise<boolean> {
  const [name, email] = await Promise.all([
    git(dir, ['config', 'user.name']),
    git(dir, ['config', 'user.email']),
  ]);
  return name.ok && name.stdout.trim() !== '' && email.ok && email.stdout.trim() !== '';
}

/**
 * "What did this task change": diff of the worktree (committed + uncommitted
 * + untracked, via `add -N`) against the merge-base with its base branch —
 * so the diff stays *this task's* changes even after the base moves on.
 *
 * Deliberately does NOT take the repointed-HEAD guard that `collectChanges`
 * (#591) and `worktreeShortstat` (#751) resolve through
 * `resolveTaskDiffBase` — this is the whole-branch anchor on purpose, for two
 * reasons. Its text output is `GET /api/v1/runs/:id/diff`, a protected surface
 * (BACKWARD_COMPATIBILITY.md §2), so narrowing it would silently change what
 * every existing consumer reads. And its other caller, `settleSuccess`, asks
 * only "is there anything here to review at all" — over-answering that parks a
 * run at the review gate, which is recoverable, while under-answering would
 * settle a run to `done` with work still in the tree. If a future change wants
 * the narrow answer here, take it from `resolveTaskDiffBase` rather than
 * re-deriving the rule a fourth time.
 */
export async function worktreeDiff(
  worktreePath: string,
  baseBranch: string,
  cap = DIFF_CAP,
): Promise<string> {
  if (!isSafeGitRef(baseBranch)) return '(diff failed: refusing option-like base ref)';
  await git(worktreePath, ['add', '-N', '.']); // intent-to-add: untracked files show up
  const mergeBase = await git(worktreePath, ['merge-base', baseBranch, 'HEAD']);
  const base = mergeBase.ok && mergeBase.stdout.trim() ? mergeBase.stdout.trim() : baseBranch;
  const res = await git(worktreePath, ['diff', base]);
  if (!res.ok) return `(diff failed: ${res.stderr.trim() || 'unknown git error'})`;
  if (res.stdout.length > cap) return `${res.stdout.slice(0, cap)}\n… (diff truncated)`;
  return res.stdout;
}

/**
 * `git diff --stat` version of `worktreeDiff` (spec 010 — the variant
 * comparison columns). Same merge-base anchoring, and it stays whole-branch
 * for a reason of its own: variants are sibling cezar worktrees, each on its
 * own `cez/*` branch, and the column exists to compare their *committed* work
 * against one another. Narrowing one variant to its uncommitted tree would
 * make the comparison meaningless rather than more honest. Returns '' on any
 * failure. (The task-diff rule the other surfaces follow: `git-diff-base.ts`.)
 */
export async function worktreeDiffStat(
  worktreePath: string,
  baseBranch: string,
): Promise<string> {
  if (!isSafeGitRef(baseBranch)) return '';
  await git(worktreePath, ['add', '-N', '.']); // intent-to-add: untracked files show up
  const mergeBase = await git(worktreePath, ['merge-base', baseBranch, 'HEAD']);
  const base = mergeBase.ok && mergeBase.stdout.trim() ? mergeBase.stdout.trim() : baseBranch;
  const res = await git(worktreePath, ['diff', '--stat', base]);
  return res.ok ? res.stdout.trim() : '';
}

/** Aggregate diff numbers (#389) — the shape stored on `RunRecord.diffStat`. */
export interface DiffStat {
  adds: number;
  dels: number;
  files: number;
  /** Set only when the numbers were narrowed to what this run did on a branch it checked
   *  out into its worktree, because HEAD had been repointed off the task's branch (#751).
   *  Absent — never `false` — on a normal run, so the persisted shape is unchanged for
   *  every task that behaved. */
  repointed?: boolean;
}

/**
 * Parse `git diff --shortstat` output — " 3 files changed, 10 insertions(+),
 * 2 deletions(-)". Every part is optional: insertions-only and deletions-only
 * diffs omit the other counter, and an empty diff prints nothing at all
 * (→ all zeros). The wording is stable porcelain English — git does not
 * localize `--shortstat` — so matching the words is safe.
 */
export function parseShortstat(s: string): DiffStat {
  const files = /(\d+) files? changed/.exec(s);
  const adds = /(\d+) insertions?\(\+\)/.exec(s);
  const dels = /(\d+) deletions?\(-\)/.exec(s);
  return {
    files: files ? Number(files[1]) : 0,
    adds: adds ? Number(adds[1]) : 0,
    dels: dels ? Number(dels[1]) : 0,
  };
}

/**
 * `git diff --shortstat` of the worktree vs its base (#389) — the numbers
 * behind `RunRecord.diffStat`, which is what the sidebar quick list and the
 * Tasks table show. Same intent-to-add as `worktreeDiff`, but the anchor comes
 * from the shared `resolveTaskDiffBase` rule (`git-diff-base.ts`): pass the
 * run's own `taskBranch` and `runStartedAt`, and a worktree whose HEAD was
 * repointed onto another branch reports what this run did to that branch
 * instead of claiming the branch's whole diff as this task's (#751 — the #591
 * guard, on this surface). The same rule re-resolves a stale local base ref,
 * so the number never counts upstream history the task merely forked from.
 *
 * `repointed: true` rides along on the returned stat exactly when that
 * narrowing happened, so the UI can say why the number is what it is. Null on
 * git failure (the caller notes it, never fails the run); an empty diff is a
 * valid all-zero stat.
 */
export async function worktreeShortstat(
  worktreePath: string,
  baseBranch: string,
  opts: { taskBranch?: string; runStartedAt?: string } = {},
): Promise<DiffStat | null> {
  if (!isSafeGitRef(baseBranch)) return null;
  await git(worktreePath, ['add', '-N', '.']); // intent-to-add: untracked files show up
  const { base, repointedHead } = await resolveTaskDiffBase(
    (args) => git(worktreePath, args),
    baseBranch,
    opts,
  );
  const res = await git(worktreePath, ['diff', '--shortstat', base]);
  if (!res.ok) return null;
  // The key stays ABSENT (not `false`) on a normal run: `diffStat` is persisted in
  // `runs.json` and served on the runs API, so the un-narrowed shape must keep
  // round-tripping byte-identically.
  return { ...parseShortstat(res.stdout), ...(repointedHead ? { repointed: true } : {}) };
}

/**
 * Startup reconcile: `git worktree prune` + remove every directory under
 * `.ai/cezar/worktrees/` whose run id is no longer in the store (and its
 * branch). Returns the removed run ids for the boot log. Never throws.
 */
export async function pruneOrphans(
  repoRoot: string,
  validIds: ReadonlySet<string>,
): Promise<string[]> {
  await git(repoRoot, ['worktree', 'prune']);
  let entries: Dirent[];
  try {
    entries = await readdir(join(repoRoot, WORKTREES_DIR), { withFileTypes: true });
  } catch {
    return []; // no worktrees dir yet
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || validIds.has(entry.name)) continue;
    await removeWorktree(repoRoot, worktreePathFor(repoRoot, entry.name), branchFor(entry.name));
    removed.push(entry.name);
  }
  return removed;
}
