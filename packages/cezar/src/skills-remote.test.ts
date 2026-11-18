import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bareDirFor, ensureBareClone, isPinnedSha, materializeSkillDir, shouldPassiveFetch } from './skills-remote.ts';
import type { Skill } from './skills.ts';

const TTL = 6 * 60 * 60 * 1_000;

describe('shouldPassiveFetch', () => {
  it('fetches on the first passive touch this process', () => {
    // A clone left by an earlier run must be refreshed on first read, else a
    // long-running server serves whatever ref that old clone happened to have.
    expect(shouldPassiveFetch({ attempted: false, fetchedAt: 0, now: 1_000, ttlMs: TTL })).toBe(true);
  });

  it('does not re-fetch within the TTL once touched', () => {
    const now = 10 * 60 * 60 * 1_000;
    expect(shouldPassiveFetch({ attempted: true, fetchedAt: now - 60_000, now, ttlMs: TTL })).toBe(false);
  });

  it('re-fetches once the last fetch is older than the TTL', () => {
    const now = 10 * 60 * 60 * 1_000;
    expect(shouldPassiveFetch({ attempted: true, fetchedAt: now - TTL - 1, now, ttlMs: TTL })).toBe(true);
  });

  it('treats exactly-TTL as still fresh (strictly greater re-fetches)', () => {
    const now = 10 * 60 * 60 * 1_000;
    expect(shouldPassiveFetch({ attempted: true, fetchedAt: now - TTL, now, ttlMs: TTL })).toBe(false);
  });
});

describe('bareDirFor', () => {
  it('keys the global cache on owner__name regardless of URL shape', () => {
    const expected = bareDirFor('open-mercato/skills');
    expect(bareDirFor('https://github.com/open-mercato/skills.git')).toBe(expected);
    expect(bareDirFor('git@github.com:open-mercato/skills')).toBe(expected);
    expect(expected.endsWith('open-mercato__skills')).toBe(true);
  });
});

describe('isPinnedSha', () => {
  it('accepts 40- and 64-hex, rejects branch names', () => {
    expect(isPinnedSha('a'.repeat(40))).toBe(true);
    expect(isPinnedSha('b'.repeat(64))).toBe(true);
    expect(isPinnedSha('main')).toBe(false);
  });
});

describe('materializeSkillDir', () => {
  let root: string;
  let source: string;
  let worktree: string;
  let skillDir: string;
  let skill: Skill;
  const name = 'om-materialize-fixture';
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, timeout: 10_000 });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cez-materialize-'));
    source = join(root, 'team');
    worktree = join(root, 'worktree');
    mkdirSync(source);
    mkdirSync(worktree);
    git(source, 'init', '-qb', 'main');
    git(worktree, 'init', '-qb', 'main');
    const sourceDir = join(source, 'skills', name);
    mkdirSync(join(sourceDir, 'references'), { recursive: true });
    writeFileSync(join(sourceDir, 'SKILL.md'), 'Team instructions');
    writeFileSync(join(sourceDir, 'references/guide.md'), 'Team guide');
    git(source, 'add', '.');
    git(source, '-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'team');
    await ensureBareClone(source);
    skillDir = join(worktree, '.claude/skills', name);
    skill = { name, body: 'Team instructions', path: 'team', source: 'team', team: { repo: source, ref: 'main', path: `skills/${name}/SKILL.md`, dir: true } };
  });

  afterEach(() => {
    rmSync(bareDirFor(source), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it('preserves a tracked worktree skill even if the directory carries a legacy marker', async () => {
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), 'Branch instructions');
    git(worktree, 'add', '.');
    writeFileSync(join(worktree, '.claude/skills/.gitignore'), `# cezar: skills installed for this task, not part of the repository\n/${name}\n`);
    expect(await materializeSkillDir(worktree, skill)).toBe(false);
    expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf8')).toBe('Branch instructions');
    rmSync(skillDir, { recursive: true });
    expect(await materializeSkillDir(worktree, skill)).toBe(false);
    expect(existsSync(skillDir)).toBe(false);
  });

  it('rejects links in the reference path of a managed skill before writing any files', async () => {
    expect(await materializeSkillDir(worktree, skill)).toBe(true);
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'guide.md'), 'Local guide');
    writeFileSync(join(skillDir, 'SKILL.md'), 'Previous instructions');
    rmSync(join(skillDir, 'references'), { recursive: true });
    symlinkSync(outside, join(skillDir, 'references'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await materializeSkillDir(worktree, skill)).toBe(false);
    expect(readFileSync(join(outside, 'guide.md'), 'utf8')).toBe('Local guide');
    expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf8')).toBe('Previous instructions');
  });

  it('refreshes a previously materialized skill directory and restores its ignore rule', async () => {
    expect(await materializeSkillDir(worktree, skill)).toBe(true);
    writeFileSync(join(skillDir, 'SKILL.md'), 'Previous instructions');
    const exclude = join(worktree, '.git/info/exclude');
    writeFileSync(exclude, '# no local excludes\n');
    expect(await materializeSkillDir(worktree, skill)).toBe(true);
    expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf8')).toBe('Team instructions');
    expect(readFileSync(exclude, 'utf8')).toContain(`.claude/skills/${name}/`);
  });

  it('refreshes an in-place copy a released cezar owned through info/exclude only', async () => {
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), 'Previous instructions');
    expect(await materializeSkillDir(worktree, skill)).toBe(false);
    writeFileSync(join(worktree, '.git/info/exclude'), `.claude/skills/${name}/\n`);
    expect(await materializeSkillDir(worktree, skill)).toBe(true);
    expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf8')).toBe('Team instructions');
    expect(readFileSync(join(skillDir, '.cezar-skill'), 'utf8')).toBe(`${name}\n`);
  });

  it('replaces a hard-linked reference without writing to its external file', async () => {
    expect(await materializeSkillDir(worktree, skill)).toBe(true);
    const outside = join(root, 'guide.md');
    const reference = join(skillDir, 'references/guide.md');
    writeFileSync(outside, 'Local guide');
    rmSync(reference);
    linkSync(outside, reference);
    expect(await materializeSkillDir(worktree, skill)).toBe(true);
    expect(readFileSync(outside, 'utf8')).toBe('Local guide');
    expect(readFileSync(reference, 'utf8')).toBe('Team guide');
  });
});
