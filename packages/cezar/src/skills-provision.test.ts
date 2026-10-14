import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Skill } from './skills.ts';
import { mentionsSkill, provisionSkills, skillClosure } from './skills-provision.ts';
import { reportError } from './telemetry.ts';

vi.mock('./telemetry.ts', () => ({ reportError: vi.fn() }));

const skill = (name: string, body: string, extra: Partial<Skill> = {}): Skill => ({
  name,
  body,
  path: `/nowhere/${name}/SKILL.md`,
  source: 'builtin',
  ...extra,
});

describe('mentionsSkill', () => {
  it('matches a hyphenated name as a word and a plain name only as /name or `name`', () => {
    expect(mentionsSkill('runs the `om-code-review` engine', 'om-code-review')).toBe(true);
    expect(mentionsSkill('see om-code-review-extra', 'om-code-review')).toBe(false);
    expect(mentionsSkill('then review the diff', 'review')).toBe(false);
    expect(mentionsSkill('then run /review', 'review')).toBe(true);
    expect(mentionsSkill('use `review`', 'review')).toBe(true);
  });
});

describe('skillClosure', () => {
  it('pulls companions transitively, roots first, each once', () => {
    const a = skill('om-a', 'runs om-b verbatim');
    const b = skill('om-b', 'then om-c, and back to om-a');
    const c = skill('om-c', 'leaf');
    const d = skill('om-d', 'unrelated');
    expect(skillClosure([a], [a, b, c, d]).map((s) => s.name)).toEqual(['om-a', 'om-b', 'om-c']);
  });
});

describe('provisionSkills', () => {
  let root: string;
  let cwd: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-provision-'));
    cwd = join(root, 'worktree');
    mkdirSync(cwd);
    execFileSync('git', ['init', '-q'], { cwd });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('installs the selected skill and its companion into both agent skill dirs, git-excluded', async () => {
    // The selected skill lives in a gitignored install dir of ANOTHER checkout (the main repo).
    const installed = join(root, 'main/.claude/skills/om-auto-review-pr');
    mkdirSync(join(installed, 'references'), { recursive: true });
    writeFileSync(join(installed, 'SKILL.md'), '---\nname: om-auto-review-pr\n---\nRun om-code-review.\n');
    const selected = skill('om-auto-review-pr', 'Run om-code-review.', {
      path: join(installed, 'SKILL.md'),
      source: 'agents',
    });
    // The companion exists only in cezar's catalog (no install dir at all).
    const companion = skill('om-code-review', 'Review engine.', { description: 'Reviews code.' });

    const names = await provisionSkills(cwd, [selected], [selected, companion]);

    expect(names).toEqual(['om-auto-review-pr', 'om-code-review']);
    for (const dir of ['.claude/skills', '.agents/skills']) {
      expect(readlinkSync(join(cwd, dir, 'om-auto-review-pr'))).toBe(installed);
      const companionMd = readFileSync(join(cwd, dir, 'om-code-review/SKILL.md'), 'utf8');
      expect(companionMd).toContain('name: "om-code-review"');
      expect(companionMd).toContain('Review engine.');
    }
    expect(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, encoding: 'utf8' })).toBe('');
  });

  it('never touches an entry that already exists (a tracked or user-installed skill)', async () => {
    mkdirSync(join(cwd, '.claude/skills/om-x'), { recursive: true });
    writeFileSync(join(cwd, '.claude/skills/om-x/SKILL.md'), 'mine');
    const names = await provisionSkills(cwd, [skill('om-x', 'cezar copy')], []);
    expect(readFileSync(join(cwd, '.claude/skills/om-x/SKILL.md'), 'utf8')).toBe('mine');
    expect(lstatSync(join(cwd, '.agents/skills/om-x')).isDirectory()).toBe(true);
    expect(names).toEqual(['om-x']);
  });

  it('reports a failed install as skill_provision_failed, grouped by errno, and carries on', async () => {
    // `.claude` is a FILE, so nothing can be created under it: ENOTDIR.
    writeFileSync(join(cwd, '.claude'), 'not a dir');
    const names = await provisionSkills(cwd, [skill('om-y', 'body')], []);
    expect(names).toEqual(['om-y']); // `.agents/skills` still got it
    expect(vi.mocked(reportError)).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ 'skill.source': 'builtin', 'skill.dir': 'claude' }),
      expect.objectContaining({ code: 'skill_provision_failed', fingerprint: expect.stringMatching(/^skill_provision_failed:E/) }),
    );
  });

  it("keeps a linked worktree's installs out of git without hiding those paths in the main checkout", async () => {
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base'], { cwd });
    const wt = join(root, 'linked');
    execFileSync('git', ['worktree', 'add', '-q', '--detach', wt], { cwd });

    expect(await provisionSkills(wt, [skill('om-x', 'cezar copy')], [])).toEqual(['om-x']);

    expect(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: wt, encoding: 'utf8' })).toBe('');
    // The same path created in the main checkout must still show up as untracked.
    mkdirSync(join(cwd, '.agents/skills/om-x'), { recursive: true });
    writeFileSync(join(cwd, '.agents/skills/om-x/SKILL.md'), 'mine');
    expect(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, encoding: 'utf8' })).toContain(
      '.agents/skills/om-x/SKILL.md',
    );
  });

  it('skips a skill whose name is not one safe path segment', async () => {
    const names = await provisionSkills(cwd, [skill('../escape', 'nope')], []);
    expect(names).toEqual([]);
    expect(existsSync(join(cwd, '.claude/escape'))).toBe(false);
    expect(existsSync(join(root, 'escape'))).toBe(false);
  });
});
