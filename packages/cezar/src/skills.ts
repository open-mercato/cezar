import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, basename, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { gatedSkillsRepos } from './config.ts';
import { getTeamSkillsCached } from './skills-remote.ts';
import { readUiState } from './ui-state.ts';
import { builtinSkills } from './automations/builtin-skill.ts';
import type { RunnerId } from './core/agent-runner.ts';

/**
 * A skill is a Markdown file with optional YAML-ish frontmatter (`name`,
 * `description`). Discovered from the repo's `.ai/skills/` (shared with other
 * agent tooling), `.ai/cezar/skills/` (cez-local), the `npx skills` install
 * dirs (`.agents/skills` + the per-agent mirrors, project and global), and
 * the configured team skills repos (spec 005 — bare clones, no checkout).
 * Adapted from @cezar/core's skill-catalog.
 */
export interface Skill {
  name: string;
  description?: string;
  /** Advisory composer hint: untouched run-mode choices default to interactive, in-place execution. */
  interactive?: true;
  body: string;
  path: string;
  /** `builtin`: a skill cezar ships itself — the `create-cezar-automation` constant (spec
   *  2026-09-13-automations-from-prompt, only while automations are reachable) and the directory
   *  skills under the package's `skills/` (`change-impact`). Always listed last. */
  source: 'ai' | 'cezar' | 'agents' | 'global' | 'team' | 'builtin';
  /** A repo-local agent command, not a skill (spec 2026-11-05-project-slash-commands). */
  kind?: 'command';
  /** Commands only: every definition of this name, one per agent that ships it. */
  variants?: Array<{ runner: RunnerId; path: string }>;
  /** Team skills only: where the definition lives in its skills repo. */
  team?: {
    repo: string;
    ref: string;
    path: string;
    /** True for the `SKILL.md` convention — a whole directory (references/…). */
    dir: boolean;
    /** The exact commit `ref` resolved to when the skill was read (#428). */
    commit?: string;
  };
}

/* Precedence order — earlier dirs win name collisions. `npx skills` writes
   the canonical copy to `.agents/skills/<name>/SKILL.md` and mirrors it into
   each agent's dir (often as symlinks) — scanning them all and deduping by
   name yields exactly the union of unique skills.

   Exported for the drift guard in `test/unit/skill-dirs.test.ts` (#374): the
   cockpit's empty-state hint hand-copies this list into the bundle
   (`packages/web/src/components/skill-empty-hint.tsx`) because it runs in another
   process, so adding a dir here without updating the hint makes the hint lie.
   That test pins this list and says where to go. */
export const SKILL_DIRS: Array<{ dir: string; source: Skill['source'] }> = [
  { dir: '.ai/cezar/skills', source: 'cezar' },
  { dir: '.ai/skills', source: 'ai' },
  { dir: '.agents/skills', source: 'agents' },
  { dir: '.claude/skills', source: 'agents' },
  { dir: '.codex/skills', source: 'agents' },
  { dir: '.cursor/skills', source: 'agents' },
  { dir: '.opencode/skills', source: 'agents' },
];

/** Per-agent command dirs (spec-kit installs here), scanned flat after the skill dirs so a
 *  real skill of the same name wins. `.github/prompts` only counts `*.prompt.md`. */
export const COMMAND_DIRS: Array<{ dir: string; runner: RunnerId; suffix: '.md' | '.prompt.md' }> = [
  { dir: '.claude/commands', runner: 'claude', suffix: '.md' },
  { dir: '.codex/prompts', runner: 'codex', suffix: '.md' },
  { dir: '.cursor/commands', runner: 'cursor', suffix: '.md' },
  { dir: '.opencode/command', runner: 'opencode', suffix: '.md' },
  { dir: '.opencode/commands', runner: 'opencode', suffix: '.md' },
  { dir: '.github/prompts', runner: 'copilot', suffix: '.prompt.md' },
];

