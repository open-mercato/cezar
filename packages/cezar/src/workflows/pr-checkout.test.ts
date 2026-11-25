import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkoutPr, parsePrUrl, prRemote, type Exec } from './pr-checkout.ts';

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const PR = { host: 'github.com', owner: 'o', repo: 'r', number: 7, url: 'https://github.com/o/r/pull/7' };

describe('parsePrUrl', () => {
  it('reads the first GitHub PR URL in the task text', () => {
    expect(parsePrUrl('please review https://github.com/acme/app.git/pull/5700 carefully')).toMatchObject({ owner: 'acme', repo: 'app', number: 5700 });
    expect(parsePrUrl('https://example.com/o/r/pull/1')).toBeUndefined();
    expect(parsePrUrl('review #12')).toBeUndefined();
  });
});

/** A scripted exec: answers by the joined argv's prefix (first match wins), and records every call. */
function scripted(answers: Array<[string, { ok: boolean; stdout?: string; stderr?: string }]>) {
  const calls: string[] = [];
  const exec: Exec = async (file, args) => {
    const line = [file, ...args].join(' ');
    calls.push(line);
    const hit = answers.find(([prefix]) => line.startsWith(prefix));
    return { ok: hit?.[1].ok ?? false, stdout: hit?.[1].stdout ?? '', stderr: hit?.[1].stderr ?? `unscripted: ${line}` };
  };
  return { exec, calls };
}

describe('prRemote', () => {
  it("picks the remote that is the PR's repository in a fork clone, case-insensitively", async () => {
    const { exec } = scripted([['git config --get-regexp', { ok: true, stdout: [
      'remote.origin.url git@github.com:me/r.git',
      'remote.upstream.url https://GitHub.com/O/R.git',
    ].join('\n') }]]);
    expect(await prRemote('/w', PR, exec)).toBe('upstream');
  });
  it("picks none when no remote is the PR's repository", async () => {
    const { exec } = scripted([['git config --get-regexp', { ok: true, stdout: 'remote.origin.url git@github.com:me/r.git' }]]);
    expect(await prRemote('/w', PR, exec)).toBeUndefined();
  });
});

