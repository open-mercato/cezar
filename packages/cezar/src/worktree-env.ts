import { execFile } from 'node:child_process';
import { copyFile, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ensureExcluded, resolveCommonGitDir } from './agent-config/seed.ts';

/**
 * Seed the project's gitignored env files into a run's worktree (spec
 * `.ai/specs/2026-10-10-worktree-env-seeding.md`).
 *
 * `git worktree add` gives a task the TRACKED files and nothing else, so a project whose
 * `.env` is gitignored — every project that has one — gets a worktree in which nothing that
 * talks to a database, a payment provider or a mail service can start, and the failure reads
 * like a bug in the code. The files already sit in the main checkout; this copies them across.
 *
 * WHAT COUNTS: a regular file named `.env` or `.env.<anything>` that git reports as IGNORED in
 * the main checkout. Asking git, rather than matching names, is what keeps a tracked
 * `.env.example` or `.env.test` out — the worktree already has those, at the branch's own
 * version. It is also the zero-config half: no list to author, the repo's own ignore rules say
 * which files are the machine's.
 *
 * WHAT IT WILL NOT DO:
 *  - overwrite a file the worktree already has. A reused worktree's env may have been rewritten
 *    on purpose (a per-task port, a per-task database), and a copy from the main checkout would
 *    silently point the task back at the shared stack.
 *  - leave a secret where a commit can pick it up. Every autosave is `git add -A`; a copy that
 *    is not ignored IN THE WORKTREE (its branch may predate the ignore rule) is excluded through
 *    the shared `info/exclude`, and removed again if even that does not hide it.
 *
 * Copies, never links: a symlink would make an edit in one task's tree an edit in every tree.
 * Never throws — a seed failure must not fail the run.
 */

/** Directories never descended into: dependency and build trees, where a `.env` is a package's
 *  fixture rather than the project's configuration, and where the walk would spend its budget. */
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.yarn', '.pnpm-store', 'vendor', 'dist', 'build', 'out', 'target',
  'coverage', '.next', '.nuxt', '.turbo', '.cache', '.venv', 'venv', '__pycache__',
]);

/** Deep enough for `apps/<app>/.env` and `packages/<pkg>/.env` with room to spare. */
const MAX_DEPTH = 6;
/** A walk that has opened this many directories is in a tree it was not meant for. */
const MAX_DIRS = 4000;
const MAX_FILES = 64;
/** An env file is text a human edits. Anything larger is something else wearing the name. */
const MAX_BYTES = 1024 * 1024;

/** Default-on. `CEZ_WORKTREE_ENV=0` turns the copy off for a host where secrets must stay in
 *  the main checkout. */
export function worktreeEnvSeedEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CEZ_WORKTREE_ENV !== '0';
}

function isEnvFile(name: string): boolean {
  return name === '.env' || name.startsWith('.env.');
}

function git(cwd: string, args: string[], input?: string): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    const child = execFile('git', args, { cwd, encoding: 'utf8' }, (err, stdout) =>
      resolve({ ok: !err, stdout: stdout ?? '' }),
    );
    if (input !== undefined) {
      // A git that exits before reading everything must not take the process down with EPIPE.
      child.stdin?.on('error', () => {});
      child.stdin?.end(input);
    }
  });
}

/** Repo-relative, `/`-separated paths of every env-named file under `root`, tracked or not. */
async function findEnvFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  let opened = 0;
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (opened >= MAX_DIRS || found.length >= MAX_FILES) return;
    opened += 1;
    let entries;
    try {
      entries = await readdir(rel === '' ? root : join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    // A directory with its own `.git` is another checkout — a nested repository, or one of
    // cezar's own task worktrees under `.ai/cezar/worktrees`. Its env files are that tree's.
    if (rel !== '' && entries.some((entry) => entry.name === '.git')) return;
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isFile()) {
        if (isEnvFile(entry.name) && found.length < MAX_FILES) found.push(path);
      } else if (entry.isDirectory() && depth < MAX_DEPTH && !SKIP_DIRS.has(entry.name)) {
        await walk(path, depth + 1);
      }
    }
  };
  await walk('', 0);
  return found;
}

/** The subset git ignores in `cwd`. Tracked files are never reported — they are not subject to
 *  ignore rules — which is the property the seed relies on. */
async function ignoredAmong(cwd: string, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  // Exit 1 means "none of them", which is an answer rather than a failure; stdout says which.
  const result = await git(cwd, ['check-ignore', '-z', '--stdin'], `${paths.join('\0')}\0`);
  return result.stdout.split('\0').filter(Boolean);
}

async function isIgnored(cwd: string, path: string): Promise<boolean> {
  return (await git(cwd, ['check-ignore', '-q', '--', path])).ok;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** A path as an anchored `info/exclude` pattern that matches it and nothing else. */
function excludePattern(rel: string): string {
  return `/${rel.replace(/[\\*?[\]]/g, '\\$&')}`;
}

/**
 * Copy the main checkout's ignored env files into `worktreeCwd`. Returns the repo-relative
 * paths actually copied, for the caller's note — names only, never contents.
 */
export async function seedWorktreeEnvFiles(
  repoRoot: string,
  worktreeCwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  if (!worktreeEnvSeedEnabled(env) || worktreeCwd === repoRoot) return [];
  try {
    const commonGitDir = await resolveCommonGitDir(worktreeCwd);
    if (!commonGitDir) return [];
    const seeded: string[] = [];
    for (const rel of await ignoredAmong(repoRoot, await findEnvFiles(repoRoot))) {
      const src = join(repoRoot, rel);
      const dest = join(worktreeCwd, rel);
      try {
        const info = await lstat(src);
        if (!info.isFile() || info.size > MAX_BYTES || (await exists(dest))) continue;
        await mkdir(dirname(dest), { recursive: true });
        await copyFile(src, dest);
        if (!(await isIgnored(worktreeCwd, rel))) {
          await ensureExcluded(commonGitDir, excludePattern(rel));
          if (!(await isIgnored(worktreeCwd, rel))) {
            await rm(dest, { force: true });
            continue;
          }
        }
        seeded.push(rel);
      } catch {
        // Best-effort per file — but never leave a copy whose ignore state was not confirmed.
        await rm(dest, { force: true }).catch(() => {});
      }
    }
    return seeded;
  } catch {
    return [];
  }
}