/* Deliberately `homedir()` and not `agentHomePaths().claude`: these do NOT follow an
   agent profile (`src/core/agent-profiles.ts`). A skill is CONTENT — a playbook — not
   identity, and a second Claude login is not a second skill library. `npx skills`, which
   writes the `~/.claude/skills` mirror, is profile-unaware for the same reason. */
/** The package's own `skills/` (spec 2026-10-22-html-artifacts-and-impact Q6): `../skills` from
 *  both `src/` (tsx) and `dist/` (the installed tarball). */
export const BUILTIN_SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url));

const GLOBAL_SKILL_DIRS: Array<{ dir: string; source: Skill['source'] }> = [
  { dir: join(homedir(), '.agents/skills'), source: 'global' },
  { dir: join(homedir(), '.claude/skills'), source: 'global' },
];

/**
 * Discover the merged skill catalog for a repo. Name collisions resolve
 * local-first: `.ai/cezar/skills` → `.ai/skills` → `.agents/skills` + agent
 * mirrors → global (`~/.agents/skills`, `~/.claude/skills`) → team repo
 * ("the user's repo is the source of truth"). Missing directories are fine —
 * an empty catalog is fully supported (steps fall back to their plain
 * prompt). Team skills come from the in-process cache; the first call starts
 * a background load so nothing here ever waits on the network. The built-in skills (the
 * `automations/builtin-skill.ts` constant, then the package's `skills/` directory) come LAST, so
 * every user-authored skill of the same name shadows them.
 *
 * Opt-out gate: skills from a *default* (vendor) skills repo — `open-mercato/skills`
 * for the zero-config majority, see `gatedSkillsRepos` — appear unless the user has
 * curated them away. `importedSkills` in this repo's `.ai/cezar/ui-state.json` is a tri-state:
 * ABSENT means "not curated" and every default skill shows unless an older workspace-level
 * selection exists (readUiState supplies that as a compatibility fallback); a PRESENT array
 * (even `[]`) means the project has taken control and only those names show. A repo that sets
 * its own `skillsRepos` gates nothing regardless. This is the
 * single chokepoint, so the decision is identical for every consumer — catalog, composer
 * picker, planner, runner.
 */
export async function discoverSkills(
  repoRoot: string,
  builtinDir: string = BUILTIN_SKILLS_DIR,
): Promise<Skill[]> {
  const [lists, gatedRepos, uiState, bundled] = await Promise.all([
    readLocalLists(repoRoot),
    gatedSkillsRepos(repoRoot),
    readUiState(repoRoot),
    readMarkdownSkills(builtinDir, 'builtin'),
  ]);
  const teamSkills = filterImportedTeamSkills(
    getTeamSkillsCached(repoRoot),
    gatedRepos,
    readImportedSkills(uiState),
  );
  const merged = mergeByName([...lists, teamSkills, builtinSkills(), bundled]);
  merged.sort((a, b) => a.name.localeCompare(b.name));
  return merged;
}

/** The repo's and the user's own skill files, read from disk only: unlike `discoverSkills`, it
 *  never starts a team-repo clone or fetch (the daily `feature_inventory` reads every project). */
export async function discoverLocalSkills(repoRoot: string): Promise<Skill[]> {
  return mergeByName(await readLocalLists(repoRoot));
}

/** Skill dirs (project, then global), then the command dirs — a skill shadows a same-named command. */
function readLocalLists(repoRoot: string): Promise<Skill[][]> {
  return Promise.all([
    ...SKILL_DIRS.map(({ dir, source }) => readMarkdownSkills(resolve(repoRoot, dir), source)),
    ...GLOBAL_SKILL_DIRS.map(({ dir, source }) => readMarkdownSkills(dir, source)),
    ...COMMAND_DIRS.map(({ dir, runner, suffix }) => readCommandSkills(resolve(repoRoot, dir), runner, suffix)),
  ]);
}

