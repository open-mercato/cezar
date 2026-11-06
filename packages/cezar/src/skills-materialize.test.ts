import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Skill } from './skills.js';
import { ensureSkillOnDisk } from './skills-materialize.js';
import { bareDirFor } from './skills-remote.js';

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
  it('copies a directory skill (through a symlinked install) into <cwd>/.claude/skills and ignores it in this worktree only', async () => {
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
    // A self-ignoring .gitignore in the skills dir, never the shared info/exclude.
    const ignore = await readFile(join(cwd, '.claude', 'skills', '.gitignore'), 'utf8');
    expect(ignore.split('\n')).toContain('/cez-harness');
    const exclude = await readFile(join(cwd, '.git', 'info', 'exclude'), 'utf8').catch(() => '');
    expect(exclude).not.toContain('cez-harness');
    const { stdout } = await run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd });
    expect(stdout).toBe('');
  });

  // team skills took materializeSkillDir's default ignore, the
  // shared info/exclude — on the default path of every worktree run with a team step skill.
  it('ignores a team skill copy in this worktree only, never the shared info/exclude', async () => {
    vi.stubEnv('HOME', await tmp('cez-mat-home-'));
    try {
      const repo = 'https://example.invalid/org/team-skills';
      const src = await tmp('cez-mat-team-src-');
      await run('git', ['init', '-q', '-b', 'main'], { cwd: src });
      await writeDirSkill(src, 'team-skill');
      await run('git', ['add', '-A'], { cwd: src });
      await run('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'skill'], { cwd: src });
      await run('git', ['clone', '-q', '--bare', src, bareDirFor(repo)]);
      const cwd = await tmp('cez-mat-cwd-');
      await run('git', ['init', '-q'], { cwd });
      const skill: Skill = {
        name: 'team-skill',
        body: 'team-skill body',
        path: `${repo}@main:team-skill/SKILL.md`,
        source: 'team',
        team: { repo, ref: 'main', path: 'team-skill/SKILL.md', dir: true },
      };

      expect(await ensureSkillOnDisk(cwd, skill, [skill])).toBe(true);
      expect((await stat(join(cwd, '.claude', 'skills', 'team-skill', 'references', 'a.md'))).isFile()).toBe(true);
      const exclude = await readFile(join(cwd, '.git', 'info', 'exclude'), 'utf8').catch(() => '');
      expect(exclude).not.toContain('team-skill');
      const { stdout } = await run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd });
      expect(stdout).toBe('');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // the frontmatter name is joined into the target path.
  it('refuses a skill whose name is not one safe path segment, writing nothing outside the worktree', async () => {
    const store = await tmp('cez-mat-store-');
    const parent = await tmp('cez-mat-parent-');
    const cwd = join(parent, 'worktree');
    await mkdir(cwd);
    const unsafe = dirSkill('../../../escaped', await writeDirSkill(store, 'escaped'));
    expect(await ensureSkillOnDisk(cwd, unsafe, [unsafe])).toBe(false);
    await expect(stat(join(parent, 'escaped'))).rejects.toThrow(/ENOENT/);
    await expect(stat(join(cwd, '.claude'))).rejects.toThrow(/ENOENT/);
  });

  it('refuses an unsafe name reached through requires', async () => {
    const store = await tmp('cez-mat-store-');
    const parent = await tmp('cez-mat-parent-');
    const cwd = join(parent, 'worktree');
    await mkdir(cwd);
    const dep = dirSkill('../dep', await writeDirSkill(store, 'dep'));
    const root = dirSkill('root-skill', await writeDirSkill(store, 'root-skill'), { requires: ['../dep'] });
    expect(await ensureSkillOnDisk(cwd, root, [root, dep])).toBe(false);
    await expect(stat(join(cwd, '.claude', 'dep'))).rejects.toThrow(/ENOENT/);
    expect((await stat(join(cwd, '.claude', 'skills', 'root-skill', 'SKILL.md'))).isFile()).toBe(true);
  });

  it('materializes the requires closure from the catalog, cycle-safe', async () => {
    const store = await tmp('cez-mat-store-');
    const setup = dirSkill('cez-setup-harness', await writeDirSkill(store, 'cez-setup-harness'), {
      requires: ['cez-harness'],
    });
    const runtime = dirSkill('cez-harness', await writeDirSkill(store, 'cez-harness'), {
      requires: ['om-code-review'],
    });
    const review = dirSkill('om-code-review', await writeDirSkill(store, 'om-code-review'), {
      requires: ['cez-setup-harness'],
    });
    const cwd = await tmp('cez-mat-cwd-');

    expect(await ensureSkillOnDisk(cwd, setup, [setup, runtime, review])).toBe(true);
    for (const name of ['cez-setup-harness', 'cez-harness', 'om-code-review']) {
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
    await expect(stat(join(cwd, '.git'))).rejects.toThrow();
  });

  it('leaves flat skills alone and materializes repo-local directory skills', async () => {
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
    expect(
      (await stat(join(cwd, '.claude', 'skills', 'local-dir', 'SKILL.md'))).isFile(),
    ).toBe(true);
    expect(
      (await stat(join(cwd, '.claude', 'skills', 'local-dir', 'references', 'a.md'))).isFile(),
    ).toBe(true);
  });

  it('degrades to false when a requires name is missing from the catalog', async () => {
    const store = await tmp('cez-mat-store-');
    const setup = dirSkill('cez-setup-harness', await writeDirSkill(store, 'cez-setup-harness'), {
      requires: ['cez-harness'],
    });
    const cwd = await tmp('cez-mat-cwd-');
    expect(await ensureSkillOnDisk(cwd, setup, [setup])).toBe(false);
    expect((await stat(join(cwd, '.claude', 'skills', 'cez-setup-harness', 'SKILL.md'))).isFile()).toBe(true);
  });
});