describe('checkoutPr, scripted', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cez-pr-scripted-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const GHE = { host: 'ghe.example.com', owner: 'o', repo: 'r', number: 3, url: 'https://ghe.example.com/o/r/pull/3' };

  it('under CEZ_DRY_RUN runs no gh and no git fetch, and exports nothing', async () => {
    const { exec, calls } = scripted([['git config', { ok: true, stdout: '' }]]);
    const res = await checkoutPr({ cwd: '/w', dir: join(dir, 'pr'), pr: PR, offline: true, exec });
    expect(calls.filter((c) => c.startsWith('gh ') || c.startsWith('git fetch') || c.includes('checkout-index'))).toEqual([]);
    expect(res.checkedOut).toBe(false);
    expect(res.problems).toContain('CEZ_DRY_RUN=1: the PR was not fetched or checked out');
    expect(JSON.parse(readFileSync(res.metaPath, 'utf8'))).toMatchObject({ number: 7, checkedOut: false, headVerified: false });
  });

  it('records an unreadable FETCH_HEAD and stops', async () => {
    const { exec, calls } = scripted([
      ['git config', { ok: true, stdout: '' }],
      ['gh pr view', { ok: true, stdout: '{}' }],
      ['gh pr diff', { ok: true, stdout: 'D' }],
      ['git fetch', { ok: true }],
      ['git rev-parse --verify FETCH_HEAD', { ok: false, stderr: 'fatal: bad object' }],
    ]);
    const res = await checkoutPr({ cwd: '/w', dir: join(dir, 'pr'), pr: PR, exec });
    expect(res.problems).toContain('fetched pull/7/head but could not read it — fatal: bad object');
    expect(res.checkedOut).toBe(false);
    expect(calls.some((c) => c.includes('read-tree'))).toBe(false);
  });

  it('names an Enterprise repo with its host, merges metadata, and falls back to the local baseRefName', async () => {
    const { exec, calls } = scripted([
      ['git config', { ok: true, stdout: '' }],
      ['gh pr view', { ok: true, stdout: JSON.stringify({ title: 'Fix it', baseRefName: 'develop', number: 3 }) }],
      ['gh pr diff', { ok: false, stderr: 'warning\nHTTP 502: bad gateway' }],
      ['git fetch --no-tags --quiet https://ghe.example.com/o/r.git +refs/heads/develop', { ok: false, stderr: 'fatal: offline' }],
      ['git fetch', { ok: true }],
      ['git rev-parse --verify FETCH_HEAD', { ok: true, stdout: 'abc123\n' }],
      ['git -c core.symlinks=false read-tree abc123', { ok: true }],
      ['git -c core.symlinks=false checkout-index', { ok: true }],
      ['git rev-parse --verify develop^{commit}', { ok: true, stdout: 'd1\n' }],
      ['git merge-base develop abc123', { ok: true, stdout: 'base1\n' }],
      ['git diff --no-color --no-ext-diff base1 abc123', { ok: true, stdout: 'DIFF' }],
    ]);
    const res = await checkoutPr({ cwd: '/w', dir: join(dir, 'pr'), pr: GHE, baseBranch: 'main', exec });
    expect(calls).toContain('git fetch --no-tags --quiet https://ghe.example.com/o/r.git +refs/pull/3/head');
    expect(calls.find((c) => c.startsWith('gh pr view'))).toContain('--repo ghe.example.com/o/r');
    expect(calls.find((c) => c.startsWith('gh pr diff'))).toContain('--repo ghe.example.com/o/r');
    expect(res.problems).toEqual([
      'gh pr diff failed — HTTP 502: bad gateway',
      'the diff is against the local develop, which may be behind the PR\'s base',
    ]);
    expect(readFileSync(res.diffPath, 'utf8')).toBe('DIFF');
    // gh named no head, so nothing from GitHub confirms the fetched one.
    expect(JSON.parse(readFileSync(res.metaPath, 'utf8'))).toMatchObject({
      title: 'Fix it', baseRefName: 'develop', headRefOid: 'abc123', headVerified: false, diffBase: 'local develop (may be stale)', checkedOut: true,
    });
  });

  it('reports a failed gh pr view and keeps what it knows', async () => {
    const { exec } = scripted([
      ['git config', { ok: true, stdout: '' }],
      ['gh pr view', { ok: false, stderr: 'GraphQL: Could not resolve to a PullRequest' }],
      ['gh pr diff', { ok: true, stdout: 'GH DIFF' }],
      ['git fetch', { ok: false, stderr: 'fatal: could not read from remote' }],
    ]);
    const res = await checkoutPr({ cwd: '/w', dir: join(dir, 'pr'), pr: { ...PR, number: 9 }, exec });
    expect(res.problems).toEqual([
      'gh pr view failed — GraphQL: Could not resolve to a PullRequest',
      'git fetch https://github.com/o/r.git pull/9/head failed — fatal: could not read from remote',
    ]);
    expect(readFileSync(res.diffPath, 'utf8')).toBe('GH DIFF');
    expect(JSON.parse(readFileSync(res.metaPath, 'utf8'))).toEqual({ number: 9, url: PR.url, repository: 'o/r', headVerified: false, diffBase: 'github', checkedOut: false });
  });
});

