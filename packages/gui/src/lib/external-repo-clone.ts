import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const exec = promisify(execFile);

/**
 * Issue #262 (PR 2) — external skill sources clone management.
 *
 * Workspace repos already live under `~/.cezar/repos/<owner>-<repo>/` (see
 * `lib/repo-clone.ts`). External skill repos go to a *separate* tree under
 * `~/.cezar/external-skills/<source_id>/`. Two reasons for the separate
 * namespace:
 *
 *   1. Lock domains stay disjoint. `withRepoLock` keys on owner/repo; an
 *      external repo that happens to share owner/repo with the workspace
 *      would otherwise serialize on the same key as the workspace's autofix
 *      runs.
 *   2. Different branches of the same repo can be added as separate sources
 *      without colliding on the working-tree dir.
 *
 * Source id is a UUID so collisions are impossible.
 */

const EXTERNAL_REPOS_DIR = join(homedir(), '.cezar', 'external-skills');

const externalLocks = new Map<string, Promise<void>>();

/**
 * Acquires the per-source working-tree lock and returns a release function.
 * Prefer {@link withExternalRepoLock} unless the locked region spans control
 * flow a callback can't wrap.
 */
export async function acquireExternalRepoLock(sourceId: string): Promise<() => void> {
  const prev = externalLocks.get(sourceId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  externalLocks.set(sourceId, prev.then(() => next, () => next));
  await prev.catch(() => {});
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
    if (externalLocks.get(sourceId) === next) externalLocks.delete(sourceId);
  };
}

/** Runs `fn` while holding the per-source lock. */
export async function withExternalRepoLock<T>(
  sourceId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const release = await acquireExternalRepoLock(sourceId);
  try {
    return await fn();
  } finally {
    release();
  }
}

export interface ExternalRepoConfig {
  owner: string;
  repo: string;
  branch: string;
}

/**
 * Ensures a shallow clone of the external repo exists at
 * `~/.cezar/external-skills/<sourceId>/`, fetching the configured branch.
 * Token is optional — public repos work without one. When provided, it's
 * wired into the HTTPS URL via the `x-access-token` GitHub auth convention.
 *
 * MUST be called inside {@link withExternalRepoLock} so a concurrent sync of
 * the same source doesn't race on the checkout.
 */
export async function ensureExternalRepoClone(
  sourceId: string,
  { owner, repo, branch }: ExternalRepoConfig,
  githubToken: string | null,
): Promise<string> {
  await mkdir(EXTERNAL_REPOS_DIR, { recursive: true });

  const repoDir = join(EXTERNAL_REPOS_DIR, sourceId);
  const cloneUrl = githubToken
    ? `https://x-access-token:${githubToken}@github.com/${owner}/${repo}.git`
    : `https://github.com/${owner}/${repo}.git`;

  if (existsSync(join(repoDir, '.git'))) {
    await exec('git', ['remote', 'set-url', 'origin', cloneUrl], { cwd: repoDir });
    await exec('git', ['fetch', 'origin'], { cwd: repoDir });
    await exec('git', ['checkout', branch], { cwd: repoDir }).catch(() =>
      exec('git', ['checkout', '-b', branch, `origin/${branch}`], { cwd: repoDir }),
    );
    await exec('git', ['reset', '--hard', `origin/${branch}`], { cwd: repoDir });
  } else {
    await exec('git', ['clone', '--depth', '50', '--branch', branch, cloneUrl, repoDir]);
  }

  return repoDir;
}

/**
 * Returns the HEAD commit sha of the cloned external repo (or null on
 * failure). Cheap — runs `git rev-parse HEAD` against the on-disk worktree.
 */
export async function readExternalRepoHead(sourceId: string): Promise<string | null> {
  const repoDir = join(EXTERNAL_REPOS_DIR, sourceId);
  try {
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: repoDir });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
