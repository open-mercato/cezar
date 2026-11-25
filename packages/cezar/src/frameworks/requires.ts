import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import type { FrameworkFile } from '@open-mercato/cezar-contract';
import { chooseForkBase } from '../git-worktree.ts';
import { getRepoInfo } from '../server/git.ts';

/**
 * What a framework needs on a card's branch (`requires`, default `detect`). Cards fork their
 * worktree from the base ref, so a file present only in the main checkout is invisible to them:
 * creation checks the ref, every stage entry checks the worktree. Never throws.
 */

export function frameworkRequires(fw: FrameworkFile): string[] {
  return [...(fw.requires ?? fw.detect ?? [])];
}

/** Repo-relative and inside the repo; anything else is never "present". */
function safePath(path: string): string | null {
  const p = normalize(path).replace(/\\/g, '/').replace(/\/+$/, '');
  if (!p || p === '.' || isAbsolute(p) || p.startsWith('../') || p === '..') return null;
  return p;
}

function catFileExists(repoRoot: string, ref: string, path: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('git', ['cat-file', '-e', `${ref}:${path}`], { cwd: repoRoot, timeout: 10_000 }, (err) => resolve(!err));
  });
}

/** The required paths `ref` does not carry (`git cat-file -e <ref>:<path>`). */
export async function missingOnRef(repoRoot: string, ref: string, paths: readonly string[]): Promise<string[]> {
  if (ref.startsWith('-')) return [...paths];
  const present = await Promise.all(paths.map((p) => {
    const safe = safePath(p);
    return safe ? catFileExists(repoRoot, ref, safe) : Promise.resolve(false);
  }));
  return paths.filter((_, i) => !present[i]);
}

/** The required paths missing from a working tree (a card's worktree). */
export function missingInTree(dir: string, paths: readonly string[]): string[] {
  return paths.filter((p) => {
    const safe = safePath(p);
    return !safe || !existsSync(join(dir, safe));
  });
}

/** Creation refused (409): names the ref, the missing paths, and whether they are only uncommitted. */
export function notInstalledOnRefMessage(frameworkName: string, ref: string, missing: readonly string[], checkoutRoot: string): string {
  const uncommitted = missing.length > 0 && missingInTree(checkoutRoot, missing).length === 0;
  const where = uncommitted ? `${frameworkName} is present in the checkout but not committed on ${ref}` : `${frameworkName} is not installed on ${ref}`;
  return `${where} — cards fork from ${ref}, so ${uncommitted ? 'commit it there' : 'install and commit it there'} first (missing: ${missing.join(', ')})`;
}

/** A stage entry parked on it (`blocked.reason: 'precheck'`). */
export function missingInWorktreeDetail(missing: readonly string[], baseRef: string | undefined): string {
  const ref = baseRef ?? 'the base branch';
  return `this card's branch is missing framework files: ${missing.join(', ')} — merge or rebase ${ref} into this card's branch, or cancel and create a new card`;
}

/** The ref a new card forks from — `chooseForkBase`, exactly as the run start resolves it. Null
 *  outside a git repo. `fetch: false` for a preview (`GET /frameworks`): no network per request. */
export async function cardForkBase(repoRoot: string, configured: string | undefined, opts: { fetch?: boolean } = {}): Promise<string | null> {
  const repo = await getRepoInfo(repoRoot);
  if (!repo) return null;
  return chooseForkBase(repoRoot, repo.branch, configured, () => {}, opts);
}