/** One entry per name, first seen wins (a real skill replaces a command); a later command of the same name only adds its `variants`. */
function mergeByName(lists: readonly Skill[][]): Skill[] {
  const byName = new Map<string, Skill>();
  for (const skill of lists.flat()) {
    const existing = byName.get(skill.name);
    if (!existing) byName.set(skill.name, skill);
    // A team or built-in skill still beats a repo command of the same name.
    else if (existing.kind === 'command' && skill.kind !== 'command') byName.set(skill.name, skill);
    else if (existing.kind === 'command' && skill.kind === 'command') {
      existing.variants = [...(existing.variants ?? []), ...(skill.variants ?? [])];
    }
  }
  return [...byName.values()];
}

/**
 * The imported team-skill names from a raw `ui-state.json` object, as a tri-state:
 * `undefined` means the key is absent — "not curated", so every default skill shows
 * (the opt-out default that keeps existing installs whole); an array (even empty) is
 * the user's explicit selection. Defensive because the file is user-editable: a value
 * that is not an array degrades to `undefined` (keep all — the safe, backward-compatible
 * reading), and non-string / empty entries inside an array are dropped rather than thrown on.
 */
export function readImportedSkills(uiState: Record<string, unknown>): string[] | undefined {
  const value = uiState.importedSkills;
  if (!Array.isArray(value)) return undefined;
  return value.filter((name): name is string => typeof name === 'string' && name.length > 0);
}

/**
 * The opt-out gate: keep every team skill whose repo is NOT gated (a repo with its own
 * configured `skillsRepos` — auto-loads everything). For skills from a gated default
 * (vendor) repo, `importedSkills === undefined` keeps them ALL (not curated — the
 * historical behavior), while a present array keeps only the named ones. Local skills
 * carry no `team` and are always kept. Pure so the gate is unit-testable without a
 * network clone (the gated set is a const default otherwise).
 */
export function filterImportedTeamSkills(
  teamSkills: readonly Skill[],
  gatedRepos: ReadonlySet<string>,
  importedSkills: readonly string[] | undefined,
): Skill[] {
  // Not curated → the full default catalog still appears (no upgrade break).
  if (importedSkills === undefined) return [...teamSkills];
  const imported = new Set(importedSkills);
  return teamSkills.filter(
    (skill) => !skill.team || !gatedRepos.has(skill.team.repo) || imported.has(skill.name),
  );
}

/**
 * Walk a skills dir for entrypoints, following directory symlinks. Once a
 * directory contains `SKILL.md`, it is one directory-based skill and its
 * supporting Markdown (for example `references/*.md`) is not scanned. Other
 * directories retain the legacy recursive `*.md` discovery behavior.
 */
async function skillEntryPaths(
  dir: string,
  depth: number,
  visited: Set<string>,
): Promise<string[]> {
  if (depth < 0) return [];
  let real: string;
  try {
    real = await realpath(dir);
  } catch {
    return []; // missing dir or dangling symlink
  }
  if (visited.has(real)) return [];
  visited.add(real);

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skillEntry = entries.find((entry) => entry.name === 'SKILL.md');
  if (skillEntry) {
    const skillPath = join(dir, skillEntry.name);
    try {
      if ((await stat(skillPath)).isFile()) return [skillPath];
    } catch {
      // A dangling or unreadable SKILL.md does not hide other valid entries.
    }
  }

  const paths: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    let isDir = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try {
        isDir = (await stat(path)).isDirectory(); // stat follows the link
      } catch {
        continue; // dangling symlink
      }
    }
    if (isDir) {
      paths.push(...(await skillEntryPaths(path, depth - 1, visited)));
    } else if (extname(entry.name).toLowerCase() === '.md') {
      paths.push(path);
    }
  }
  return paths;
}

