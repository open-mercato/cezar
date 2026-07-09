import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

const exec = promisify(execFile);

const REPOS_DIR = join(homedir(), '.cezar', 'repos');

/**
 * Per-(owner,repo) in-process serialization for the shared working tree under
 * `~/.cezar/repos/<owner>-<repo>`.
 *
 * `ensureRepoClone` shares one working tree per repo and does `git fetch` +
 * `git reset --hard`; the cron dispatcher fires several jobs per tick, so two
 * jobs for the same workspace (e.g. a webhook burst of `triage` jobs, or a
 * `triage` + `autofix`) would otherwise race on the same checkout — one job's
 * reset clobbers files an agent in another job is editing, and concurrent
 * fetches can corrupt the pack files. The lock is held for the full duration of
 * the work that touches the tree (clone + agent run), not just the clone.
 *
 * This serializes within a single Node process only; a multi-replica
 * deployment must rely on the job lease (`claim_next_job` /
 * `requeue_stalled_jobs`) keeping at most one live run per repo.
 */
const repoLocks = new Map<string, Promise<void>>();

function repoLockKey(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

/**
 * Acquires the per-(owner,repo) working-tree lock and resolves once it's held.
 * Returns a `release` function the caller MUST call (e.g. from a `finally`)
 * when it's done with the worktree. Prefer {@link withRepoLock} unless the
 * locked region spans control flow a callback can't easily wrap.
 */
export async function acquireRepoLock(owner: string, repo: string): Promise<() => void> {
  const key = repoLockKey(owner, repo);
  const prev = repoLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Chain so the next waiter starts only after this one releases. Swallow a
  // prior rejection (there shouldn't be one — `next` only ever resolves) so the
  // chain never gets stuck.
  //
  // Store the chained promise (`prev.then(...)`) — NOT `next` — and compare
  // against that same reference on cleanup. `.then()` always returns a new
  // Promise, so comparing the stored value against `next` never matched and the
  // delete branch was unreachable, growing the Map without bound on long-lived
  // workers (mirrors the fix in `external-repo-clone.ts`; see issue #308).
  const chained = prev.then(
    () => next,
    () => next,
  );
  repoLocks.set(key, chained);
  await prev.catch(() => {});
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
    if (repoLocks.get(key) === chained) repoLocks.delete(key);
  };
}

/**
 * Runs `fn` while holding the per-(owner,repo) working-tree lock. Wrap every
 * region that touches the shared clone (the {@link ensureRepoClone} call plus
 * whatever reads/writes the returned worktree) in this so concurrent jobs for
 * the same repo can't corrupt each other's checkout.
 */
export async function withRepoLock<T>(
  owner: string,
  repo: string,
  fn: () => Promise<T>,
): Promise<T> {
  const release = await acquireRepoLock(owner, repo);
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Ensures a local clone of the repo exists and is up-to-date.
 * Returns the absolute path to the repo root.
 *
 * Clones to ~/.cezar/repos/<owner>-<repo>. If already cloned,
 * fetches latest from origin.
 *
 * NOTE: the returned worktree is shared per repo. Callers MUST run this call —
 * and everything that subsequently reads/writes the returned path — inside
 * {@link withRepoLock} so concurrent jobs for the same repo don't race on the
 * checkout (see the comment on {@link withRepoLock}).
 */
export async function ensureRepoClone(
  owner: string,
  repo: string,
  githubToken: string,
  baseBranch: string = 'main',
): Promise<string> {
  await mkdir(REPOS_DIR, { recursive: true });

  const repoDir = join(REPOS_DIR, `${owner}-${repo}`);
  const cloneUrl = `https://x-access-token:${githubToken}@github.com/${owner}/${repo}.git`;

  if (existsSync(join(repoDir, '.git'))) {
    await exec('git', ['remote', 'set-url', 'origin', cloneUrl], { cwd: repoDir });
    await exec('git', ['fetch', 'origin'], { cwd: repoDir });
    await exec('git', ['checkout', baseBranch], { cwd: repoDir }).catch(() => {
      // branch might not exist locally yet
      return exec('git', ['checkout', '-b', baseBranch, `origin/${baseBranch}`], { cwd: repoDir });
    });
    await exec('git', ['reset', '--hard', `origin/${baseBranch}`], { cwd: repoDir });
  } else {
    await exec('git', ['clone', '--depth', '50', '--branch', baseBranch, cloneUrl, repoDir]);
  }

  return repoDir;
}
