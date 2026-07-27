import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { Skill } from './skills.js';
import { ensureSkillOnDisk } from './skills-materialize.js';

const run = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A directory skill on disk: <root>/<name>/{SKILL.md, references/a.md, scripts/x.mjs}. */
async function writeDirSkill(root: string, name: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(join(dir, 'references'), { recursive: true });
  await mkdir(join(dir, 'scripts'), { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n${name} body`);
  await writeFile(join(dir, 'references', 'a.md'), 'reference');
  await writeFile(join(dir, 'scripts', 'x.mjs'), 'export {}');
  return dir;
}

function dirSkill(name: string, skillDir: string, overrides: Partial<Skill> = {}): Skill {
  return {
    name,
    body: `${name} body`,
    path: join(skillDir, 'SKILL.md'),
    source: 'bundled',
    ...overrides,
  };
}

describe('ensureSkillOnDisk', () => {
  it('copies a directory skill (through a symlinked install) into <cwd>/.claude/skills and excludes it from git', async () => {
    const store = await tmp('cez-mat-store-');
    const real = await writeDirSkill(store, 'cez-harness');
    const linkRoot = await tmp('cez-mat-links-');
    await symlink(real, join(linkRoot, 'cez-harness'), 'dir');
    const cwd = await tmp('cez-mat-cwd-');
    await run('git', ['init', '-q'], { cwd });

    const skill = dirSkill('cez-harness', join(linkRoot, 'cez-harness'), { source: 'global' });
    expect(await ensureSkillOnDisk(cwd, skill, [skill])).toBe(true);

    const copied = join(cwd, '.claude', 'skills', 'cez-harness');
    expect((await stat(join(copied, 'SKILL.md'))).isFile()).toBe(true);
    expect((await stat(join(copied, 'references', 'a.md'))).isFile()).toBe(true);
    expect((await stat(join(copied, 'scripts', 'x.mjs'))).isFile()).toBe(true);
    const exclude = await readFile(join(cwd, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('.claude/skills/cez-harness/');
  });

  it('materializes the requires closure from the catalog, cycle-safe', async () => {
    const store = await tmp('cez-mat-store-');
    const setup = dirSkill('cez-setup-harness', await writeDirSkill(store, 'cez-setup-harness'), {
      requires: ['cez-harness'],
    });
    const runtime = dirSkill('cez-harness', await writeDirSkill(store, 'cez-harness'), {
      requires: ['cez-code-review'],
    });
    const review = dirSkill('cez-code-review', await writeDirSkill(store, 'cez-code-review'), {
      // Deliberate cycle back to the root — must not loop forever.
      requires: ['cez-setup-harness'],
    });
    const cwd = await tmp('cez-mat-cwd-');

    expect(await ensureSkillOnDisk(cwd, setup, [setup, runtime, review])).toBe(true);
    for (const name of ['cez-setup-harness', 'cez-harness', 'cez-code-review']) {
      expect((await stat(join(cwd, '.claude', 'skills', name, 'SKILL.md'))).isFile()).toBe(true);
    }
  });

  it('materializes into a non-git folder without fabricating a phantom .git (2026-07-24)', async () => {
    const store = await tmp('cez-mat-store-');
    const real = await writeDirSkill(store, 'cez-harness');
    const cwd = await tmp('cez-mat-plain-'); // deliberately NOT a git repo
    const skill = dirSkill('cez-harness', real, { source: 'bundled' });

    expect(await ensureSkillOnDisk(cwd, skill, [skill])).toBe(true);
    expect((await stat(join(cwd, '.claude', 'skills', 'cez-harness', 'SKILL.md'))).isFile()).toBe(true);
    // The exclude helper must no-op outside a repository — a `.git` holding
    // only `info/exclude` reads as a broken repo to everything downstream.
    await expect(stat(join(cwd, '.git'))).rejects.toThrow();
  });

  it('returns true without copying for single-file skills and for skills already inside cwd', async () => {
    const cwd = await tmp('cez-mat-cwd-');
    const flat: Skill = {
      name: 'flat',
      body: 'flat body',
      path: join(cwd, '.ai', 'skills', 'flat.md'),
      source: 'ai',
    };
    expect(await ensureSkillOnDisk(cwd, flat, [flat])).toBe(true);

    const insideDir = await writeDirSkill(join(cwd, '.ai', 'skills'), 'local-dir');
    const inside = dirSkill('local-dir', insideDir, { source: 'ai' });
    expect(await ensureSkillOnDisk(cwd, inside, [inside])).toBe(true);
    // Not duplicated under .claude/skills — it already lives in the tree.
    await expect(stat(join(cwd, '.claude', 'skills', 'local-dir'))).rejects.toThrow();
  });

  it('degrades to false when a requires name is missing from the catalog', async () => {
    const store = await tmp('cez-mat-store-');
    const setup = dirSkill('cez-setup-harness', await writeDirSkill(store, 'cez-setup-harness'), {
      requires: ['cez-harness'],
    });
    const cwd = await tmp('cez-mat-cwd-');
    expect(await ensureSkillOnDisk(cwd, setup, [setup])).toBe(false);
    // The skill itself still materialized — only the dependency is missing.
    expect((await stat(join(cwd, '.claude', 'skills', 'cez-setup-harness', 'SKILL.md'))).isFile()).toBe(true);
  });
});
