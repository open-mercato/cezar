import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const exec = promisify(execFile);

const REPOS_DIR = join(homedir(), '.cezar', 'runner-repos');

export interface JobWorktree {
  /** Absolute path to the worktree cwd (the agent's repo root for this job). */
  worktreePath: string;
  /** Per-job branch name (`cezar/job-<jobId>`), reset from `origin/<baseBranch>`. */
  branchName: string;
  /** Remove the worktree (and its branch ref). Idempotent — safe to call in `finally`. */
  cleanup: () => Promise<void>;
}

function barePathFor(owner: string, repo: string): string {
  // `__` matches Janitor's convention and intentionally differs from the legacy
  // `${owner}-${repo}` full-clone dir so older runner installs can coexist.
  return join(REPOS_DIR, `${owner}__${repo}.git`);
}

function worktreeParentFor(owner: string, repo: string): string {
  return join(REPOS_DIR, `${owner}__${repo}`, 'wt');
}

/**
 * Ensures a bare clone of `<owner>/<repo>` exists and is up to date, then adds a
 * worktree at `cezar/job-<jobId>` reset to `origin/<baseBranch>`. The caller gets
 * an isolated cwd and a `cleanup()` to remove it in `finally`.
 *
 * Two jobs against the same repo share the bare object store but never share a
 * worktree, so concurrent runs can't trample each other's checkout.
 */
export async function prepareJobWorktree(
  owner: string,
  repo: string,
  githubToken: string,
  jobId: string,
  baseBranch = 'main',
): Promise<JobWorktree> {
  await mkdir(REPOS_DIR, { recursive: true });
  const barePath = barePathFor(owner, repo);
  // Persist only the plain URL in `<bare>/config`; the short-lived token is
  // supplied at command time via `-c http.extraheader=…` so it never lands on
  // disk (where it would survive between jobs, long past its 15-min lifetime).
  const plainUrl = `https://github.com/${owner}/${repo}.git`;
  const authHeader = `Authorization: Basic ${Buffer.from(`x-access-token:${githubToken}`).toString('base64')}`;
  const auth = ['-c', `http.extraheader=${authHeader}`];

  if (existsSync(barePath)) {
    await exec('git', ['--git-dir', barePath, 'remote', 'set-url', 'origin', plainUrl]);
    await exec('git', [...auth, '--git-dir', barePath, 'fetch', '--prune', 'origin']);
  } else {
    await exec('git', [...auth, 'clone', '--bare', plainUrl, barePath]);
    // Default `--bare` only fetches `refs/heads/<single>`; broaden so future
    // fetches mirror every remote head (matches `git clone` defaults).
    await exec('git', ['--git-dir', barePath, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
    await exec('git', [...auth, '--git-dir', barePath, 'fetch', '--prune', 'origin']);
  }

  const safeJobId = jobId.replace(/[^a-zA-Z0-9-]/g, '_');
  const branchName = `cezar/job-${safeJobId}`;
  const worktreeParent = worktreeParentFor(owner, repo);
  await mkdir(worktreeParent, { recursive: true });
  const worktreePath = join(worktreeParent, safeJobId);

  // `-B` (re)creates the branch even if it already exists, resetting it to
  // `origin/<baseBranch>` — important when a previous run left a stale ref.
  await exec('git', ['--git-dir', barePath, 'worktree', 'add', '-B', branchName, worktreePath, `origin/${baseBranch}`]);

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    try {
      await exec('git', ['--git-dir', barePath, 'worktree', 'remove', '--force', worktreePath]);
    } catch (err) {
      console.warn(`[runner] worktree remove failed for ${worktreePath}:`, err instanceof Error ? err.message : err);
    }
    try {
      await exec('git', ['--git-dir', barePath, 'branch', '-D', branchName]);
    } catch {
      // Branch may already be gone (e.g. `worktree remove` cleaned it up).
    }
  };

  return { worktreePath, branchName, cleanup };
}

/**
 * Walks every bare clone under `~/.cezar/runner-repos/*.git` and runs
 * `worktree prune` + `gc --auto`. Fire-and-forget — errors are logged but never
 * thrown. Called from the daemon idle loop.
 */
export async function maintainBareClones(): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(REPOS_DIR);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.endsWith('.git')) continue;
    const barePath = join(REPOS_DIR, name);
    try {
      await exec('git', ['--git-dir', barePath, 'worktree', 'prune']);
    } catch (err) {
      console.warn(`[runner] worktree prune failed for ${barePath}:`, err instanceof Error ? err.message : err);
    }
    try {
      await exec('git', ['--git-dir', barePath, 'gc', '--auto']);
    } catch (err) {
      console.warn(`[runner] gc --auto failed for ${barePath}:`, err instanceof Error ? err.message : err);
    }
  }
}
