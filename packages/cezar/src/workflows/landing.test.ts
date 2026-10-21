import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fallbackCommitMessage, hasUnlanded, landInPlace } from './landing.ts';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

let dir: string;
let remote: string;
let checkout: string;
let other: string;

beforeEach(() => {
  vi.stubEnv('CEZ_DRY_RUN', '');
  dir = mkdtempSync(join(tmpdir(), 'cez-landing-'));
  remote = join(dir, 'remote.git');
  checkout = join(dir, 'checkout');
  other = join(dir, 'other');
  execFileSync('git', ['init', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, checkout], { stdio: 'pipe' });
  git(checkout, 'checkout', '-q', '-b', 'main');
  writeFileSync(join(checkout, 'daily.md'), 'one\n');
  git(checkout, 'add', '-A');
  git(checkout, 'commit', '-qm', 'init');
  git(checkout, 'push', '-q', '-u', 'origin', 'main');
  execFileSync('git', ['clone', '-q', remote, other]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const ok = async () => ({ ok: true, output: '' });

describe('landInPlace', () => {
  it('commits what the task left and pushes it to the upstream', async () => {
    writeFileSync(join(checkout, 'person.md'), 'Bjorn\n');
    const result = await landInPlace(checkout, { describe: async () => '1on1 with Bjorn', checks: ['true'], runCheck: ok });
    expect(result).toMatchObject({ result: 'landed', branch: 'main', pushed: true, files: ['person.md'] });
    expect(git(remote, 'log', '-1', '--format=%s', 'main')).toBe('1on1 with Bjorn');
    expect(await hasUnlanded(checkout)).toBe(false);
  });

  it("never lands cezar's own state", async () => {
    execFileSync('mkdir', ['-p', join(checkout, '.ai/cezar')]);
    writeFileSync(join(checkout, '.ai/cezar/config.json'), '{"landing":"auto"}\n');
    expect(await hasUnlanded(checkout)).toBe(false);
    writeFileSync(join(checkout, 'person.md'), 'x\n');
    expect(await landInPlace(checkout, { describe: async () => 'x', checks: [] })).toMatchObject({ result: 'landed', files: ['person.md'] });
    expect(git(checkout, 'ls-files', '.ai')).toBe('');
  });

  it('lands nothing on a clean checkout, without touching the network', async () => {
    expect(await landInPlace(checkout, { describe: async () => 'x', checks: [] })).toEqual({ result: 'nothing' });
  });

  it('rebases over a teammate push that touched other files', async () => {
    writeFileSync(join(other, 'project.md'), 'p\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-qm', 'theirs');
    git(other, 'push', '-q');
    writeFileSync(join(checkout, 'person.md'), 'Bjorn\n');
    const result = await landInPlace(checkout, { describe: async () => 'mine', checks: [] });
    expect(result).toMatchObject({ result: 'landed', pushed: true, files: ['person.md'] });
    expect(git(remote, 'log', '--format=%s', 'main').split('\n')).toEqual(['mine', 'theirs', 'init']);
  });

  it('rebases on a machine with no git identity (CI) using the fallback committer', async () => {
    writeFileSync(join(other, 'project.md'), 'p\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-qm', 'theirs');
    git(other, 'push', '-q');
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'user.useConfigOnly');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'true');
    writeFileSync(join(checkout, 'person.md'), 'Bjorn\n');
    const result = await landInPlace(checkout, { describe: async () => 'mine', checks: [] });
    expect(result).toMatchObject({ result: 'landed', pushed: true, files: ['person.md'] });
    expect(git(remote, 'log', '--format=%s', 'main').split('\n')).toEqual(['mine', 'theirs', 'init']);
  });

  it('hands a rebase conflict back with the files, leaving no rebase in progress', async () => {
    writeFileSync(join(other, 'daily.md'), 'theirs\n');
    git(other, 'commit', '-qam', 'theirs');
    git(other, 'push', '-q');
    writeFileSync(join(checkout, 'daily.md'), 'mine\n');
    const result = await landInPlace(checkout, { describe: async () => 'mine', checks: [] });
    expect(result).toMatchObject({ result: 'failed', stage: 'sync' });
    expect(result.result === 'failed' && result.error).toContain('daily.md');
    expect(readFileSync(join(checkout, 'daily.md'), 'utf8')).toBe('mine\n');
    expect(git(checkout, 'status', '--porcelain')).toBe('');
    expect(git(remote, 'log', '-1', '--format=%s', 'main')).toBe('theirs');
  });

  it('never pushes when a required check fails', async () => {
    writeFileSync(join(checkout, 'person.md'), 'broken\n');
    const result = await landInPlace(checkout, {
      describe: async () => 'mine',
      checks: ['node scripts/kb.ts validate'],
      runCheck: async () => ({ ok: false, output: 'person.md: missing frontmatter' }),
    });
    expect(result).toMatchObject({ result: 'failed', stage: 'checks' });
    expect(result.result === 'failed' && result.error).toContain('missing frontmatter');
    expect(git(remote, 'log', '-1', '--format=%s', 'main')).toBe('init');
  });

  it('runs real shell checks in the checkout', async () => {
    writeFileSync(join(checkout, 'person.md'), 'x\n');
    const result = await landInPlace(checkout, { describe: async () => 'mine', checks: ['test -f person.md', 'exit 3'] });
    expect(result).toMatchObject({ result: 'failed', stage: 'checks' });
    expect(result.result === 'failed' && result.error).toContain('`exit 3`');
  });

  it('refuses a checkout that is not on the configured base branch', async () => {
    git(checkout, 'checkout', '-q', '-b', 'side');
    writeFileSync(join(checkout, 'person.md'), 'x\n');
    const result = await landInPlace(checkout, { describe: async () => 'x', baseBranch: 'main', checks: [] });
    expect(result).toMatchObject({ result: 'failed', stage: 'branch' });
    expect(git(checkout, 'status', '--porcelain')).not.toBe('');
  });

  it('commits locally when the branch has no upstream', async () => {
    const local = join(dir, 'local');
    execFileSync('git', ['init', '-q', '-b', 'main', local]);
    writeFileSync(join(local, 'a.md'), 'a\n');
    git(local, 'add', '-A');
    git(local, 'commit', '-qm', 'init');
    const since = git(local, 'rev-parse', 'HEAD');
    writeFileSync(join(local, 'b.md'), 'b\n');
    const result = await landInPlace(local, { describe: async () => 'note', since, checks: [] });
    expect(result).toMatchObject({ result: 'landed', pushed: false, files: ['b.md'] });
  });

  it('with no upstream, a failing check commits nothing, so the retry still sees the change', async () => {
    const local = join(dir, 'local');
    execFileSync('git', ['init', '-q', '-b', 'main', local]);
    writeFileSync(join(local, 'a.md'), 'a\n');
    git(local, 'add', '-A');
    git(local, 'commit', '-qm', 'init');
    const before = git(local, 'rev-parse', 'HEAD');
    writeFileSync(join(local, 'b.md'), 'b\n');
    const failing = async () => ({ ok: false, output: 'nope' });
    expect(await landInPlace(local, { describe: async () => 'note', checks: ['x'], runCheck: failing })).toMatchObject({ result: 'failed', stage: 'checks' });
    expect(git(local, 'rev-parse', 'HEAD')).toBe(before);
    expect(await hasUnlanded(local)).toBe(true);
  });

  it('rebases while a tracked file under .ai/cezar has edits it leaves out', async () => {
    execFileSync('mkdir', ['-p', join(checkout, '.ai/cezar/workflows')]);
    writeFileSync(join(checkout, '.ai/cezar/workflows/w.yaml'), 'a: 1\n');
    git(checkout, 'add', '-A');
    git(checkout, 'commit', '-qm', 'workflow');
    git(checkout, 'push', '-q');
    git(other, 'pull', '-q');
    writeFileSync(join(other, 'project.md'), 'p\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-qm', 'theirs');
    git(other, 'push', '-q');
    writeFileSync(join(checkout, '.ai/cezar/workflows/w.yaml'), 'a: 2\n');
    writeFileSync(join(checkout, 'person.md'), 'Bjorn\n');
    expect(await landInPlace(checkout, { describe: async () => 'mine', checks: [] })).toMatchObject({ result: 'landed', pushed: true, files: ['person.md'] });
    expect(readFileSync(join(checkout, '.ai/cezar/workflows/w.yaml'), 'utf8')).toBe('a: 2\n');
  });
});

describe('landing commit messages (spec 2026-10-20-trunk-based-projects)', () => {
  it('describes each landing from its own staged change, not a fixed title', async () => {
    const seen: string[][] = [];
    const describe = async (staged: { files: Array<{ path: string }> }) => {
      seen.push(staged.files.map((f) => f.path));
      return `Write ${staged.files.map((f) => f.path).join(', ')}`;
    };
    writeFileSync(join(checkout, 'summary.md'), 'one\n');
    await landInPlace(checkout, { describe, checks: [] });
    writeFileSync(join(checkout, 'actions.md'), 'two\n');
    await landInPlace(checkout, { describe, checks: [] });
    expect(seen).toEqual([['summary.md'], ['actions.md']]);
    expect(git(remote, 'log', '--format=%s', 'main').split('\n').slice(0, 2)).toEqual(['Write actions.md', 'Write summary.md']);
  });

  it('falls back to the file list when nothing describes the change', async () => {
    writeFileSync(join(checkout, 'meeting.md'), 'x\n');
    await landInPlace(checkout, { describe: async () => undefined, checks: [] });
    expect(git(remote, 'log', '-1', '--format=%s', 'main')).toBe('Add meeting.md');
  });

  it('names files plainly in the fallback', () => {
    expect(fallbackCommitMessage([{ status: 'A', path: 'notes/a.md' }])).toBe('Add a.md');
    expect(fallbackCommitMessage([{ status: 'M', path: 'a.md' }, { status: 'M', path: 'b.md' }])).toBe('Update a.md and b.md');
    expect(fallbackCommitMessage([
      { status: 'M', path: 'people/a.md' },
      { status: 'A', path: 'people/b.md' },
      { status: 'M', path: 'people/c.md' },
    ])).toBe('Update 2 and add 1 files in people/');
    expect(fallbackCommitMessage([
      ...Array.from({ length: 19 }, (_, i) => ({ status: 'D', path: `vault/knowledge/reading/${i}.md` })),
      ...Array.from({ length: 4 }, (_, i) => ({ status: 'M', path: `vault/knowledge/tools/${i}.md` })),
    ])).toBe('Remove 19 and update 4 files in vault/knowledge/');
  });
});
