import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { PROJECT_TAGS_MAX, PROJECT_TAG_MAX_LENGTH } from '@open-mercato/cezar-contract';
import { forgeKindOfRemote, forgeWebRoot, type ForgeKind } from '../server/forge/index.ts';
import { getRepoInfo } from '../server/git.ts';
import {
  mergeWriteWorkspaceConfig,
  loadWorkspaceConfig,
  type WorkspaceProject,
} from './config.ts';

/**
 * Project registry operations over `~/.cezar/config.json` (spec
 * 2026-07-20-multi-project-workspace, "Project identity" + "Boot flow"):
 *
 * - `registerProject(root)` — realpath-normalize, dedupe by realpath, allocate
 *   a human-readable slug from `basename(root)`. Registration is additive and
 *   goes through the read-modify-write merge, so the worst race outcome
 *   between concurrent `cezar serve` processes is a lost `lastOpenedAt` bump —
 *   never a lost project.
 * - `listProjects()` — registry entries + a cheap per-root status/branch probe
 *   behind a short TTL cache, so a sidebar render never shells `git` N times.
 * - `removeProject(id)` — unregister only. It never touches any file inside
 *   the repo (a project's own state stays in `<repo>/.ai/cezar/`).
 */

/**
 * Slugs the allocator must never hand out: `default` is the reserved alias
 * for the boot project, the rest are the cockpit shell's own top-level path
 * segments. A repo named `default/` becomes `default-2` and can never shadow
 * the alias or a route.
 */
export const RESERVED_PROJECT_IDS: ReadonlySet<string> = new Set([
  'default',
  'new',
  'settings',
  'api',
  'p',
  'assets',
]);

/** Slug length cap — mirrors `PROJECT_ID_RE` (1 head char + up to 63 more). */
const SLUG_MAX = 64;

/**
 * `basename(root)` → slug base: lowercase, runs of `[^a-z0-9-]` become one
 * `-`, edge dashes trimmed so the result matches `^[a-z0-9][a-z0-9-]{0,63}$`.
 * A degenerate basename (e.g. `日本語/`) falls back to `project` rather than
 * ever escaping the slug shape.
 */
function slugBase(root: string): string {
  const base = basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX);
  return base || 'project';
}

/**
 * Allocate a unique slug for `root`: the slug base, deduplicated against
 * `taken` ids AND the reserved ids with a numeric suffix (`api`, `api-2`,
 * `api-3`, …). Suffixed candidates stay within the 64-char cap by truncating
 * the base, never the suffix.
 */
export function allocateProjectSlug(root: string, taken: Iterable<string>): string {
  const used = new Set<string>(RESERVED_PROJECT_IDS);
  for (const id of taken) used.add(id);
  const base = slugBase(root);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, SLUG_MAX - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * Realpath-normalize a root: resolves symlinks and drops trailing slashes, so
 * every spelling of the same directory dedupes to one registry entry. A path
 * that cannot be realpath'd (doesn't exist yet, unreadable) degrades to plain
 * `resolve()` — registration callers guard existence; this module never throws
 * over it.
 */
async function normalizeRoot(root: string): Promise<string> {
  try {
    return await realpath(root);
  } catch {
    return resolve(root);
  }
}

/** True when `path` sits inside a cezar task worktree (`…/.ai/cezar/worktrees/…`). */
function isInsideTaskWorktree(path: string): boolean {
  const marker = `${sep}.ai${sep}cezar${sep}worktrees${sep}`;
  return `${path}${sep}`.includes(marker);
}

/**
 * Registration guard (spec 2026-07-20-multi-project-workspace, "Boot flow"):
 * auto-registration is suppressed — the process still serves the folder
 * normally, it just doesn't pollute the registry — when the resolved
 * `repoRoot` is:
 *
 * - inside any `…/.ai/cezar/worktrees/…` path (task worktrees and nested
 *   `cez` invocations — the same nesting reality the `CEZ_TODOS_FILE=''`
 *   guard in `workflows/run.ts` acknowledges), checked on both the raw and
 *   realpath'd spelling so neither a symlinked prefix nor a literal one
 *   slips through; or
 * - the user's home directory itself (realpath-compared, so a symlinked
 *   `$HOME` still matches).
 */
export async function shouldRegisterProject(repoRoot: string): Promise<boolean> {
  const real = await normalizeRoot(repoRoot);
  if (isInsideTaskWorktree(real) || isInsideTaskWorktree(resolve(repoRoot))) return false;
  const home = await normalizeRoot(homedir());
  return real !== home;
}

/**
 * Register `root` in the workspace registry (idempotent). Known root (by
 * realpath) → bump its `lastOpenedAt` and return the existing entry, id and
 * all. Unknown → allocate a slug and append a new entry via merge-write.
 */
export async function registerProject(
  root: string,
  source: 'local' | 'checkout' = 'local',
): Promise<WorkspaceProject> {
  const real = await normalizeRoot(root);
  const now = new Date().toISOString();
  let entry: WorkspaceProject | undefined;
  await mergeWriteWorkspaceConfig((config) => {
    const existing = config.projects.find((p) => p.root === real);
    if (existing) {
      existing.lastOpenedAt = now;
      entry = existing;
      return;
    }
    entry = {
      id: allocateProjectSlug(real, config.projects.map((p) => p.id)),
      root: real,
      name: basename(real),
      addedAt: now,
      lastOpenedAt: now,
      source,
    };
    config.projects.push(entry);
  });
  // The mutator always runs, so `entry` is always set — this satisfies TS.
  if (!entry) throw new Error('registerProject: merge-write did not run the mutator');
  return entry;
}

