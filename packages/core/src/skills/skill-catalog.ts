import { readdir, readFile } from 'node:fs/promises';
import { join, resolve, basename, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Provenance of a discovered skill. Issue #262 expands this from the original
 * built-in/repo split to a five-source enum; PR 1 (this commit) wires up the
 * type and renames the existing `'repo'` value to `'workspace-repo'`. The other
 * source kinds become real in follow-up PRs:
 *   - 'built-in'      — shipped with Cezar (packages/core/skills/*.md)
 *   - 'workspace-repo'— the workspace's <repo>/.ai/skills/ (was: 'repo')
 *   - 'external-repo' — PR 2: an arbitrary owner/repo/folder added by the user
 *   - 'disk'          — PR 3: a markdown file uploaded directly into Cezar
 *   - 'skills-sh'     — PR 4: a skill installed from the skills.sh registry
 *
 * Overrides (workspace-scoped DB copies) are layered on top of any source at
 * consumer side; the catalog itself only enumerates origins.
 */
export type SkillSource = 'built-in' | 'workspace-repo' | 'external-repo' | 'disk' | 'skills-sh';

/**
 * Order in which sources win collisions on the same skill name (highest
 * priority first). The legacy `discoverSkills` only knows the first two; later
 * PRs use this priority to resolve cross-source collisions in their loaders.
 */
export const SKILL_SOURCE_PRIORITY: SkillSource[] = [
  'built-in',
  'workspace-repo',
  'external-repo',
  'disk',
  'skills-sh',
];

const KNOWN_SOURCES = new Set<string>(SKILL_SOURCE_PRIORITY);

/**
 * Bridge a raw, possibly-legacy `source` value onto the #262 vocabulary.
 * Pre-#262 `repo_skills` rows wrote `'repo'`; map it to `'workspace-repo'`.
 * Unknown / missing values fall back to `'workspace-repo'` — they self-heal
 * on the next `refreshRepoSkills` (which rewrites the cache with canonical
 * sources), so this is transitional rather than permanent. PR 2–4 loaders
 * reuse this bridge instead of re-implementing it per source kind.
 */
export function normalizeSkillSource(raw: unknown): SkillSource {
  if (raw === 'repo') return 'workspace-repo';
  return typeof raw === 'string' && KNOWN_SOURCES.has(raw)
    ? (raw as SkillSource)
    : 'workspace-repo';
}

export interface Skill {
  name: string;
  description?: string;
  body: string;
  path: string;
  suggestedStages: string[];
  source: SkillSource;
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
async function readMarkdownSkills(dir: string, source: Skill['source']): Promise<Skill[]> {
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
    const { frontmatter, body } = parseFrontmatter(raw, absPath);
    const name =
      typeof frontmatter.name === 'string' && frontmatter.name.trim()
        ? frontmatter.name.trim()
        : basename(rel, extname(rel));
    const description =
      typeof frontmatter.description === 'string' && frontmatter.description.trim()
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
export async function discoverSkills(repoRoot: string, skillsDir = '.ai/skills'): Promise<Skill[]> {
  const [builtin, repo] = await Promise.all([
    readMarkdownSkills(builtinSkillsDir(), 'built-in'),
    readMarkdownSkills(resolve(repoRoot, skillsDir), 'workspace-repo'),
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

/**
 * Issue #262 (PR 3) — public adapter around the internal `parseFrontmatter`
 * parser, used by GUI when ingesting markdown that didn't come through
 * `discoverSkills`. Pasting a skill into the upload modal or dropping a
 * `.md` file goes through this so the parsing rules stay identical to what
 * the dispatcher applies when reading skills off disk.
 *
 * `fallbackName` is consulted only when the markdown's frontmatter omits a
 * `name:` field — typically the filename (without `.md`) for file uploads, or
 * a user-supplied label when pasting raw text.
 */
export interface ParsedSkillMarkdown {
  name: string | null;
  description?: string;
  suggestedStages: string[];
  body: string;
}

export function parseSkillMarkdown(raw: string, fallbackName?: string): ParsedSkillMarkdown {
  const { frontmatter, body } = parseFrontmatter(raw);
  const frontmatterName =
    typeof frontmatter.name === 'string' && frontmatter.name.trim()
      ? frontmatter.name.trim()
      : null;
  const description =
    typeof frontmatter.description === 'string' && frontmatter.description.trim()
      ? frontmatter.description.trim()
      : undefined;
  const suggestedStages = Array.isArray(frontmatter['cezar-stages'])
    ? frontmatter['cezar-stages'].filter((s): s is string => typeof s === 'string')
    : [];
  const name = frontmatterName ?? (fallbackName?.trim() ? fallbackName.trim() : null);
  return { name, description, suggestedStages, body };
}

/** Partition skills by whether their `suggestedStages` includes `stageId`. */
export function skillsForStage(
  skills: Skill[],
  stageId: string,
): { suggested: Skill[]; others: Skill[] } {
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
function parseFrontmatter(
  raw: string,
  sourcePath?: string,
): { frontmatter: Record<string, FrontmatterValue>; body: string } {
  // Normalize CRLF AND lone CR (legacy-Mac line endings) — otherwise a file
  // with `\r`-only newlines fails `text.startsWith('---\n')`, frontmatter is
  // silently dropped, and the whole document ends up dumped into `body`.
  const text = raw.replace(/\r\n?/g, '\n');
  if (!text.startsWith('---\n')) return { frontmatter: {}, body: raw };

  // Match the closing delimiter only on its own line (`\n---\n`, or `\n---` at
  // EOF) so a `---` thematic break inside the body doesn't terminate the block
  // early.
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
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) {
      const where = sourcePath ? `${sourcePath}: ` : '';
      console.warn(`[skill-catalog] ${where}unrecognised frontmatter line: ${line}`);
      continue;
    }
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
