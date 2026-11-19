import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import type { RepoSuggestion, RepoSuggestionsResponse } from '@open-mercato/cezar-contract';
import { agentHomePaths, claudeStateFilePath } from '../paths.ts';
import { PRIVACY_PROTECTED_HOME_DIRS } from './fs-browse.ts';

/**
 * `GET /api/v1/fs/repos` (spec 2026-10-26-first-run-onboarding): the repositories the first-run
 * "Pick a project" list offers, most likely first — registered projects, folders Claude Code has
 * worked in (newest first, as Codex's own picker lists past projects), the checkout root, then a
 * two-level scan of the browse root.
 *
 * Never touches a macOS privacy-protected home folder on its own (the rule `fs-browse.ts` follows):
 * a protected path is only listed when it came from a registry or agent history, and is then not
 * stat'ed — reading it is what makes macOS ask for permission.
 */

const MAX_REPOS = 30;
const SCAN_STAT_BUDGET = 400;
const SKIPPED_NAMES = new Set(['node_modules', 'Applications']);
const NOISE_SEGMENTS = [`${sep}.ai${sep}cezar${sep}worktrees${sep}`, `${sep}.claude${sep}worktrees${sep}`, `${sep}Library${sep}`];

export interface RepoSuggestionInput {
  browseRoot: string;
  projectsDir: string;
  registered: ReadonlyArray<{ id: string; root: string; status: string }>;
  home?: string;
  claudeStateFile?: string;
}

export async function suggestRepositories(input: RepoSuggestionInput): Promise<RepoSuggestionsResponse> {
  const home = input.home ?? homedir();
  const root = await realpathOrNull(input.browseRoot);
  if (root === null) return { repos: [], truncated: false };

  const seen = new Set<string>();
  const repos: RepoSuggestion[] = [];
  let truncated = false;
  const offer = (path: string, projectId?: string): boolean => {
    if (repos.length >= MAX_REPOS) {
      truncated = true;
      return false;
    }
    const key = resolve(path);
    if (seen.has(key)) return true;
    seen.add(key);
    repos.push({ name: basename(key), path: key, ...(projectId ? { projectId } : {}) });
    return true;
  };
  const registeredId = new Map(input.registered.map((project) => [resolve(project.root), project.id]));
  const allowed = (path: string): boolean =>
    isAbsolute(path) && contains(root, resolve(path)) && resolve(path) !== resolve(home) && !NOISE_SEGMENTS.some((s) => path.includes(s));
  const isProtected = (path: string): boolean => {
    const homeReal = resolve(home);
    if (!contains(homeReal, path) || path === homeReal) return false;
    const first = path.slice(homeReal.length + 1).split(sep)[0] ?? '';
    return PRIVACY_PROTECTED_HOME_DIRS.has(first);
  };
  const isRepo = async (path: string): Promise<boolean> => (isProtected(path) ? true : exists(join(path, '.git')));

  for (const project of input.registered) {
    if (project.status === 'ok' && allowed(project.root)) offer(project.root, project.id);
  }

  for (const path of await claudeProjectPaths(input.claudeStateFile)) {
    if (!allowed(path) || !(await isRepo(path))) continue;
    if (!offer(path, registeredId.get(resolve(path)))) break;
  }

  let budget = SCAN_STAT_BUDGET;
  const scan = async (dir: string, depth: number): Promise<void> => {
    if (budget <= 0 || truncated || isProtected(dir)) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (budget <= 0 || truncated) return;
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIPPED_NAMES.has(entry.name)) continue;
      const child = join(dir, entry.name);
      if (!allowed(child) || isProtected(child)) continue;
      budget -= 1;
      if (await exists(join(child, '.git'))) {
        if (!offer(child, registeredId.get(resolve(child)))) return;
      } else if (depth > 1) {
        await scan(child, depth - 1);
      }
    }
  };
  const projectsDir = await realpathOrNull(input.projectsDir);
  if (projectsDir !== null && projectsDir !== root) await scan(projectsDir, 1);
  await scan(root, 2);

  return { repos, truncated };
}

/** Folders Claude Code has opened, newest first (its `projects` map is insertion-ordered). Only
 *  the keys are read; a missing or unreadable file is simply no history. */
async function claudeProjectPaths(stateFile?: string): Promise<string[]> {
  const file = stateFile ?? claudeStateFilePath(agentHomePaths().claude);
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return [];
    const projects = (parsed as { projects?: unknown }).projects;
    if (typeof projects !== 'object' || projects === null) return [];
    return Object.keys(projects).reverse();
  } catch {
    return [];
  }
}

function contains(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
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
