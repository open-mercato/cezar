import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

export interface WorktreeHandle {
  path: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  startedFromRef: string;
  dispose(): Promise<void>;
}

export async function fetchBaseBranch(repoRoot: string, remote: string, baseBranch: string): Promise<void> {
  // Intentionally narrow: we only need the base branch up to date. Avoids
  // touching unrelated refs in a large monorepo, and keeps the fetch cheap.
  await runGit(repoRoot, ['fetch', '--prune', '--no-tags', remote, baseBranch]);
}

// Private ref namespace cezar fetches PR branches into. Kept out of
// `refs/heads/` so a force-update here can never clobber a user's local
// branch of the same name (see issue #38).
export function cezarAutofixRef(branch: string): string {
  return `refs/cezar-autofix/${branch}`;
}

// Fetch a specific remote branch into cezar's private ref namespace and return
// that ref. Used by the CI follow-up flow: the PR branch exists on origin but
// may not be present in the cron worker's fresh clone, so we materialise it
// here before createWorktree starts a worktree from it.
//
// We force-update (`+`) into `refs/cezar-autofix/<branch>` rather than
// `refs/heads/<branch>` so that, when the workspace points autofix.repoRoot at
// a user's real checkout that happens to hold a local branch of the same name,
// any unpushed local commits on `refs/heads/<branch>` are never destroyed.
export async function fetchRemoteBranch(repoRoot: string, remote: string, branch: string): Promise<string> {
  const ref = cezarAutofixRef(branch);
  await runGit(repoRoot, ['fetch', '--no-tags', remote, `+refs/heads/${branch}:${ref}`]);
  return ref;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args.join(' ')} failed (cwd=${cwd}): ${msg}`);
  }
}

export async function assertIsGitRepo(path: string): Promise<void> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) {
      throw new Error(`${path} is not a directory`);
    }
  } catch (error) {
    throw new Error(`repoRoot does not exist: ${path}`);
  }
  await runGit(path, ['rev-parse', '--git-dir']);
}

export async function assertNotCezarCheckout(repoRoot: string): Promise<void> {
  try {
    const remote = await runGit(repoRoot, ['config', '--get', 'remote.origin.url']);
    if (/comerito\/cezar(\.git)?$/i.test(remote) || /[/:]cezar(\.git)?$/i.test(remote)) {
      throw new Error(
        `Refusing to autofix inside the cezar checkout itself (remote: ${remote}). ` +
        `Set autofix.repoRoot to an external repository.`,
      );
    }
  } catch (error) {
    // If the remote isn't set we can't do this check — allow but stay cautious
    if (error instanceof Error && error.message.includes('Refusing to autofix')) {
      throw error;
    }
  }
}

export async function getHeadSha(repoRoot: string, ref: string): Promise<string> {
  return runGit(repoRoot, ['rev-parse', ref]);
}

export async function branchExistsLocally(repoRoot: string, branch: string): Promise<boolean> {
  try {
    await runGit(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the filesystem path of a live worktree that has `branch` checked
 * out, or null if no such worktree exists. `git worktree list --porcelain`
 * prints repeating blocks of `worktree <path>\nHEAD <sha>\nbranch refs/heads/<name>`.
 */
export async function findBusyWorktreePath(repoRoot: string, branch: string): Promise<string | null> {
  const out = await runGit(repoRoot, ['worktree', 'list', '--porcelain']);
  const entries = out.split(/\n\n+/);
  for (const entry of entries) {
    const lines = entry.split('\n');
    const pathLine = lines.find(l => l.startsWith('worktree '));
    const branchLine = lines.find(l => l.startsWith('branch '));
    if (!pathLine || !branchLine) continue;
    const ref = branchLine.slice('branch '.length).trim();
    if (ref === `refs/heads/${branch}`) {
      return pathLine.slice('worktree '.length).trim();
    }
  }
  return null;
}

export async function createWorktree(opts: {
  repoRoot: string;
  branch: string;
  baseBranch: string;
  remote: string;
  /** If true, fetch the remote and start from `<remote>/<baseBranch>` (latest origin state). */
  fetchRemote?: boolean;
  /**
   * Explicit ref to start a freshly-created `branch` from, overriding `baseBranch`.
   * Used by the CI follow-up flow to start from the fetched PR tip
   * (`refs/cezar-autofix/<branch>`) when no local branch exists yet. Ignored
   * when the local branch already exists and `resetBranch` is false.
   */
  startRef?: string;
  /** If true, delete any existing local branch so the new worktree starts fresh. Used on retry. */
  resetBranch?: boolean;
  /** Optional warn callback for non-fatal conditions (e.g. fetch fallback). */
  onWarn?: (message: string) => void;
}): Promise<WorktreeHandle> {
  await assertIsGitRepo(opts.repoRoot);
  await assertNotCezarCheckout(opts.repoRoot);

  // Drop registrations whose filesystem paths no longer exist. Without this,
  // a prior crashed attempt leaves the branch "checked out" by a phantom
  // worktree and `git worktree add` refuses to proceed.
  await runGit(opts.repoRoot, ['worktree', 'prune']);

  // Pull the latest remote tip before branching. If the user's local
  // baseBranch is behind origin, building on it guarantees PR merge conflicts
  // against the current GitHub state. Branching from <remote>/<baseBranch>
  // sidesteps the user's working copy entirely.
  let startingRef = opts.startRef ?? opts.baseBranch;
  if (!opts.startRef && opts.fetchRemote) {
    try {
      await fetchBaseBranch(opts.repoRoot, opts.remote, opts.baseBranch);
      startingRef = `${opts.remote}/${opts.baseBranch}`;
    } catch (err) {
      // Fall back to local baseBranch if the fetch fails (offline, auth issue,
      // etc). The caller can disable this behavior via autofix.fetchBeforeAttempt=false.
      opts.onWarn?.(`[autofix] fetch ${opts.remote}/${opts.baseBranch} failed; falling back to local ${opts.baseBranch}: ${(err as Error).message}`);
    }
  }

  const baseSha = await getHeadSha(opts.repoRoot, startingRef);

  const parent = await mkdtemp(join(tmpdir(), 'cezar-autofix-'));
  const worktreePath = join(parent, 'repo');

  // If a live (non-phantom) worktree still holds this branch, remove it.
  // This happens when a prior attempt's dispose() was skipped but the dir
  // still exists on disk (e.g. the user killed the process with Ctrl+C).
  const busyPath = await findBusyWorktreePath(opts.repoRoot, opts.branch);
  if (busyPath) {
    await runGit(opts.repoRoot, ['worktree', 'remove', '--force', busyPath]).catch(() => {});
    await rm(busyPath, { recursive: true, force: true }).catch(() => {});
    await runGit(opts.repoRoot, ['worktree', 'prune']);
  }

  const branchAlreadyExists = await branchExistsLocally(opts.repoRoot, opts.branch);

  if (branchAlreadyExists && opts.resetBranch) {
    // Safe to delete: cezar only pushes the branch on review-pass, so a local
    // branch with the same name is always stale work from a prior attempt.
    await runGit(opts.repoRoot, ['branch', '-D', opts.branch]);
  }

  if (branchAlreadyExists && !opts.resetBranch) {
    // Existing branch takes precedence — caller asked to continue it, not
    // reset. Ignore startingRef in this case.
    await runGit(opts.repoRoot, ['worktree', 'add', worktreePath, opts.branch]);
  } else {
    await runGit(opts.repoRoot, ['worktree', 'add', '-b', opts.branch, worktreePath, startingRef]);
  }

  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    try {
      await runGit(opts.repoRoot, ['worktree', 'remove', '--force', worktreePath]);
    } catch {
      // fall through to fs cleanup
    }
    await rm(parent, { recursive: true, force: true }).catch(() => {});
  };

  return {
    path: worktreePath,
    branch: opts.branch,
    baseBranch: opts.baseBranch,
    baseSha,
    startedFromRef: startingRef,
    dispose,
  };
}

export async function commitAll(worktreePath: string, message: string): Promise<string | null> {
  await runGit(worktreePath, ['add', '-A']);
  const status = await runGit(worktreePath, ['status', '--porcelain']);
  if (!status) return null;
  await runGit(worktreePath, ['commit', '-m', message]);
  return runGit(worktreePath, ['rev-parse', 'HEAD']);
}

/**
 * Periodically commit any in-progress changes in the worktree so a crashed
 * or killed agent leaves a recoverable branch instead of losing the work.
 * Returns a stop function that flushes one last commit before exiting.
 *
 * Best-effort: commit failures are swallowed (logged via `onWarn` if
 * provided) so a transient git error mid-fixer doesn't kill the run.
 * Idempotent: ticks that find no dirty files do nothing — no
 * `--allow-empty` commits clutter the history.
 *
 * Inspired by the github-janitor pattern (see
 * `docs/claude-subscription-runner.md` §"Periodic autosave").
 */
export function startWorktreeAutosaver(opts: {
  worktreePath: string;
  intervalMs?: number;
  message?: string;
  onWarn?: (m: string) => void;
}): () => Promise<void> {
  const intervalMs = opts.intervalMs ?? 90_000;
  const message = opts.message ?? 'cezar: autosave';
  let stopped = false;
  let inFlight: Promise<unknown> | null = null;

  async function tick(): Promise<void> {
    if (stopped) return;
    if (inFlight) return; // skip overlapping ticks
    inFlight = commitAll(opts.worktreePath, message).catch((err: unknown) => {
      const m = err instanceof Error ? err.message : String(err);
      opts.onWarn?.(`autosave failed: ${m}`);
    });
    try {
      await inFlight;
    } finally {
      inFlight = null;
    }
  }

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return async () => {
    stopped = true;
    clearInterval(timer);
    // Final flush — make sure a stop right after a write doesn't leave
    // half-second-old changes uncommitted.
    if (inFlight) await inFlight.catch(() => {});
    await commitAll(opts.worktreePath, message).catch(() => {});
  };
}

export async function getDiffAgainstBase(worktreePath: string, baseRef: string): Promise<string> {
  return runGit(worktreePath, ['diff', `${baseRef}...HEAD`]);
}

/**
 * Squash every commit between `baseRef` and HEAD into one new commit with
 * `message`. Used by the engine's commit step when `startWorktreeAutosaver`
 * has already committed the agent's edits under `cezar: autosave (…)` —
 * without this, `commitAll` would find a clean working tree and the step
 * would fail with "fixer made no file changes" even though the work is on
 * the branch.
 *
 * Returns the new HEAD sha, or `null` when there's no diff against `baseRef`
 * (i.e. the fixer really didn't touch anything).
 */
export async function squashCommitsToBase(
  worktreePath: string,
  baseRef: string,
  message: string,
): Promise<string | null> {
  const changed = await runGit(worktreePath, ['diff', '--name-only', `${baseRef}...HEAD`]);
  if (!changed) return null;
  await runGit(worktreePath, ['reset', '--soft', baseRef]);
  await runGit(worktreePath, ['commit', '-m', message]);
  return runGit(worktreePath, ['rev-parse', 'HEAD']);
}

export async function listChangedFiles(worktreePath: string, baseRef: string): Promise<string[]> {
  const out = await runGit(worktreePath, ['diff', '--name-only', `${baseRef}...HEAD`]);
  return out.split('\n').map(s => s.trim()).filter(Boolean);
}
