import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkoutPr, parsePrUrl } from './pr-checkout.ts';

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const PR = { host: 'github.com', owner: 'o', repo: 'r', number: 7, url: 'https://github.com/o/r/pull/7' };

describe('parsePrUrl', () => {
  it('reads the first GitHub PR URL in the task text', () => {
    expect(parsePrUrl('please review https://github.com/acme/app.git/pull/5700 carefully')).toMatchObject({ owner: 'acme', repo: 'app', number: 5700 });
    expect(parsePrUrl('https://example.com/o/r/pull/1')).toBeUndefined();
    expect(parsePrUrl('review #12')).toBeUndefined();
  });
});

// Real git against a local "origin" that carries refs/pull/7/head, as GitHub does.
describe('checkoutPr', { timeout: 30_000 }, () => {
  let root: string; let origin: string; let work: string; let artifacts: string; let prSha: string; let baseSha: string;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 10_000 }).trim();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-pr-checkout-'));
    origin = join(root, 'origin.git'); work = join(root, 'work'); artifacts = join(root, 'artifacts');
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    git(root, 'clone', '-q', origin, work);
    writeFileSync(join(work, 'a.txt'), 'one\n');
    git(work, 'add', '-A'); git(work, ...GIT_ID, 'commit', '-q', '-m', 'base'); git(work, 'push', '-q', 'origin', 'HEAD:main');
    baseSha = git(work, 'rev-parse', 'HEAD');
    // The PR: a commit only reachable through refs/pull/7/head.
    git(work, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(work, 'a.txt'), 'one\ntwo from the PR\n');
    git(work, ...GIT_ID, 'commit', '-q', '-am', 'pr change');
    prSha = git(work, 'rev-parse', 'HEAD');
    git(work, 'push', '-q', 'origin', 'HEAD:refs/pull/7/head');
    git(work, 'checkout', '-q', 'main'); git(work, 'branch', '-q', '-D', 'feature');
    git(work, 'checkout', '-q', '-b', 'cez/task');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('checks the PR head out and saves its metadata and diff', async () => {
    const res = await checkoutPr({ cwd: work, artifactsDir: artifacts, pr: PR, ownWorktree: true, baseBranch: 'main', offline: true });
    expect(res.problems).toEqual([]);
    expect(res.checkedOut).toBe(true);
    expect(res.head).toBe(prSha);
    expect(git(work, 'rev-parse', 'HEAD')).toBe(prSha);
    expect(readFileSync(join(work, 'a.txt'), 'utf8')).toContain('two from the PR');
    expect(readFileSync(res.diffPath, 'utf8')).toContain('+two from the PR');
    expect(JSON.parse(readFileSync(res.metaPath, 'utf8'))).toMatchObject({ number: 7, headRefOid: prSha, checkedOut: true });
  });

  it('fails without touching the tree when the PR ref cannot be fetched', async () => {
    const res = await checkoutPr({ cwd: work, artifactsDir: artifacts, pr: { ...PR, number: 8 }, ownWorktree: true, baseBranch: 'main', offline: true });
    expect(res.checkedOut).toBe(false);
    expect(res.problems.join('\n')).toContain('git fetch origin pull/8/head failed');
    expect(git(work, 'rev-parse', 'HEAD')).toBe(baseSha);
    // Still records what it knows, so a reviewer sees why there is no diff.
    expect(JSON.parse(readFileSync(res.metaPath, 'utf8'))).toMatchObject({ number: 8, checkedOut: false });
    expect(res.diffPath).toBe('');
  });

  it('fails when there is no remote at all', async () => {
    git(work, 'remote', 'remove', 'origin');
    const res = await checkoutPr({ cwd: work, artifactsDir: artifacts, pr: PR, ownWorktree: true, offline: true });
    expect(res.checkedOut).toBe(false);
    expect(res.problems.join('\n')).toContain('no git remote');
  });

  it("never resets the repository's own working tree", async () => {
    const res = await checkoutPr({ cwd: work, artifactsDir: artifacts, pr: PR, ownWorktree: false, baseBranch: 'main', offline: true });
    expect(res.checkedOut).toBe(false);
    expect(git(work, 'rev-parse', 'HEAD')).toBe(baseSha);
    // The fetched head still yields a diff for the reviewers.
    expect(readFileSync(res.diffPath, 'utf8')).toContain('+two from the PR');
  });

  // Real git, a scripted `gh` that reports `ghHead` as the PR's head.
  const withGh = (ghHead: string) => async (file: string, args: string[], opts: { cwd: string }) => {
    if (file === 'gh') {
      return args[1] === 'view'
        ? { ok: true, stdout: JSON.stringify({ number: 7, headRefOid: ghHead, baseRefName: 'main' }), stderr: '' }
        : { ok: true, stdout: 'diff from gh\n', stderr: '' };
    }
    try { return { ok: true, stdout: git(opts.cwd, ...args), stderr: '' }; } catch (e) { return { ok: false, stdout: '', stderr: String(e) }; }
  };

  it('checks out the fetched head when it matches the head gh reports', async () => {
    const res = await checkoutPr({ cwd: work, artifactsDir: artifacts, pr: PR, ownWorktree: true, baseBranch: 'main', exec: withGh(prSha) });
    expect(res.problems).toEqual([]);
    expect(res.checkedOut).toBe(true);
    expect(readFileSync(res.diffPath, 'utf8')).toBe('diff from gh\n');
  });

  it("refuses a fetched head that is not the PR's head (another repository's PR with that number)", async () => {
    const res = await checkoutPr({ cwd: work, artifactsDir: artifacts, pr: PR, ownWorktree: true, baseBranch: 'main', exec: withGh(baseSha) });
    expect(res.checkedOut).toBe(false);
    expect(res.head).toBe('');
    expect(res.problems.join('\n')).toContain("not the PR's head");
    expect(git(work, 'rev-parse', 'HEAD')).toBe(baseSha);
    expect(JSON.parse(readFileSync(res.metaPath, 'utf8'))).toMatchObject({ headRefOid: baseSha, checkedOut: false });
  });

  it('keeps uncommitted work', async () => {
    writeFileSync(join(work, 'a.txt'), 'local edit\n');
    const res = await checkoutPr({ cwd: work, artifactsDir: artifacts, pr: PR, ownWorktree: true, baseBranch: 'main', offline: true });
    expect(res.checkedOut).toBe(false);
    expect(readFileSync(join(work, 'a.txt'), 'utf8')).toBe('local edit\n');
    expect(existsSync(res.metaPath)).toBe(true);
  });
});
