import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, realpath, stat } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';

const exec = promisify(execFile);

export interface RepoInfo {
  root: string;
  branch: string;
  remote?: string;
}

export interface StatusEntry {
  status: string;
  path: string;
}

export interface LogEntry {
  hash: string;
  subject: string;
  author: string;
  when: string;
}

async function git(
  root: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd: root,
    maxBuffer: 10 * 1024 * 1024,
    env: options.env,
  });
  return stdout;
}

/** Null when repository metadata cannot be read. By default a failed remote read
 * still returns root/branch; identity-sensitive callers can require a successful
 * remote read (including successful discovery of an empty remote list). */
export async function getRepoInfo(
  dir: string,
  options: { requireRemoteRead?: boolean; allowUnborn?: boolean } = {},
): Promise<RepoInfo | null> {
  try {
    const root = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
    // Identity-only callers may inspect unborn repositories. Default callers (including
    // task isolation) still require a commit and use their existing null fallback.
    const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
      .catch((error: unknown) => {
        if (!options.allowUnborn) throw error;
        return git(root, ['symbolic-ref', '--short', 'HEAD']);
      })).trim();
    let remote: string | undefined;
    try {
      remote = (await git(root, ['remote', 'get-url', 'origin'])).trim() || undefined;
    } catch {
      // No remote named `origin` — fall back to the first configured remote,
      // so repos whose only remote is named e.g. `github` or `upstream` still
      // get forge detection. An empty list confirms a remote-less repo; a failed
      // command cannot establish that the remote was removed.
      try {
        const names = (await git(root, ['remote'])).split('\n').map((n) => n.trim()).filter(Boolean);
        if (names[0]) {
          remote = (await git(root, ['remote', 'get-url', names[0]])).trim() || undefined;
        }
      } catch {
        if (options.requireRemoteRead) return null;
      }
    }
    return { root, branch, remote };
  } catch {
    return null;
  }
}

/** Confirm ordinary non-Git directories separately from missing/unreadable roots,
 * broken Git metadata and failed commands. Never interpret an arbitrary null probe
 * as a removed remote: dashboard callers must retain their last known identity. */
export async function isNonRepositoryDirectory(dir: string): Promise<boolean> {
  let stoppedAtFilesystemBoundary = false;
  try {
    await git(dir, ['rev-parse', '--show-toplevel'], { env: { ...process.env, LC_ALL: 'C' } });
    return false;
  } catch (error) {
    const failure = error as { code?: unknown; stderr?: unknown };
    if (failure.code !== 128 || typeof failure.stderr !== 'string') return false;
    // Match on the stable substrings Git uses for "no repository found" across versions
    // rather than the full sentence, which can otherwise drift and silently reintroduce
    // the false "no remote" diagnosis this check exists to prevent.
    stoppedAtFilesystemBoundary = failure.stderr.includes('Stopping at filesystem boundary');
    if (!stoppedAtFilesystemBoundary && !failure.stderr.includes('not a git repository'))
      return false;
  }
  // Git can use the same diagnostic for a damaged .git directory. Only absence
  // of metadata is an ordinary unconfigured project; unreadable markers fail closed.
  try {
    let current = await realpath(dir);
    const device = stoppedAtFilesystemBoundary ? (await stat(current)).dev : undefined;
    const ceilings = new Set((process.env.GIT_CEILING_DIRECTORIES ?? '').split(delimiter));
    for (;;) {
      try {
        await lstat(join(current, '.git'));
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      }
      const parent = dirname(current);
      if (parent === current || ceilings.has(parent)) return true;
      // Match Git's discovery boundary: metadata on the containing filesystem
      // is unrelated to this project and must not turn absence into an error.
      if (device !== undefined && (await stat(parent)).dev !== device) return true;
      current = parent;
    }
  } catch {
    return false;
  }
}

/** The current commit, pinned as a full SHA. Null outside a repository or before its first commit. */
export async function getHeadCommit(root: string): Promise<string | null> {
  try {
    return (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim() || null;
  } catch {
    return null;
  }
}

export async function getStatus(root: string): Promise<StatusEntry[]> {
  const out = await git(root, ['status', '--porcelain']);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => ({ status: line.slice(0, 2).trim() || '??', path: line.slice(3) }));
}

/** Working-tree diff vs HEAD (staged + unstaged), capped for the GUI. */
export async function getDiff(root: string, cap = 400_000): Promise<string> {
  const diff = await git(root, ['diff', 'HEAD']);
  if (diff.length > cap) return `${diff.slice(0, cap)}\n… (diff truncated)`;
  return diff;
}

/** Local + origin branch names, deduped (origin/x counts as x), sorted.
 *  Feeds the Repo tab's base-branch picker. */
export async function getBranches(root: string): Promise<string[]> {
  const names = new Set<string>();
  try {
    const local = await git(root, ['branch', '--list', '--format=%(refname:short)']);
    for (const line of local.split('\n')) {
      const name = line.trim();
      if (name) names.add(name);
    }
  } catch {
    // no branches — empty list
  }
  try {
    const remote = await git(root, ['branch', '-r', '--list', '--format=%(refname:short)']);
    for (const line of remote.split('\n')) {
      const name = line.trim();
      if (!name || name.includes('HEAD')) continue;
      names.add(name.replace(/^origin\//, ''));
    }
  } catch {
    // no remotes — local only
  }
  return [...names].filter((n) => !n.startsWith('cez/')).sort((a, b) => a.localeCompare(b));
}

/** One commit — message + stat + patch — for the Repo view's expandable rows. */
export async function getCommit(root: string, sha: string, cap = 200_000): Promise<string> {
  if (!/^[0-9a-f]{4,40}$/i.test(sha)) return '(not a commit hash)';
  const out = await git(root, ['show', '--stat', '--patch', '--no-color', sha]);
  if (out.length > cap) return `${out.slice(0, cap)}\n… (diff truncated)`;
  return out;
}

export async function getLog(root: string, count = 20): Promise<LogEntry[]> {
  const out = await git(root, [
    'log',
    `-${count}`,
    '--pretty=format:%h%x1f%s%x1f%an%x1f%cr',
  ]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash = '', subject = '', author = '', when = ''] = line.split('\x1f');
      return { hash, subject, author, when };
    });
}
