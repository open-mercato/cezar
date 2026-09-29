/**
 * Finding cezar's OWN checkouts — the worktrees a developer might want the desktop app (or the
 * `cezar` launcher) to run instead of a published release. Nothing to configure: every
 * registered project whose tree holds the `@open-mercato/cezar` package is a cezar repo, and
 * `git worktree list` in it names every task branch cezar (or the developer) checked out. A
 * worktree is switchable once it is built (`dist/index.js` and the cockpit's `web/dist`); the
 * switch itself is `linkCheckout` in layout.ts.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { workspaceConfigPath } from '../paths.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { linkId, listLinks, PACKAGE_NAME } from './layout.ts';

const exec = promisify(execFile);

export interface CezarCheckout {
  /** The package root to link: `<worktree>/packages/cezar` (or the worktree itself for the
   *  single-package layout older branches have). */
  packageRoot: string;
  worktree: string;
  /** Branch name, or the worktree's directory name when HEAD is detached. */
  branch: string;
  version: string;
  built: boolean;
  /** The id this checkout has (when linked) or would get (when not yet). */
  id: string;
  linked: boolean;
  commit: { sha: string; subject: string; at: string } | null;
  builtAt: string | null;
  /** Built, but the last commit is newer than the build. */
  stale: boolean;
  /** The cezar task that owns the worktree, from the repo's own run index. */
  task: { id: string; title: string; status: string } | null;
}

