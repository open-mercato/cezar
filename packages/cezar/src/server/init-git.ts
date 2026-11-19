import { appendFile, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { dryRunCommandRunner, spawnCommandRunner, type CommandResult, type CommandRunner } from './create-project.ts';
import { PRIVACY_PROTECTED_HOME_DIRS } from './fs-browse.ts';

/**
 * `POST /api/v1/projects/:projectId/git-init` (spec 2026-10-26-first-run-onboarding): make a
 * `not-git` folder a repository. The existing files are committed, not left untracked — task
 * worktrees branch from HEAD, so an empty initial commit would hand every agent an empty tree.
 * Nothing is pushed and no remote is added.
 */

const INITIAL_BRANCH = 'main';

/**
 * Written only when the folder has no `.gitignore` of its own: the first commit takes every file
 * in the folder, and installed dependencies or an `.env` with secrets must not be among them —
 * least of all on the way to "Publish to GitHub".
 */
export const DEFAULT_GITIGNORE = ['node_modules/', '.env', '.env.*', '!.env.example', '.DS_Store', '*.log', ''].join('\n');

/**
 * Also written to `.git/info/exclude` of every repository this route creates, whatever
 * `.gitignore` the folder already has: a project's own `.gitignore` that forgets `.env` must not
 * let `git add -A` commit secrets (and "Publish to GitHub" push them). Local to this clone, shared
 * by its task worktrees, never committed.
 */
export const LOCAL_EXCLUDES = ['', '# cezar: keep secrets and installed dependencies out of the first commit', 'node_modules/', '.env', '.env.*', '!.env.example', ''].join('\n');

/** Plain words for the one commit failure a first-time user meets: git does not know them yet. */
export const GIT_IDENTITY_MISSING =
  'Git needs your name and email before the first commit. Run these two commands in Terminal, then try again:\n' +
  'git config --global user.name "Your Name"\n' +
  'git config --global user.email you@example.com';

export type InitGitResult =
  | { ok: true; branch: string }
  | { ok: false; status: 409 | 500; error: string };

export async function initGitInFolder(opts: {
  root: string;
  run?: CommandRunner;
  signal?: AbortSignal;
  /** The user's home folder; tests pass their own. */
  home?: string;
}): Promise<InitGitResult> {
  const refusal = unsafeRoot(await realOrSame(opts.root), await realOrSame(opts.home ?? homedir()));
  if (refusal) return { ok: false, status: 409, error: refusal };
  const gitDir = join(opts.root, '.git');
  if (await exists(gitDir)) return { ok: false, status: 409, error: `already a git repository: ${opts.root}` };

  const run = opts.run ?? (process.env.CEZ_DRY_RUN === '1' ? dryRunCommandRunner : spawnCommandRunner);
  const exec = async (args: string[]): Promise<CommandResult> => {
    try {
      return await run('git', args, { cwd: opts.root, signal: opts.signal });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  const init = await exec(['init', '-b', INITIAL_BRANCH]);
  if (!init.ok) return { ok: false, status: 500, error: `git init failed: ${firstLine(init.error)}` };

  // Only the `.git` this call created is removed on a later failure, so a retry starts clean
  // instead of meeting "already a git repository" over a repo with no commit.
  const undo = async (error: string): Promise<InitGitResult> => {
    await rm(gitDir, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, status: 500, error };
  };
  try {
    await mkdir(join(gitDir, 'info'), { recursive: true });
    await appendFile(join(gitDir, 'info', 'exclude'), LOCAL_EXCLUDES, 'utf8');
  } catch (err) {
    return undo(`could not write .git/info/exclude: ${err instanceof Error ? err.message : String(err)}`);
  }
  const gitignore = join(opts.root, '.gitignore');
  if (!(await exists(gitignore))) {
    try {
      await writeFile(gitignore, DEFAULT_GITIGNORE, 'utf8');
    } catch (err) {
      return undo(`could not write .gitignore: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const add = await exec(['add', '-A']);
  if (!add.ok) return undo(`git add failed: ${firstLine(add.error)}`);
  const commit = await exec(['commit', '--allow-empty', '-m', 'Initial commit']);
  if (!commit.ok) {
    if (/Please tell me who you are|Author identity unknown|empty ident name/i.test(commit.error)) return undo(GIT_IDENTITY_MISSING);
    return undo(`the initial commit failed: ${firstLine(commit.error)}`);
  }
  return { ok: true, branch: INITIAL_BRANCH };
}

/**
 * A repository is a project, never a whole home folder, a disk, or one of the folders macOS
 * guards (Documents, Desktop…): `git add -A` there would sweep up everything the user owns.
 */
function unsafeRoot(root: string, home: string): string | null {
  const target = resolve(root);
  const homeDir = resolve(home);
  if (target === parse(target).root) return 'cezar will not make a whole disk a git repository. Pick a project folder instead.';
  if (target === homeDir || homeDir.startsWith(`${target}/`)) {
    return 'cezar will not make your home folder a git repository. Pick a project folder instead.';
  }
  if (dirname(target) === homeDir && PRIVACY_PROTECTED_HOME_DIRS.has(target.slice(homeDir.length + 1))) {
    return `cezar will not make your ${target.slice(homeDir.length + 1)} folder a git repository. Pick a project folder inside it instead.`;
  }
  return null;
}

/** The path with every symlink resolved — a project registered through a link to `$HOME` is
 *  still `$HOME`. A path that cannot be resolved is compared as given. */
async function realOrSame(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? text;
}
