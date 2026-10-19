import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorktree } from '../git-worktree.ts';
import { selfMergeBranch } from './self-merge.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * `selfMergeBranch` (agents-master I050 "Closer 2") against real repositories: the merge path,
 * and every refusal leaving the base branch exactly where it was.
 */
describe('selfMergeBranch', () => {
  let dir: string;
  let repoRoot: string;
  let worktreePath: string;
  let branch: string;
  const savedDryRun = process.env.CEZ_DRY_RUN;

  const git = async (cwd: string, ...args: string[]) => (await run('git', [...GIT_ID, ...args], { cwd })).stdout.trim();
  const headOf = (ref: string) => git(repoRoot, 'rev-parse', ref);
  const commitIn = async (cwd: string, file: string, content: string) => {
    writeFileSync(join(cwd, file), content);
    await git(cwd, 'add', '-A');
    await git(cwd, 'commit', '-q', '-m', `edit ${file}`);
  };

  beforeEach(async () => {
    delete process.env.CEZ_DRY_RUN;
    dir = mkdtempSync(join(tmpdir(), 'cez-selfmerge-'));
    repoRoot = join(dir, 'repo');
    await run('git', ['init', '-q', '-b', 'main', repoRoot]);
    await git(repoRoot, 'config', 'user.name', 'test');
    await git(repoRoot, 'config', 'user.email', 'test@local');
    writeFileSync(join(repoRoot, '.gitignore'), '.ai/\n');
    await commitIn(repoRoot, 'a.txt', 'one\n');
    const wt = await createWorktree(repoRoot, 'run-1234abcd', 'main');
    worktreePath = wt.path;
    branch = wt.branch;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  const merge = (checkCommand?: string) =>
    selfMergeBranch({ repoRoot, worktreePath, branch, base: 'main', ...(checkCommand ? { checkCommand } : {}) });

  it('merges a branch ahead of the base with a --no-ff merge commit in the main checkout', async () => {
    await commitIn(worktreePath, 'b.txt', 'two\n');
    const tip = await headOf(branch);
    const result = await merge();
    expect(result).toMatchObject({ outcome: 'merged', base: 'main', checked: false });
    expect(result.outcome === 'merged' && result.pushedTo).toBeFalsy();
    const head = await headOf('main');
    expect(result.outcome === 'merged' && result.sha).toBe(head);
    // Two parents: a real merge commit even though a fast-forward was possible.
    expect(await git(repoRoot, 'rev-parse', 'HEAD^2')).toBe(tip);
    expect(existsSync(join(repoRoot, 'b.txt'))).toBe(true);
  });

  it('runs the check on the merged tree and pushes to the base upstream', async () => {
    const remote = join(dir, 'remote.git');
    await run('git', ['init', '-q', '--bare', remote]);
    await git(repoRoot, 'remote', 'add', 'origin', remote);
    await git(repoRoot, 'push', '-q', '-u', 'origin', 'main');
    await commitIn(worktreePath, 'b.txt', 'two\n');
    const result = await merge('test -f b.txt');
    expect(result).toMatchObject({ outcome: 'merged', checked: true, pushedTo: 'origin/main' });
    expect(await git(remote, 'rev-parse', 'main')).toBe(await headOf('main'));
  });

  it('answers nothing when the branch has no commits the base lacks', async () => {
    const before = await headOf('main');
    expect(await merge()).toEqual({ outcome: 'nothing' });
    expect(await headOf('main')).toBe(before);
  });

  it('refuses when the main checkout is not on the base branch', async () => {
    await commitIn(worktreePath, 'b.txt', 'two\n');
    await git(repoRoot, 'checkout', '-q', '-b', 'side');
    const before = await headOf('main');
    const result = await merge();
    expect(result).toMatchObject({ outcome: 'blocked', reason: 'the main checkout is on "side", not "main"' });
    expect(await headOf('main')).toBe(before);
  });

  it('refuses when the main checkout has tracked changes', async () => {
    await commitIn(worktreePath, 'b.txt', 'two\n');
    writeFileSync(join(repoRoot, 'a.txt'), 'dirty\n');
    const before = await headOf('main');
    const result = await merge();
    expect(result).toMatchObject({ outcome: 'blocked', reason: 'the main checkout has uncommitted changes to tracked files' });
    expect(await headOf('main')).toBe(before);
  });

  it('refuses when the task worktree has uncommitted tracked changes', async () => {
    await commitIn(worktreePath, 'b.txt', 'two\n');
    writeFileSync(join(worktreePath, 'b.txt'), 'unsaved\n');
    const result = await merge();
    expect(result).toMatchObject({ outcome: 'blocked', reason: 'the task worktree has uncommitted changes' });
  });

  it('aborts a conflicting merge and leaves the base untouched', async () => {
    await commitIn(worktreePath, 'a.txt', 'theirs\n');
    await commitIn(repoRoot, 'a.txt', 'ours\n');
    const before = await headOf('main');
    const result = await merge();
    expect(result.outcome).toBe('blocked');
    expect(result.outcome === 'blocked' && result.reason).toContain('conflicts in a.txt');
    expect(await headOf('main')).toBe(before);
    expect(existsSync(join(repoRoot, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(await git(repoRoot, 'status', '--porcelain', '--untracked-files=no')).toBe('');
  });

  it('aborts the merge when the check fails and leaves the base untouched', async () => {
    await commitIn(worktreePath, 'b.txt', 'two\n');
    const before = await headOf('main');
    const result = await merge('echo boom && exit 3');
    expect(result.outcome).toBe('blocked');
    expect(result.outcome === 'blocked' && result.reason).toContain('the check `echo boom && exit 3` failed');
    expect(result.outcome === 'blocked' && result.reason).toContain('boom');
    expect(await headOf('main')).toBe(before);
    expect(existsSync(join(repoRoot, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(existsSync(join(repoRoot, 'b.txt'))).toBe(false);
  });

  it('reports a failed push with the local merge sha', async () => {
    await git(repoRoot, 'remote', 'add', 'origin', join(dir, 'missing.git'));
    await commitIn(worktreePath, 'b.txt', 'two\n');
    const result = await merge();
    expect(result.outcome).toBe('blocked');
    expect(result.outcome === 'blocked' && result.sha).toBe(await headOf('main'));
    expect(result.outcome === 'blocked' && result.reason).toContain('the push failed');
  });
});
