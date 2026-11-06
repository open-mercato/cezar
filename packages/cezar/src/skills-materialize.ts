import { cp, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Skill } from './skills.js';
import { excludeFromGit, materializeSkillDir } from './skills-remote.js';
import { ignoreProvisioned, isSafeSkillName } from './skills-provision.js';

/**
 * Put a skill's on-disk companion files (references/, scripts/, assets/,
 * hooks/) where the run can read them: `<cwd>/.claude/skills/<name>/`.
 *
 * Bodies are always injected into the prompt; this is the other half of the
 * delivery contract for directory skills. It used to exist only for
 * team-repo skills, which left bundled/global installs body-only — the run
 * 9788d87f failure, spec 2026-07-24-vendored-cez-skills. Team skills keep
 * their bare-clone materializer; every other source copies its real on-disk
 * directory (dereferencing symlinked installs).
 *
 * Also materializes the skill's `requires:` closure so contracts like
 * "resolve the cez-harness runtime beside this skill" hold by construction.
 * A missing dependency degrades to `false` — the caller surfaces the
 * install hint; everything resolvable is still put on disk.
 */
export async function ensureSkillOnDisk(
  cwd: string,
  skill: Skill,
  catalog: readonly Skill[],
): Promise<boolean> {
  const done = new Set<string>();
  const queue: Skill[] = [skill];
  let ok = true;
  while (queue.length) {
    const next = queue.shift();
    if (!next || done.has(next.name)) continue;
    done.add(next.name);
    ok = (await materializeOne(cwd, next)) && ok;
    for (const dep of next.requires ?? []) {
      if (done.has(dep)) continue;
      const found = catalog.find((s) => s.name === dep);
      if (!found) {
        ok = false;
        continue;
      }
      queue.push(found);
    }
  }
  return ok;
}

async function materializeOne(cwd: string, skill: Skill): Promise<boolean> {
  // Frontmatter verbatim, joined into the target path: `../x` would write outside the worktree
  // from the host process, past every agent sandbox. Covers `requires:` too.
  if (!isSafeSkillName(skill.name)) return false;
  // Every copy is ignored in THIS worktree (a self-ignoring .gitignore); the shared info/exclude
  // would also hide the path in the user's own checkout.
  const ignoreHere = () =>
    ignoreProvisioned(cwd, '.claude/skills', skill.name).catch(() =>
      excludeFromGit(cwd, `.claude/skills/${skill.name}/`),
    );
  if (skill.source === 'team') {
    return skill.team?.dir ? materializeSkillDir(cwd, skill, '.claude/skills', ignoreHere).catch(() => false) : true;
  }
  if (!skill.path.endsWith('SKILL.md')) return true;
  let srcDir: string;
  try {
    srcDir = await realpath(dirname(skill.path));
  } catch {
    return false; // dangling install
  }
  const target = join(cwd, '.claude', 'skills', skill.name);
  if (srcDir === resolve(target)) return true;
  try {
    const existing = await stat(target).catch(() => null);
    if (existing?.isDirectory()) return true; // idempotent across phases/restarts
    await cp(srcDir, target, { recursive: true, dereference: true });
    await ignoreHere();
    return true;
  } catch {
    return false;
  }
}
