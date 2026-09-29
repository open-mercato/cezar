/**
 * Finding cezar's OWN checkouts — the worktrees a developer might want the desktop app (or the
 * `cezar` launcher) to run instead of a published release. Nothing to configure: every
 * registered project whose tree holds the `@open-mercato/cezar` package is a cezar repo, and
 * `git worktree list` in it names every task branch cezar (or the developer) checked out. A
 * worktree is switchable once it is built (`dist/index.js` and the cockpit's `web/dist`); the
 * switch itself is `linkCheckout` in layout.ts.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
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
 * that was never registered but was linked once keeps showing its siblings). Newest-looking
 * first is not knowable cheaply; the order is the registry's, then git's.
 */
export async function discoverCheckouts(env: NodeJS.ProcessEnv = process.env): Promise<CezarCheckout[]> {
  const config = await loadWorkspaceConfig(workspaceConfigPath(env));
  const links = listLinks(env);
  const roots = [...config.projects.map((project) => project.root), ...links.map((link) => link.checkout).filter((p): p is string => !!p)];
  const seen = new Set<string>();
  const out: CezarCheckout[] = [];
  for (const root of roots) {
    if (!existsSync(root) || !cezarPackageRoot(root)) continue;
    for (const tree of await worktreesOf(root)) {
      const worktree = real(tree.path);
      if (seen.has(worktree)) continue;
      seen.add(worktree);
      const packageRoot = cezarPackageRoot(worktree);
      const version = packageRoot ? packageVersion(packageRoot) : null;
      if (!packageRoot || !version) continue;
      const branch = tree.branch ?? worktree.split(/[\\/]/).filter(Boolean).pop() ?? 'checkout';
      const link = links.find((entry) => entry.checkout === packageRoot);
      out.push({
        packageRoot,
        worktree,
        branch,
        version,
        built: isBuilt(packageRoot),
        id: link?.id ?? safeLinkId(version, branch),
        linked: !!link,
      });
    }
  }
  return out;
}

function safeLinkId(version: string, branch: string): string {
  try {
    return linkId(version, branch);
  } catch {
    return '';
  }
}