/**
 * The ONE spelling rule for project tags — applied on every write, never on read.
 *
 * Trimmed, empties dropped, over-long ones truncated, deduped CASE-INSENSITIVELY (the first
 * spelling wins, so `Storefront` typed before `storefront` keeps its capital), capped at
 * `PROJECT_TAGS_MAX`, and sorted so two projects tagged with the same set store and render the
 * same list. Case-insensitive dedupe is what makes tags usable as a grouping key: `API` and `api`
 * grouping into two columns of the same thing is the whole failure this prevents.
 *
 * Returns `undefined` — never `[]` — for an empty result, because the registry stores nothing for
 * an untagged project and `delete entry.tags` is what the writers then do.
 */
export function normalizeProjectTags(tags: readonly string[] | null | undefined): string[] | undefined {
  if (!tags) return undefined;
  const bySpelling = new Map<string, string>();
  for (const raw of tags) {
    const tag = raw.trim().slice(0, PROJECT_TAG_MAX_LENGTH);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (!bySpelling.has(key)) bySpelling.set(key, tag);
    if (bySpelling.size >= PROJECT_TAGS_MAX) break;
  }
  const normalized = [...bySpelling.values()].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  );
  return normalized.length > 0 ? normalized : undefined;
}

export type ProjectStatus = 'ok' | 'missing' | 'not-git';

export interface ProjectListEntry extends WorkspaceProject {
  /** `missing` = root gone/unreadable; `not-git` = exists but no `.git`. */
  status: ProjectStatus;
  /** Current branch when cheaply available (omitted e.g. on an unborn HEAD). */
  branch?: string;
  /** Which forge the root's remote belongs to (#698) — classified from the
   *  remote URL alone, no `gh` probe. Omitted when there is no forge remote.
   *  The sidebar gates each project group's GitHub tab on this, instead of on
   *  the boot folder's health-level forge answer. */
  forge?: ForgeKind;
  /** The remote's web root (`https://github.com/owner/repo`), rebuilt from the
   *  parsed remote so it can never carry credentials. What lets a cross-project
   *  surface link a reference the run knows only by NUMBER — the global Tasks
   *  page has one row per project and so cannot use any single repo's base. */
  repoUrl?: string;
}

interface RootProbe {
  status: ProjectStatus;
  branch?: string;
  forge?: ForgeKind;
  repoUrl?: string;
}

/** Probe TTL — long enough to coalesce a burst of sidebar renders, short
 *  enough that a deleted repo shows as `missing` on the next real look. */
const PROBE_TTL_MS = 5_000;
const probeCache = new Map<string, { at: number; probe: RootProbe }>();

/** Test hook: drop cached probes so status changes are visible immediately. */
export function clearProjectProbeCache(): void {
  probeCache.clear();
}

async function computeProbe(root: string): Promise<RootProbe> {
  try {
    if (!(await stat(root)).isDirectory()) return { status: 'missing' };
  } catch {
    return { status: 'missing' };
  }
  try {
    // `.git` may be a dir (normal clone) or a file (worktree/submodule) —
    // a bare stat covers both without shelling out.
    await stat(join(root, '.git'));
  } catch {
    return { status: 'not-git' };
  }
  // Branch and forge are best-effort garnish: getRepoInfo never throws (null
  // on e.g. an unborn HEAD), and a repo without either is still status ok.
  const info = await getRepoInfo(root);
  const forge = forgeKindOfRemote(info?.remote);
  // Free: `getRepoInfo` already ran for the branch, and the remote is already parsed for `forge`.
  const repoUrl = forgeWebRoot(info?.remote);
  return {
    status: 'ok',
    ...(info?.branch ? { branch: info.branch } : {}),
    ...(forge ? { forge } : {}),
    ...(repoUrl ? { repoUrl } : {}),
  };
}

async function probeRoot(root: string): Promise<RootProbe> {
  const cached = probeCache.get(root);
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.probe;
  const probe = await computeProbe(root);
  probeCache.set(root, { at: Date.now(), probe });
  return probe;
}

/**
 * One root's `status` (+`branch`) through the same TTL cache `listProjects`
 * uses. Exported for `POST /api/projects` (step 4.2): the register route
 * answers with the freshly registered entry and must hand the cockpit the
 * SAME shape the list route does — one project, one shape, whichever route
 * produced it.
 */
export async function probeProjectStatus(
  root: string,
): Promise<Pick<ProjectListEntry, 'status' | 'branch' | 'forge' | 'repoUrl'>> {
  return probeRoot(root);
}

/**
 * Registry entries in stored order, each with its `status` (+`branch` when
 * available). Probes run concurrently and are TTL-cached per root. A
 * `missing` project is only ever *listed* — callers must never instantiate a
 * context for it.
 */
export interface ProjectListSelector {
  /** Return only this registry id without mutating or pruning other rows. */
  projectId: string;
}

export async function listProjects(selector?: ProjectListSelector): Promise<ProjectListEntry[]> {
  const config = await loadWorkspaceConfig();
  const projects = selector
    ? config.projects.filter((project) => project.id === selector.projectId)
    : config.projects;
  return Promise.all(
    projects.map(async (project) => ({ ...project, ...(await probeRoot(project.root)) })),
  );
}

/**
 * Remove `id` from the registry. Returns false when no such entry exists.
 * Pure unregistration: nothing inside the repo (worktrees, `.ai/cezar/`,
 * run history) is touched — re-registering the same root later gets a fresh
 * slug but finds all its state intact.
 */
export async function removeProject(id: string): Promise<boolean> {
  let removed = false;
  await mergeWriteWorkspaceConfig((config) => {
    const next = config.projects.filter((p) => p.id !== id);
    removed = next.length !== config.projects.length;
    config.projects = next;
  });
  return removed;
}
