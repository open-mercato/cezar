import { copyFile, cp, lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { parseFrontmatter, type Skill } from './skills.ts';
import { excludeFromGit, materializedSkillContent, materializeSkillDir } from './skills-remote.ts';
import { reportError } from './telemetry.ts';

/**
 * Install a task's selected skill — and every catalog skill it names, transitively — into the
 * run's working directory, where the agent's own skill lookup finds it.
 *
 * A task worktree is a fresh checkout: the `npx skills` install dirs are gitignored, global
 * `~/.agents/skills` is invisible to Claude, and team skills live only in cezar's bare-clone
 * cache. So the agent answered "Unknown skill" for the selected skill, and a companion it runs
 * verbatim (`om-auto-review-pr` → `om-code-review`) was found nowhere.
 */

/** Claude Code (and OpenCode) read `.claude/skills`; Codex, Cursor and OpenCode read `.agents/skills`. */
export const PROVISION_SKILL_DIRS = ['.claude/skills', '.agents/skills'] as const;

/** Bound on one closure — a skill that names the whole catalog must not copy all of it. */
const MAX_CLOSURE = 24;

/** A skill name that is safe as one directory name (no separators, never `.`/`..`). */
const SAFE_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** True when `body` names `name` as a skill: hyphenated names by word, plain names only as `/name` or `` `name` ``. */
export function mentionsSkill(body: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = name.includes('-')
    ? `(?<![A-Za-z0-9_.-])${escaped}(?![A-Za-z0-9_-])`
    : `(?:/${escaped}|\`${escaped}\`)(?![A-Za-z0-9_-])`;
  return new RegExp(pattern).test(body);
}

/** The roots plus every catalog skill their bodies name, transitively (roots first, bounded). */
export function skillClosure(roots: readonly Skill[], catalog: readonly Skill[]): Skill[] {
  const out: Skill[] = [];
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length && out.length < MAX_CLOSURE) {
    const skill = queue.shift()!;
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    out.push(skill);
    for (const candidate of catalog) {
      if (!seen.has(candidate.name) && mentionsSkill(skill.body, candidate.name)) queue.push(candidate);
    }
  }
  return out;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function skillMarkdown(skill: Skill): string {
  const front = [`name: ${JSON.stringify(skill.name)}`];
  if (skill.description) front.push(`description: ${JSON.stringify(skill.description)}`);
  return `---\n${front.join('\n')}\n---\n\n${skill.body.trim()}\n`;
}

/** First line of the `.gitignore` cezar owns inside a worktree's skills dir. */
const IGNORE_MARK = '# cezar: skills installed for this task, not part of the repository';

/**
 * Keep `<skillsDir>/<name>` out of git in THIS worktree only. The shared `info/exclude` would also
 * hide that path in the user's main checkout, so a self-ignoring `.gitignore` in the skills dir is
 * used instead — unless the repo has its own there, which is never edited.
 */
async function ignoreProvisioned(cwd: string, skillsDir: string, name: string): Promise<void> {
  const file = join(cwd, skillsDir, '.gitignore');
  let prev: string | undefined;
  try {
    prev = await readFile(file, 'utf8');
  } catch {
    // absent: cezar creates and owns it
  }
  if (prev !== undefined && !prev.startsWith(IGNORE_MARK)) return excludeFromGit(cwd, `${skillsDir}/${name}`);
  const lines = prev?.split('\n').filter(Boolean) ?? [IGNORE_MARK, '/.gitignore'];
  if (lines.includes(`/${name}`)) return;
  await writeFile(file, [...lines, `/${name}`].join('\n') + '\n', 'utf8');
}

/**
 * One skill into one skills dir. A team directory skill is (re)materialized from the clone every
 * time, over whatever entry holds its name; any other existing entry (tracked, or the user's own)
 * is never touched.
 */
async function provisionOne(cwd: string, skillsDir: string, skill: Skill): Promise<boolean> {
  // The name is frontmatter verbatim; it becomes a path segment, so it must be exactly one.
  if (!SAFE_SKILL_NAME.test(skill.name)) return false;
  const dest = join(cwd, skillsDir, skill.name);
  // Team copies are rewritten so a Continue picks up a fetched update; everything else stays put.
  if (skill.source === 'team' && skill.team?.dir) {
    return materializeSkillDir(cwd, skill, skillsDir, () => ignoreProvisioned(cwd, skillsDir, skill.name)).catch(
      () => false,
    );
  }
  const onDisk = skill.source !== 'team' && skill.source !== 'builtin' && isAbsolute(skill.path);
  // Already part of this checkout (an in-place run): the agent finds it where it is.
  const inCwd = relative(cwd, skill.path);
  if (onDisk && inCwd && !inCwd.startsWith('..') && !isAbsolute(inCwd)) return false;
  if (await exists(dest)) return false;
  await mkdir(dirname(dest), { recursive: true });
  if (onDisk && basename(skill.path) === 'SKILL.md') {
    // Link, not copy: the agent reads the current installed copy, references/ included.
    // A junction needs no privilege on Windows; a copy covers a filesystem with no links at all.
    await symlink(dirname(skill.path), dest, process.platform === 'win32' ? 'junction' : 'dir').catch(() =>
      cp(dirname(skill.path), dest, { recursive: true, dereference: true }),
    );
  } else if (onDisk) {
    await mkdir(dest);
    await symlink(skill.path, join(dest, 'SKILL.md')).catch(() => copyFile(skill.path, join(dest, 'SKILL.md')));
  } else {
    await mkdir(dest);
    await writeFile(join(dest, 'SKILL.md'), skillMarkdown(skill), 'utf8');
  }
  // No trailing slash: a symlink is a file to git, and `name/` would not match it.
  await ignoreProvisioned(cwd, skillsDir, skill.name).catch(() => excludeFromGit(cwd, `${skillsDir}/${skill.name}`));
  return true;
}

/**
 * Provision `roots` and their companions into `cwd`. Never throws — a skill that cannot be
 * installed still reaches the agent as its system prompt. Returns the names newly installed.
 */
export async function provisionSkills(
  cwd: string,
  roots: readonly Skill[],
  catalog: readonly Skill[],
): Promise<string[]> {
  const installed: string[] = [];
  for (const skill of skillClosure(roots, catalog)) {
    let any = false;
    for (const dir of PROVISION_SKILL_DIRS) {
      const ok = await provisionOne(cwd, dir, skill).catch((err: unknown) => {
        const errno = (err as { code?: unknown }).code;
        const code = typeof errno === 'string' ? errno : 'unknown';
        reportError(
          err,
          { 'skill.source': skill.source, 'skill.dir': dir.split('/')[0]!.slice(1), 'skill.errno': code },
          { code: 'skill_provision_failed', fingerprint: `skill_provision_failed:${code}` },
        );
        return false;
      });
      if (ok) any = true;
    }
    if (any) installed.push(skill.name);
  }
  return installed;
}

function readSkillFile(file: string): string | undefined {
  try {
    const raw = readFileSync(file, 'utf8');
    return raw.trim() ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a materialized `SKILL.md` declares `name` (frontmatter `name`, else its directory). */
function declaresSkill(raw: string, file: string, name: string): boolean {
  const { frontmatter } = parseFrontmatter(raw);
  const declared =
    typeof frontmatter.name === 'string' && frontmatter.name.trim() ? frontmatter.name.trim() : basename(dirname(file));
  return declared === name;
}

/**
 * The `SKILL.md` inside `cwd` that carries exactly `skill`, for naming it to the agent instead of
 * inlining the body. Native loaders pick a skill by NAME, so every `<dir>/<name>` entry in `cwd`
 * must carry the selected skill. One that differs means the agent may load other instructions, and
 * the body is inlined instead: a tracked or user-owned skill of the same name, which `provisionOne`
 * leaves in place for an on-disk skill, or what a failed team materialization left behind.
 * On-disk skills compare against their source file; a team skill against the blob this process
 * materialized there, so a stale or foreign copy never counts. An in-place run's own installed
 * `SKILL.md` counts as itself. Built-in skills return undefined.
 */
export function provisionedSkillFile(
  cwd: string,
  skill: Pick<Skill, 'name' | 'path' | 'source'>,
): string | undefined {
  if (!SAFE_SKILL_NAME.test(skill.name) || skill.source === 'builtin') return undefined;
  let source: string | undefined;
  let named: string | undefined;
  if (skill.source !== 'team') {
    if (!isAbsolute(skill.path)) return undefined;
    source = readSkillFile(skill.path);
    if (source === undefined) return undefined;
    const inCwd = relative(cwd, skill.path);
    if (inCwd && !inCwd.startsWith('..') && !isAbsolute(inCwd)) {
      if (basename(skill.path) !== 'SKILL.md' || !declaresSkill(source, skill.path, skill.name)) return undefined;
      named = skill.path;
    }
  }
  for (const dir of PROVISION_SKILL_DIRS) {
    const entry = join(cwd, dir, skill.name);
    if (!existsSync(entry)) continue;
    const file = join(entry, 'SKILL.md');
    const expected = skill.source === 'team' ? materializedSkillContent(file) : source;
    if (expected === undefined || readSkillFile(file) !== expected) return undefined;
    named ??= file;
  }
  return named;
}
