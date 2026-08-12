import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, basename, dirname, extname } from 'node:path';
import { gatedSkillsRepos } from './config.ts';
import { getTeamSkillsCached } from './skills-remote.ts';
import { readWorkspaceUiState } from './workspace/ui-state.ts';

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
  source: 'ai' | 'cezar' | 'agents' | 'global' | 'team';
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

/* Deliberately `homedir()` and not `agentHomePaths().claude`: these do NOT follow an
   agent profile (`src/core/agent-profiles.ts`). A skill is CONTENT — a playbook — not
   identity, and a second Claude login is not a second skill library. `npx skills`, which
   writes the `~/.claude/skills` mirror, is profile-unaware for the same reason. */
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
 * a background load so nothing here ever waits on the network.
 *
 * Opt-out gate: skills from a *default* (vendor) skills repo — `open-mercato/skills`
 * for the zero-config majority, see `gatedSkillsRepos` — appear unless the user has
 * curated them away. `importedSkills` in the GLOBAL `~/.cezar/ui-state.json` (not the
 * per-repo file — the selection describes the person and must not depend on the launch
 * directory, multi-project workspace) is a tri-state: ABSENT means "not curated" and
 * every default skill shows (the historical behavior — no upgrade break for existing
 * installs); a PRESENT array (even `[]`) means the user has taken control and only those
 * names show. A repo that sets its own `skillsRepos` gates nothing regardless. This is the
 * single chokepoint, so the decision is identical for every consumer — catalog, composer
 * picker, planner, runner.
 */
export async function discoverSkills(repoRoot: string): Promise<Skill[]> {
  const [lists, gatedRepos, uiState] = await Promise.all([
    Promise.all([
      ...SKILL_DIRS.map(({ dir, source }) => readMarkdownSkills(resolve(repoRoot, dir), source)),
      ...GLOBAL_SKILL_DIRS.map(({ dir, source }) => readMarkdownSkills(dir, source)),
    ]),
    gatedSkillsRepos(repoRoot),
    readWorkspaceUiState(),
  ]);
  const teamSkills = filterImportedTeamSkills(
    getTeamSkillsCached(repoRoot),
    gatedRepos,
    readImportedSkills(uiState),
  );
  const merged: Skill[] = [];
  const seen = new Set<string>();
  for (const skills of [...lists, teamSkills]) {
    for (const skill of skills) {
      if (seen.has(skill.name)) continue;
      seen.add(skill.name);
      merged.push(skill);
    }
  }
  merged.sort((a, b) => a.name.localeCompare(b.name));
  return merged;
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
    const interactive = frontmatter.interactive === 'true' ? true : undefined;
    skills.push({ name, description, interactive, body, path: absPath, source });
  }
  return skills;
}

type FrontmatterValue = string | string[];

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
  // Normalize CRLF and lone CR — otherwise frontmatter is silently dropped.
  const text = raw.replace(/\r\n?/g, '\n');
  if (!text.startsWith('---\n')) return { frontmatter: {}, body: raw };

  // Match the closing delimiter only on its own line so a `---` thematic
  // break inside the body doesn't terminate the block early.
  const end = text.indexOf('\n---\n', 4);
  const endAtEof = text.endsWith('\n---') ? text.length - 4 : -1;
  const closeAt = end === -1 ? endAtEof : end;
  if (closeAt === -1) return { frontmatter: {}, body: raw };

  const block = text.slice(4, closeAt);
  const afterDelimiter = end === -1 ? -1 : text.indexOf('\n', closeAt + 1);
  const body = afterDelimiter === -1 ? '' : text.slice(afterDelimiter + 1);

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

  return { frontmatter, body };
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
