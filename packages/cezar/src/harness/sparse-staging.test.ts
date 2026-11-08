import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pinWorktreeGitDir } from '../git-pin.js';
import { resetIndexToHead, snapshotHarnessReviewSubject, snapshotHarnessStageSubject } from './driver.js';

const script = new URL('../../vendor/skills/cez-harness/scripts/harness.mjs', import.meta.url).pathname;

describe('sparse worktree staging', () => {
  let root: string;
  let cwd: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const runtime = (op: string, ...args: string[]) => JSON.parse(execFileSync(process.execPath, [script, op, '--worktree', cwd, ...args], { cwd, encoding: 'utf8' }));
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-round4-'));
    cwd = join(root, 'repo');
    mkdirSync(join(cwd, 'src/nested'), { recursive: true });
    mkdirSync(join(cwd, 'outside'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@local');
    git('config', 'user.name', 'test');
    writeFileSync(join(cwd, 'src/nested/a.txt'), 'base\n');
    writeFileSync(join(cwd, 'src/x'), 'sibling\n');
    writeFileSync(join(cwd, 'outside/other.txt'), 'outside\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    pinWorktreeGitDir(cwd, join(cwd, '.git'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const sparseWorktree = () => {
    git('sparse-checkout', 'init', '--cone');
    git('sparse-checkout', 'set', 'src');
    const worktree = join(root, 'sparse');
    git('worktree', 'add', '-q', '-b', 'task', worktree);
    cwd = worktree;
    pinWorktreeGitDir(cwd, git('rev-parse', '--absolute-git-dir').trim());
    expect(existsSync(join(cwd, 'outside/other.txt'))).toBe(false);
  };

  it('[r4-1] stages only the in-cone edit after resetting a sparse worktree', () => {
    sparseWorktree();
    const start = join(root, 'start.json');
    runtime('capture', '--output', start);
    writeFileSync(join(cwd, 'src/nested/a.txt'), 'in-cone edit\n');
    resetIndexToHead(cwd);
    const changed = git('diff', '--name-only', 'HEAD');
    expect(changed).toBe('src/nested/a.txt\n');
    expect(git('ls-files', '-v', 'outside/other.txt')).toBe('S outside/other.txt\n');
    const paths = join(root, 'paths.txt');
    writeFileSync(paths, changed);
    expect(runtime('stage', '--start-state', start, '--paths-file', paths)).toMatchObject({ status: 'ready', stagedPaths: ['src/nested/a.txt'] });
    expect(git('diff', '--cached', '--name-only')).toBe(changed);
  });

  it('[r4-1] retains the unchanged index stat cache', () => {
    const before = git('ls-files', '--debug', 'src/x');
    expect(before).not.toContain('ctime: 0:0');
    expect(before).not.toContain('mtime: 0:0');
    resetIndexToHead(cwd);
    expect(git('ls-files', '--debug', 'src/x')).toBe(before);
  });

  it.each(['--assume-unchanged', '--skip-worktree'])('guard: [r4-1] still clears a present %s edit and superseded staging without reflog drift', (flag) => {
    const start = join(root, 'start.json');
    runtime('capture', '--output', start);
    const reflog = git('reflog', 'show', 'HEAD');
    writeFileSync(join(cwd, 'src/x'), 'superseded staging\n');
    git('add', 'src/x');
    writeFileSync(join(cwd, 'src/x'), 'sibling\n');
    git('update-index', flag, '--', 'src/nested/a.txt');
    writeFileSync(join(cwd, 'src/nested/a.txt'), 'hidden edit\n');
    resetIndexToHead(cwd);
    expect(git('diff', '--cached')).toBe('');
    expect(git('reflog', 'show', 'HEAD')).toBe(reflog);
    const paths = join(root, 'paths.txt');
    writeFileSync(paths, git('diff', '--name-only', 'HEAD'));
    expect(runtime('stage', '--start-state', start, '--paths-file', paths)).toMatchObject({ status: 'ready', stagedPaths: ['src/nested/a.txt'] });
  });

  it('guard: [r4-1] clears both flags on long literal path lists in bounded batches', () => {
    const names = Array.from({ length: 200 }, (_, i) => `src/${i}-[literal]*-${'x'.repeat(210)}`);
    for (const path of names) writeFileSync(join(cwd, path), 'base\n');
    git('add', 'src');
    git('commit', '-qm', 'long paths');
    const start = join(root, 'start.json');
    runtime('capture', '--output', start);
    git('update-index', '--assume-unchanged', '--', ...names);
    git('update-index', '--skip-worktree', '--', ...names);
    for (const path of names) writeFileSync(join(cwd, path), 'flagged edit\n');
    resetIndexToHead(cwd);
    expect(git('ls-files', '-v').split('\n').filter((entry) => /^[a-zS] /.test(entry))).toEqual([]);
    const paths = join(root, 'paths.txt');
    writeFileSync(paths, git('diff', '--name-only', 'HEAD'));
    expect(runtime('stage', '--start-state', start, '--paths-file', paths)).toMatchObject({ status: 'ready' });
    expect(git('diff', '--cached', '--name-only').trim().split('\n')).toHaveLength(200);
  });

  it.each(['--assume-unchanged', '--skip-worktree'])('[r4-5] both subjects include a %s edit before reset', async (flag) => {
    const start = join(root, 'start.json');
    runtime('capture', '--output', start);
    git('update-index', flag, '--', 'src/nested/a.txt');
    const review = await snapshotHarnessReviewSubject(cwd);
    const stage = await snapshotHarnessStageSubject(cwd);
    const index = readFileSync(join(cwd, '.git/index'));
    writeFileSync(join(cwd, 'src/nested/a.txt'), 'hidden edit\n');
    expect(await snapshotHarnessReviewSubject(cwd)).not.toBe(review);
    expect(await snapshotHarnessStageSubject(cwd)).not.toBe(stage);
    expect(readFileSync(join(cwd, '.git/index'))).toEqual(index);
    resetIndexToHead(cwd);
    expect(git('ls-files', '-v', 'src/nested/a.txt')).toBe('H src/nested/a.txt\n');
    const paths = join(root, 'paths.txt');
    writeFileSync(paths, 'src/nested/a.txt\n');
    expect(runtime('stage', '--start-state', start, '--paths-file', paths)).toMatchObject({ status: 'ready' });
  });

  it('guard: [r4-5] subjects ignore staging representation and absent out-of-cone files', async () => {
    // A branch change belongs in the subject; sparse configuration does not.
    git('sparse-checkout', 'init', '--cone');
    const review = await snapshotHarnessReviewSubject(cwd);
    const stage = await snapshotHarnessStageSubject(cwd);
    git('sparse-checkout', 'set', 'src');
    expect(await snapshotHarnessReviewSubject(cwd)).toBe(review);
    expect(await snapshotHarnessStageSubject(cwd)).toBe(stage);
    writeFileSync(join(cwd, 'src/new.txt'), 'new\n');
    const changedReview = await snapshotHarnessReviewSubject(cwd);
    const changedStage = await snapshotHarnessStageSubject(cwd);
    const index = readFileSync(join(cwd, '.git/index'));
    expect(await snapshotHarnessReviewSubject(cwd)).toBe(changedReview);
    expect(readFileSync(join(cwd, '.git/index'))).toEqual(index);
    git('add', '-N', 'src/new.txt');
    expect(await snapshotHarnessReviewSubject(cwd)).toBe(changedReview);
    expect(await snapshotHarnessStageSubject(cwd)).toBe(changedStage);
    git('add', 'src/new.txt');
    expect(await snapshotHarnessReviewSubject(cwd)).toBe(changedReview);
    expect(await snapshotHarnessStageSubject(cwd)).toBe(changedStage);
  });
});
