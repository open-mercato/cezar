import { readdir, readFile } from 'node:fs/promises';
import { join, resolve, basename, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A discovered skill. `source` records provenance:
 *   - 'built-in' — shipped with Cezar (packages/core/skills/*.md)
 *   - 'repo'     — discovered from the workspace's <repo>/.ai/skills/
 *
 * Overrides (workspace-scoped DB copies) are layered on top of either source
 * at consumer side; the catalog itself only enumerates origins.
 */
export interface Skill {
  name: string;
  description?: string;
  body: string;
  path: string;
  suggestedStages: string[];
  source: 'built-in' | 'repo';
}

/**
 * Resolves the on-disk directory for Cezar's built-in skill catalog. The
 * directory ships alongside the package (`packages/core/skills/`), so we
 * walk up from this file's URL — same result whether we're running from
 * `src/` under tsx or from `dist/` after a build.
 */
function builtinSkillsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // here = <core>/dist/skills (built) or <core>/src/skills (dev). Either way,
  // the built-in catalog lives at <core>/skills.
  return resolve(here, '..', '..', 'skills');
}

/**
 * Recursively discover `**\/*.md` skills under a directory. Missing /
 * unreadable directory ⇒ `[]`. Used internally by `discoverSkills`.
 */
async function readMarkdownSkills(
  dir: string,
  source: Skill['source'],
): Promise<Skill[]> {
  let entries: string[];
  try {
    entries = await readdir(dir, { recursive: true });
  } catch {
    return [];
  }

  const mdFiles = entries.filter((rel) => extname(rel).toLowerCase() === '.md');
  const skills: Skill[] = [];
  for (const rel of mdFiles) {
    const absPath = join(dir, rel);
    let raw: string;
    try {
      raw = await readFile(absPath, 'utf8');
    } catch {
      continue;
    }
    const { frontmatter, body } = parseFrontmatter(raw);
    const name = typeof frontmatter.name === 'string' && frontmatter.name.trim()
      ? frontmatter.name.trim()
      : basename(rel, extname(rel));
    const description = typeof frontmatter.description === 'string' && frontmatter.description.trim()
      ? frontmatter.description.trim()
      : undefined;
    const suggestedStages = Array.isArray(frontmatter['cezar-stages'])
      ? frontmatter['cezar-stages'].filter((s): s is string => typeof s === 'string')
      : [];
    skills.push({ name, description, body, path: absPath, suggestedStages, source });
  }
  return skills;
}

/**
 * Discover the merged skill catalog for a workspace: built-in skills shipped
 * with Cezar plus any `**\/*.md` files in `<repoRoot>/<skillsDir>`. Repo
 * skills take precedence when names collide.
 *
 * Empty repo skills dir is fully supported — every action falls back to the
 * built-in catalog.
 */
export async function discoverSkills(
  repoRoot: string,
  skillsDir = '.ai/skills',
): Promise<Skill[]> {
  const [builtin, repo] = await Promise.all([
    readMarkdownSkills(builtinSkillsDir(), 'built-in'),
    readMarkdownSkills(resolve(repoRoot, skillsDir), 'repo'),
  ]);

  // Repo skills win on name collisions; built-in fills the gaps.
  const repoNames = new Set(repo.map((s) => s.name));
  const merged = [...repo, ...builtin.filter((s) => !repoNames.has(s.name))];
  merged.sort((a, b) => a.name.localeCompare(b.name));
  return merged;
}

/**
 * Module-scoped cache of the built-in catalog. The built-in skills ship with
 * the package and only change on deploy, so we read+parse them once per
 * process and reuse the result across every triage pass / cron sweep. Set
 * `CEZAR_SKILLS_NOCACHE=1` to bypass the cache for dev iteration.
 */
let builtinCache: Promise<Skill[]> | null = null;

/**
 * Discover ONLY the built-in catalog. Useful for seeding actions on initial
 * workspace creation, before any repo has been cloned.
 *
 * The result is cached at module scope — the built-in catalog is bundled with
 * the package and never changes at runtime, so re-reading every `.md` file on
 * every call is pure overhead.
 */
export function discoverBuiltinSkills(): Promise<Skill[]> {
  if (process.env.CEZAR_SKILLS_NOCACHE === '1') {
    return loadBuiltinSkills();
  }
  if (!builtinCache) {
    // On a transient failure we don't want to pin a rejected promise forever.
    builtinCache = loadBuiltinSkills().catch((err) => {
      builtinCache = null;
      throw err;
    });
  }
  return builtinCache;
}

function loadBuiltinSkills(): Promise<Skill[]> {
  return readMarkdownSkills(builtinSkillsDir(), 'built-in').then((skills) =>
    skills.sort((a, b) => a.name.localeCompare(b.name)),
  );
}

/** Partition skills by whether their `suggestedStages` includes `stageId`. */
export function skillsForStage(skills: Skill[], stageId: string): { suggested: Skill[]; others: Skill[] } {
  const suggested: Skill[] = [];
  const others: Skill[] = [];
  for (const skill of skills) {
    (skill.suggestedStages.includes(stageId) ? suggested : others).push(skill);
  }
  return { suggested, others };
}

type FrontmatterValue = string | string[];

/**
 * Tiny purpose-built frontmatter parser — handles a leading `---\n … \n---\n`
 * block with `key: value` lines, `key: [a, b]` inline arrays, and `key:` then
 * `  - a` block arrays. Deliberately not a full YAML parser (no nesting, no
 * multi-line scalars) so we avoid a `js-yaml`/`gray-matter` dependency.
 */
function parseFrontmatter(raw: string): { frontmatter: Record<string, FrontmatterValue>; body: string } {
  const text = raw.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return { frontmatter: {}, body: raw };

  const end = text.indexOf('\n---', 4);
  if (end === -1) return { frontmatter: {}, body: raw };

  const block = text.slice(4, end);
  const afterDelimiter = text.indexOf('\n', end + 1);
  const body = afterDelimiter === -1 ? '' : text.slice(afterDelimiter + 1);

  const frontmatter: Record<string, FrontmatterValue> = {};
  const lines = block.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const rest = m[2].trim();

    if (rest === '') {
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
        items.push(stripQuotes(lines[i + 1].replace(/^\s*-\s+/, '').trim()));
        i++;
      }
      frontmatter[key] = items;
      continue;
    }

    if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim();
      frontmatter[key] = inner
        ? inner.split(',').map((s) => stripQuotes(s.trim())).filter((s) => s.length > 0)
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
