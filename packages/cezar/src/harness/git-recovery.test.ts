import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pinWorktreeGitDir } from '../git-pin.js';
import { harnessDiff, resetIndexToHead } from './driver.js';

const script = new URL('../../vendor/skills/cez-harness/scripts/harness.mjs', import.meta.url).pathname;

describe('Git recovery boundaries', () => {
  let root: string;
  let cwd: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), 'cez-git-recovery-'));
    cwd = join(root, 'repo');
    fs.mkdirSync(cwd);
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@local');
    git('config', 'user.name', 'test');
    fs.mkdirSync(join(cwd, 'src'));
    fs.writeFileSync(join(cwd, 'src/a.txt'), 'base\n');
    fs.writeFileSync(join(cwd, 'untouched.txt'), 'untouched\n');
    git('add', '.');
    git('commit', '-qm', 'base');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const pin = () => pinWorktreeGitDir(cwd, join(cwd, '.git'));

  it('[round2-8] sizes the subject asynchronously from the real index stat cache', async () => {
    pin();
    const trace = join(root, 'git.trace');
    vi.stubEnv('GIT_TRACE', trace);
    fs.writeFileSync(join(cwd, 'src/a.txt'), 'changed\n');
    const index = fs.readFileSync(join(cwd, '.git/index'));
    let yielded = false;
    setImmediate(() => { yielded = true; });
    const diff = await harnessDiff(cwd, [], join(root, 'scratch-index'));
    expect(diff.toString()).toContain('+changed');
    expect(yielded).toBe(true);
    expect(fs.readFileSync(trace, 'utf8')).not.toContain('read-tree HEAD');
    expect(fs.readFileSync(join(cwd, '.git/index'))).toEqual(index);
    expect(fs.existsSync(join(root, 'scratch-index'))).toBe(false);
  });

  it('guard: subject sizing includes staged, unstaged, deleted and intent-to-add paths without changing the real index', async () => {
    pin();
    fs.writeFileSync(join(cwd, 'src/a.txt'), 'staged\n');
    git('add', 'src/a.txt');
    fs.writeFileSync(join(cwd, 'src/a.txt'), 'unstaged final\n');
    fs.rmSync(join(cwd, 'untouched.txt'));
    fs.writeFileSync(join(cwd, 'new.txt'), 'untracked\n');
    git('add', '-N', 'new.txt');
    const index = fs.readFileSync(join(cwd, '.git/index'));
    const diff = (await harnessDiff(cwd, [], join(root, 'scratch-index'))).toString();
    expect(diff).toContain('+unstaged final');
    expect(diff).toContain('-untouched');
    expect(diff).toContain('+untracked');
    expect(diff).not.toContain('+staged\n');
    expect(fs.readFileSync(join(cwd, '.git/index'))).toEqual(index);
  });

  it('guard: unmerged index fallback still passes real runtime verify and stage without reflog drift', () => {
    pin();
    const runtime = (op: string, ...args: string[]) => execFileSync(process.execPath, [script, op, '--worktree', cwd, ...args], { encoding: 'utf8' });
    const start = join(root, 'start.json');
    runtime('capture', '--output', start);
    const blob = git('rev-parse', 'HEAD:src/a.txt').trim();
    git('update-index', '--force-remove', 'src/a.txt');
    execFileSync('git', ['update-index', '--index-info'], {
      cwd, input: [1, 2, 3].map((stage) => `100644 ${blob} ${stage}\tsrc/a.txt\n`).join(''),
    });
    expect(git('ls-files', '--unmerged')).not.toBe('');
    resetIndexToHead(cwd);
    expect(git('ls-files', '--unmerged')).toBe('');
    expect(JSON.parse(runtime('verify', '--start-state', start))).toMatchObject({ status: 'clean', drift: [] });
    fs.writeFileSync(join(cwd, 'src/a.txt'), 'handoff\n');
    const paths = join(root, 'paths.txt');
    fs.writeFileSync(paths, 'src/a.txt\n');
    expect(JSON.parse(runtime('stage', '--start-state', start, '--paths-file', paths))).toMatchObject({ status: 'ready', stagedPaths: ['src/a.txt'] });
  });

  it('[round2-11] refuses an unpinned diff before git can add worktree files', async () => {
    fs.writeFileSync(join(cwd, 'src/a.txt'), 'untrusted\n');
    const index = fs.readFileSync(join(cwd, '.git/index'));
    await expect(harnessDiff(cwd, [], join(root, 'scratch-index'))).rejects.toThrow('no pinned Git directory');
    expect(fs.readFileSync(join(cwd, '.git/index'))).toEqual(index);
    expect(fs.existsSync(join(root, 'scratch-index'))).toBe(false);
  });

  it('guard: an unpinned index reset leaves ordinary repository staging untouched', () => {
    fs.writeFileSync(join(cwd, 'src/a.txt'), 'ordinary staged edit\n');
    git('add', 'src/a.txt');
    const index = fs.readFileSync(join(cwd, '.git/index'));
    resetIndexToHead(cwd);
    expect(fs.readFileSync(join(cwd, '.git/index'))).toEqual(index);
  });
});