function packageVersion(dir: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
    return pkg.name === PACKAGE_NAME && typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/** The cezar package root inside a checkout, or null when the tree is not cezar's. */
export function cezarPackageRoot(worktree: string): string | null {
  for (const dir of [join(worktree, 'packages', 'cezar'), worktree]) {
    if (packageVersion(dir)) return dir;
  }
  return null;
}

export function isBuilt(packageRoot: string): boolean {
  return existsSync(join(packageRoot, 'dist', 'index.js')) && existsSync(join(packageRoot, 'web', 'dist', 'index.html'));
}

/** When the server build was last written — the older of the two halves would be more honest,
 *  but `npm run build` writes both in one go and the server is what a restart picks up. */
function builtAtOf(packageRoot: string): string | null {
  try {
    return statSync(join(packageRoot, 'dist', 'index.js')).mtime.toISOString();
  } catch {
    return null;
  }
}

/** HEAD's sha, subject and commit time. Null when git cannot answer. */
async function lastCommit(worktree: string): Promise<{ sha: string; subject: string; at: string } | null> {
  try {
    const { stdout } = await exec('git', ['log', '-1', '--format=%h%x1f%cI%x1f%s'], { cwd: worktree, timeout: 5_000 });
    const [sha, at, subject] = stdout.trim().split('\x1f');
    return sha && at ? { sha, subject: subject ?? '', at: new Date(at).toISOString() } : null;
  } catch {
    return null;
  }
}

interface TaskRow {
  id: string;
  title: string;
  status: string;
  worktree: string | null;
  branch: string | null;
}

/** The display fields of a repo's run index (`.ai/cezar/runs.json`), read leniently: this is a
 *  label lookup, not the store — a row it cannot read is simply not a label. */
function tasksOf(root: string): TaskRow[] {
  try {
    const rows = JSON.parse(readFileSync(join(root, '.ai', 'cezar', 'runs.json'), 'utf8')) as unknown;
    if (!Array.isArray(rows)) return [];
    const str = (value: unknown) => (typeof value === 'string' && value ? value : null);
    return rows.flatMap((row: Record<string, unknown>) => {
      const id = str(row?.id);
      const title = str(row?.titleSummary) ?? str(row?.title) ?? str(row?.task);
      if (!id || !title) return [];
      const worktree = str(row.worktreePath);
      return [{ id, title, status: str(row.status) ?? 'unknown', worktree: worktree ? real(worktree) : null, branch: str(row.branch) }];
    });
  } catch {
    return [];
  }
}

/** `git worktree list --porcelain` → [path, branch]. Never throws: not a repo is no worktrees. */
async function worktreesOf(root: string): Promise<{ path: string; branch: string | null }[]> {
  try {
    const { stdout } = await exec('git', ['worktree', 'list', '--porcelain'], { cwd: root, timeout: 5_000, maxBuffer: 4 * 1024 * 1024 });
    const out: { path: string; branch: string | null }[] = [];
    for (const block of stdout.split(/\n\n+/)) {
      const path = /^worktree (.+)$/m.exec(block)?.[1];
      if (!path || /^prunable/m.test(block)) continue;
      const ref = /^branch (.+)$/m.exec(block)?.[1];
      out.push({ path, branch: ref ? ref.replace(/^refs\/heads\//, '') : null });
    }
    return out;
  } catch {
    return [];
  }
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The branch a single checkout is on (`link` from a terminal), else its directory name. */
export async function branchOf(worktree: string): Promise<string> {
  try {
    const { stdout } = await exec('git', ['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: worktree, timeout: 5_000 });
    if (stdout.trim()) return stdout.trim();
  } catch {
    // detached HEAD, or not a repo
  }
  return worktree.split(/[\\/]/).filter(Boolean).pop() ?? 'checkout';
}

/**
 * Every cezar checkout reachable from the project registry (and from existing links, so a repo
 * that was never registered but was linked once keeps showing its siblings), newest commit
 * first, each with what it takes to tell it apart: its task, its last commit, its build age.
 */
export async function discoverCheckouts(env: NodeJS.ProcessEnv = process.env): Promise<CezarCheckout[]> {
  const config = await loadWorkspaceConfig(workspaceConfigPath(env));
  const links = listLinks(env);
  const roots = [...config.projects.map((project) => project.root), ...links.map((link) => link.checkout).filter((p): p is string => !!p)];
  const seen = new Set<string>();
  const found: Omit<CezarCheckout, 'commit'>[] = [];
  for (const root of roots) {
    if (!existsSync(root) || !cezarPackageRoot(root)) continue;
    const trees = await worktreesOf(root);
    // Task worktrees live under the main checkout, whose run index names them.
    const tasks = trees.length > 0 ? tasksOf(trees[0]!.path) : [];
    for (const tree of trees) {
      const worktree = real(tree.path);
      if (seen.has(worktree)) continue;
      seen.add(worktree);
      const packageRoot = cezarPackageRoot(worktree);
      const version = packageRoot ? packageVersion(packageRoot) : null;
      if (!packageRoot || !version) continue;
      const branch = tree.branch ?? worktree.split(/[\\/]/).filter(Boolean).pop() ?? 'checkout';
      const link = links.find((entry) => entry.checkout === packageRoot);
      const task = tasks.find((row) => row.worktree === worktree) ?? (tree.branch ? tasks.find((row) => row.branch === tree.branch) : undefined);
      const built = isBuilt(packageRoot);
      found.push({
        packageRoot,
        worktree,
        branch,
        version,
        built,
        builtAt: built ? builtAtOf(packageRoot) : null,
        stale: false,
        task: task ? { id: task.id, title: task.title, status: task.status } : null,
        id: link?.id ?? safeLinkId(version, branch),
        linked: !!link,
      });
    }
  }
  const out = await Promise.all(
    found.map(async (checkout): Promise<CezarCheckout> => {
      const commit = await lastCommit(checkout.worktree);
      const stale = !!(checkout.builtAt && commit && commit.at > checkout.builtAt);
      return { ...checkout, commit, stale };
    }),
  );
  // Newest work first: that is the branch a developer is most likely reaching for.
  return out.sort((a, b) => (b.commit?.at ?? '').localeCompare(a.commit?.at ?? ''));
}

function safeLinkId(version: string, branch: string): string {
  try {
    return linkId(version, branch);
  } catch {
    return '';
  }
}