async function readMarkdownSkills(dir: string, source: Skill['source']): Promise<Skill[]> {
  const paths = await skillEntryPaths(dir, 4, new Set());
  const skills: Skill[] = [];
  for (const absPath of paths) {
    let raw: string;
    try {
      raw = await readFile(absPath, 'utf8');
    } catch {
      continue;
    }
    const { frontmatter, body } = parseFrontmatter(raw);
    const base = basename(absPath, extname(absPath));
    // The `SKILL.md` convention names the skill after its directory.
    const fallback = base.toLowerCase() === 'skill' ? basename(dirname(absPath)) : base;
    const name =
      typeof frontmatter.name === 'string' && frontmatter.name.trim()
        ? frontmatter.name.trim()
        : fallback;
    const description =
      typeof frontmatter.description === 'string' && frontmatter.description.trim()
        ? frontmatter.description.trim()
        : undefined;
    const interactive = frontmatter.interactive === true || frontmatter.interactive === 'true' ? true : undefined;
    skills.push({ name, description, interactive, body, path: absPath, source });
  }
  return skills;
}

/** A command dir is flat: only files ending in `suffix`, named after the file minus it. */
async function readCommandSkills(dir: string, runner: RunnerId, suffix: '.md' | '.prompt.md'): Promise<Skill[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: Skill[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.toLowerCase().endsWith(suffix)) continue;
    const path = join(dir, entry.name);
    let raw: string;
    try {
      // fstat the handle we read from, so the check and the read see the same file (open follows symlinks).
      const handle = await open(path, 'r');
      try {
        if (!(await handle.stat()).isFile()) continue;
        raw = await handle.readFile('utf8');
      } finally {
        await handle.close();
      }
    } catch {
      continue;
    }
    const { frontmatter, body } = parseFrontmatter(raw);
    const name =
      typeof frontmatter.name === 'string' && frontmatter.name.trim()
        ? frontmatter.name.trim()
        : entry.name.slice(0, -suffix.length);
    const description =
      typeof frontmatter.description === 'string' && frontmatter.description.trim()
        ? frontmatter.description.trim()
        : undefined;
    skills.push({ name, description, body, path, source: 'agents', kind: 'command', variants: [{ runner, path }] });
  }
  return skills;
}

type FrontmatterValue = string | boolean | string[];

/**
 * Tiny purpose-built frontmatter parser — a leading `---\n … \n---\n` block
 * with `key: value` lines, `key: [a, b]` inline arrays and `key:` + `  - a`
 * block arrays. Deliberately not full YAML so we avoid a parser dependency
 * for skill files.
 */
export function parseFrontmatter(raw: string): {
  frontmatter: Record<string, FrontmatterValue>;
  body: string;
} {
  // Normalize CRLF and lone CR, and strip a UTF-8 BOM — otherwise frontmatter is silently dropped.
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!match) return { frontmatter: {}, body: raw };

  const block = match[1] ?? '';
  const body = text.slice(match[0].length);
  const legacy = parseLegacyFrontmatter(block);
  let parsed: unknown;
  try {
    parsed = parseYaml(block);
  } catch {
    return { frontmatter: legacy, body };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { frontmatter: legacy, body };
  }

  const frontmatter: Record<string, FrontmatterValue> = { ...legacy };
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string' || (key === 'interactive' && typeof value === 'boolean')) {
      frontmatter[key] = value;
    } else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      frontmatter[key] = value as string[];
    }
  }
  return { frontmatter, body };
}

function parseLegacyFrontmatter(block: string): Record<string, FrontmatterValue> {
  const frontmatter: Record<string, FrontmatterValue> = {};
  const lines = block.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1] as string;
    const rest = (m[2] ?? '').trim();

    if (rest === '') {
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1] ?? '')) {
        items.push(stripQuotes((lines[i + 1] ?? '').replace(/^\s*-\s+/, '').trim()));
        i++;
      }
      frontmatter[key] = items;
      continue;
    }

    if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim();
      frontmatter[key] = inner
        ? inner
            .split(',')
            .map((s) => stripQuotes(s.trim()))
            .filter((s) => s.length > 0)
        : [];
      continue;
    }

    frontmatter[key] = stripQuotes(rest);
  }

  return frontmatter;
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