// Real git against a local "origin" that carries refs/pull/7/head, as GitHub does.
describe('checkoutPr', { timeout: 30_000 }, () => {
  let root: string; let origin: string; let work: string; let dir: string; let artifacts: string; let prSha: string; let baseSha: string;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 10_000 }).trim();
  const realExec: Exec = (file, args, { cwd, timeoutMs, env }) => new Promise((done) => {
    try {
      done({ ok: true, stdout: execFileSync(file, args, { cwd, encoding: 'utf8', stdio: 'pipe', timeout: timeoutMs, ...(env ? { env } : {}) }), stderr: '' });
    } catch (err) {
      done({ ok: false, stdout: '', stderr: String((err as { stderr?: unknown }).stderr ?? err) });
    }
  });
  /** Real git; `gh` reports `ghHead` as the PR's head, or is unavailable. */
  const withGh = (ghHead?: string): Exec => (file, args, opts) => {
    if (file !== 'gh') return realExec(file, args, opts);
    if (!ghHead) return Promise.resolve({ ok: false, stdout: '', stderr: 'gh: offline' });
    return Promise.resolve(args[1] === 'view'
      ? { ok: true, stdout: JSON.stringify({ number: 7, headRefOid: ghHead, baseRefName: 'main' }), stderr: '' }
      : { ok: true, stdout: 'diff from gh\n', stderr: '' });
  };
  const pushPr = (files: Record<string, string>, from = prSha) => {
    git(work, 'checkout', '-q', '--detach', from);
    for (const [path, text] of Object.entries(files)) writeFileSync(join(work, path), text);
    git(work, 'add', '-A'); git(work, ...GIT_ID, 'commit', '-q', '-m', 'pr update');
    const sha = git(work, 'rev-parse', 'HEAD');
    git(work, 'push', '-q', '-f', 'origin', 'HEAD:refs/pull/7/head');
    git(work, 'checkout', '-q', 'cez/task');
    return sha;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-pr-checkout-'));
    origin = join(root, 'origin.git'); work = join(root, 'work'); dir = join(root, 'pr-checkouts', 'run'); artifacts = join(root, 'artifacts');
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
    // `origin` is a local path, so no remote names o/r: the checkout fetches the PR's URL, mapped here.
    git(work, 'config', `url.${origin}.insteadOf`, 'https://github.com/o/r.git');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("exports the PR head to its own folder and never touches the task's tree or branch", async () => {
    // Work of the task's own: a commit, an edit, and untracked/ignored files at paths the PR tracks.
    writeFileSync(join(work, 'b.txt'), 'autosave\n');
    git(work, 'add', '-A'); git(work, ...GIT_ID, 'commit', '-q', '-m', 'cezar autosave');
    const own = git(work, 'rev-parse', 'HEAD');
    pushPr({ 'seeded.env': 'from the PR\n' });
    writeFileSync(join(work, 'b.txt'), 'uncommitted\n');
    const prHead = git(work, 'ls-remote', origin, 'refs/pull/7/head').split('\t')[0]!;
    writeFileSync(join(work, '.git', 'info', 'exclude'), 'seeded.env\n');
    writeFileSync(join(work, 'seeded.env'), 'SECRET=local\n');

    const res = await checkoutPr({ cwd: work, dir, copyTo: artifacts, pr: PR, baseBranch: 'main', exec: withGh(prHead) });
    expect(res.problems).toEqual([]);
    expect(res.checkedOut).toBe(true);
    expect(res.tree).toBe(join(dir, 'tree'));
    expect(readFileSync(join(res.tree, 'a.txt'), 'utf8')).toBe('one\ntwo from the PR\n');
    expect(readFileSync(join(res.tree, 'seeded.env'), 'utf8')).toBe('from the PR\n');
    // The task: same branch, same commit, same files, index untouched.
    expect(git(work, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('cez/task');
    expect(git(work, 'rev-parse', 'HEAD')).toBe(own);
    expect(readFileSync(join(work, 'a.txt'), 'utf8')).toBe('one\n');
    expect(readFileSync(join(work, 'b.txt'), 'utf8')).toBe('uncommitted\n');
    expect(readFileSync(join(work, 'seeded.env'), 'utf8')).toBe('SECRET=local\n');
    expect(git(work, 'status', '--porcelain', '--untracked-files=no')).toBe('M b.txt');
    expect(JSON.parse(readFileSync(res.metaPath, 'utf8'))).toMatchObject({ headRefOid: prHead, headVerified: true, diffBase: 'github', checkedOut: true });
    // The user's copies sit in the artifacts; the agents read the ones beside the tree.
    expect(readFileSync(join(artifacts, 'pr-7.diff'), 'utf8')).toBe('diff from gh\n');
    expect(res.diffPath).toBe(join(dir, 'pr-7.diff'));
  });

  it('re-exports a newer head after a push to the PR, leaving nothing of the old one', async () => {
    await checkoutPr({ cwd: work, dir, pr: PR, baseBranch: 'main', exec: withGh(prSha) });
    writeFileSync(join(dir, 'tree', 'stale.txt'), 'left over\n');
    const newer = pushPr({ 'a.txt': 'one\nthree, after review\n' });
    const res = await checkoutPr({ cwd: work, dir, pr: PR, baseBranch: 'main', exec: withGh(newer) });
    expect(res.checkedOut).toBe(true);
    expect(res.head).toBe(newer);
    expect(readFileSync(join(res.tree, 'a.txt'), 'utf8')).toBe('one\nthree, after review\n');
    expect(existsSync(join(res.tree, 'stale.txt'))).toBe(false);
  });

  it("fetches the PR's own repository URL, never another remote's pull ref", async () => {
    // `other` has a refs/pull/7/head too — of a different repository. It must not be used.
    const other = join(root, 'other.git');
    git(root, 'init', '-q', '--bare', '-b', 'main', other);
    git(work, 'push', '-q', other, `${baseSha}:refs/pull/7/head`);
    git(work, 'remote', 'set-url', 'origin', other);
    const res = await checkoutPr({ cwd: work, dir, pr: PR, baseBranch: 'main', exec: withGh(prSha) });
    expect(res.head).toBe(prSha);
    expect(res.checkedOut).toBe(true);
  });

  it("refuses a fetched head that is not the PR's head", async () => {
    const res = await checkoutPr({ cwd: work, dir, pr: PR, baseBranch: 'main', exec: withGh(baseSha) });
    expect(res.checkedOut).toBe(false);
    expect(res.head).toBe('');
    expect(res.problems.join('\n')).toContain("not the PR's head");
    expect(existsSync(join(dir, 'tree'))).toBe(false);
  });

  it('exports nothing when the PR ref cannot be fetched', async () => {
    const res = await checkoutPr({ cwd: work, dir, pr: { ...PR, number: 8 }, baseBranch: 'main', exec: withGh() });
    expect(res.checkedOut).toBe(false);
    expect(res.problems.join('\n')).toContain('git fetch https://github.com/o/r.git pull/8/head failed');
    expect(JSON.parse(readFileSync(res.metaPath, 'utf8'))).toMatchObject({ number: 8, checkedOut: false });
    expect(res.diffPath).toBe('');
  });

  it("writes a PR's symlink as a plain file, so it cannot point a reader elsewhere", async () => {
    git(work, 'checkout', '-q', '--detach', prSha);
    symlinkSync('/etc/passwd', join(work, 'link'));
    git(work, 'add', '-A'); git(work, ...GIT_ID, 'commit', '-q', '-m', 'pr adds a link');
    const head = git(work, 'rev-parse', 'HEAD');
    git(work, 'push', '-q', '-f', 'origin', 'HEAD:refs/pull/7/head');
    git(work, 'checkout', '-q', 'cez/task');
    const res = await checkoutPr({ cwd: work, dir, pr: PR, baseBranch: 'main', exec: withGh(head) });
    expect(lstatSync(join(res.tree, 'link')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(res.tree, 'link'), 'utf8')).toBe('/etc/passwd');
  });

  it("without gh diffs against the PR's base fetched fresh, not a stale local one", async () => {
    // origin/main moved on and the PR forked from there; the local main is still behind.
    git(work, 'checkout', '-q', '--detach', baseSha);
    writeFileSync(join(work, 'upstream.txt'), 'landed upstream\n');
    git(work, 'add', '-A'); git(work, ...GIT_ID, 'commit', '-q', '-m', 'upstream');
    git(work, 'push', '-q', 'origin', 'HEAD:main');
    const head = pushPr({ 'a.txt': 'one\nthe PR on a fresh base\n' }, git(work, 'rev-parse', 'HEAD'));
    expect(git(work, 'rev-parse', 'main')).toBe(baseSha);
    const res = await checkoutPr({ cwd: work, dir, pr: PR, baseBranch: 'main', exec: withGh() });
    expect(res.head).toBe(head);
    const diff = readFileSync(res.diffPath, 'utf8');
    expect(diff).toContain('+the PR on a fresh base');
    expect(diff).not.toContain('upstream.txt');
    expect(JSON.parse(readFileSync(res.metaPath, 'utf8'))).toMatchObject({ headVerified: false, diffBase: 'main fetched from https://github.com/o/r.git' });
    expect(res.problems).toEqual(['gh pr view failed — gh: offline', 'gh pr diff failed — gh: offline']);
  });

  it('says so when it can only diff against a local base', async () => {
    git(work, 'branch', '-q', 'trunk', baseSha);
    const res = await checkoutPr({ cwd: work, dir, pr: PR, baseBranch: 'trunk', exec: withGh() });
    expect(readFileSync(res.diffPath, 'utf8')).toContain('+two from the PR');
    expect(res.problems).toContain('the diff is against the local trunk, which may be behind the PR\'s base');
    expect(JSON.parse(readFileSync(res.metaPath, 'utf8'))).toMatchObject({ diffBase: 'local trunk (may be stale)' });
  });
});
