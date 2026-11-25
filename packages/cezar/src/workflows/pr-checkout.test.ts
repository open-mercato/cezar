import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** Real git, and a `gh` that is not there: the git-only path, hermetic. */
const realExec: Exec = (file, args, { cwd, timeoutMs }) => new Promise((done) => {
  try {
    done({ ok: true, stdout: execFileSync(file, args, { cwd, encoding: 'utf8', stdio: 'pipe', timeout: timeoutMs }), stderr: '' });
  } catch (err) {
    done({ ok: false, stdout: '', stderr: String((err as { stderr?: unknown }).stderr ?? err) });
  }
});
const noGh: Exec = (file, args, opts) => (file === 'gh' ? Promise.resolve({ ok: false, stdout: '', stderr: 'gh: offline' }) : realExec(file, args, opts));

/** A scripted exec: answers by the joined argv's prefix, and records every call. */
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
  it('picks none when no remote is the PR\'s repository', async () => {
    const { exec } = scripted([['git config --get-regexp', { ok: true, stdout: 'remote.origin.url git@github.com:me/r.git' }]]);
    expect(await prRemote('/w', PR, exec)).toBeUndefined();
  });
});

describe('checkoutPr through gh', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cez-pr-gh-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const GHE = { host: 'ghe.example.com', owner: 'o', repo: 'r', number: 3, url: 'https://ghe.example.com/o/r/pull/3' };

  it('names an Enterprise repo with its host, merges the metadata and diffs against its baseRefName', async () => {
    const { exec, calls } = scripted([
      ['git config', { ok: true, stdout: '' }],
      ['git fetch', { ok: true }],
      ['git rev-parse --verify FETCH_HEAD', { ok: true, stdout: 'abc123\n' }],
      ['gh pr view', { ok: true, stdout: JSON.stringify({ title: 'Fix it', baseRefName: 'develop', number: 3 }) }],
      ['gh pr diff', { ok: false, stderr: 'warning\nHTTP 502: bad gateway' }],
      ['git merge-base develop abc123', { ok: true, stdout: 'base1\n' }],
      ['git diff --no-color --no-ext-diff base1 abc123', { ok: true, stdout: 'DIFF' }],
    ]);
    const res = await checkoutPr({ cwd: '/w', artifactsDir: dir, pr: GHE, ownWorktree: false, baseBranch: 'main', exec });
    expect(calls).toContain('git fetch --no-tags --quiet https://ghe.example.com/o/r.git +refs/pull/3/head');
    expect(calls.find((c) => c.startsWith('gh pr view'))).toContain('--repo ghe.example.com/o/r');
    expect(calls.find((c) => c.startsWith('gh pr diff'))).toContain('--repo ghe.example.com/o/r');
    // The last stderr line, which is where gh puts the error.
    expect(res.problems).toContain('gh pr diff failed — HTTP 502: bad gateway');
    expect(readFileSync(res.diffPath, 'utf8')).toBe('DIFF');
    expect(JSON.parse(readFileSync(res.metaPath, 'utf8'))).toMatchObject({ title: 'Fix it', baseRefName: 'develop', headRefOid: 'abc123', repository: 'o/r', checkedOut: false });
  });

  it('reports a failed gh pr view and keeps what git knows', async () => {
    const { exec } = scripted([
      ['git config', { ok: true, stdout: '' }],
      ['git fetch', { ok: false, stderr: 'fatal: could not read from remote' }],
      ['gh pr view', { ok: false, stderr: 'GraphQL: Could not resolve to a PullRequest' }],
      ['gh pr diff', { ok: true, stdout: 'GH DIFF' }],
    ]);
    const res = await checkoutPr({ cwd: '/w', artifactsDir: dir, pr: { ...PR, number: 9 }, ownWorktree: true, exec });
    expect(res.problems).toEqual([
      'gh pr view failed — GraphQL: Could not resolve to a PullRequest',
      'git fetch https://github.com/o/r.git pull/9/head failed — fatal: could not read from remote',
    ]);
    expect(readFileSync(res.diffPath, 'utf8')).toBe('GH DIFF');
    expect(JSON.parse(readFileSync(res.metaPath, 'utf8'))).toEqual({ number: 9, url: PR.url, repository: 'o/r', checkedOut: false });
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
    // `origin` is a local path, so no remote names o/r: the checkout fetches the PR's URL, mapped here.
    git(work, 'config', `url.${origin}.insteadOf`, 'https://github.com/o/r.git');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('checks the PR head out and saves its metadata and diff', async () => {
    const res = await checkoutPr({ cwd: work, artifactsDir: artifacts, pr: PR, ownWorktree: true, baseBranch: 'main', offline: false, exec: noGh });
    expect(res.problems).toEqual(['gh pr view failed — gh: offline', 'gh pr diff failed — gh: offline']);
    expect(res.checkedOut).toBe(true);
    expect(res.head).toBe(prSha);
    expect(git(work, 'rev-parse', 'HEAD')).toBe(prSha);
    expect(readFileSync(join(work, 'a.txt'), 'utf8')).toContain('two from the PR');
    expect(readFileSync(res.diffPath, 'utf8')).toContain('+two from the PR');
    expect(JSON.parse(readFileSync(res.metaPath, 'utf8'))).toMatchObject({ number: 7, headRefOid: prSha, checkedOut: true });
  });

  it('fails without touching the tree when the PR ref cannot be fetched', async () => {
    const res = await checkoutPr({ cwd: work, artifactsDir: artifacts, pr: { ...PR, number: 8 }, ownWorktree: true, baseBranch: 'main', offline: false, exec: noGh });
    expect(res.checkedOut).toBe(false);
    expect(res.problems.join('\n')).toContain('git fetch https://github.com/o/r.git pull/8/head failed');
    expect(git(work, 'rev-parse', 'HEAD')).toBe(baseSha);
    // Still records what it knows, so a reviewer sees why there is no diff.
    expect(JSON.parse(readFileSync(res.metaPath, 'utf8'))).toMatchObject({ number: 8, checkedOut: false });
    expect(res.diffPath).toBe('');
  });

  it("fetches the PR's own repository URL, never another remote's pull ref", async () => {
    // `other` also has a refs/pull/7/head — of a different repository. It must not be used.
    const other = join(root, 'other.git');
    git(root, 'init', '-q', '--bare', '-b', 'main', other);
    git(work, 'push', '-q', other, `${baseSha}:refs/pull/7/head`);
    git(work, 'remote', 'set-url', 'origin', other);
    const res = await checkoutPr({ cwd: work, artifactsDir: artifacts, pr: PR, ownWorktree: true, baseBranch: 'main', offline: false, exec: noGh });
    expect(res.head).toBe(prSha);
    expect(res.checkedOut).toBe(true);
  });

  it('refuses to drop commits the task branch already has', async () => {
    writeFileSync(join(work, 'b.txt'), 'autosave\n');
    git(work, 'add', '-A'); git(work, ...GIT_ID, 'commit', '-q', '-m', 'cezar autosave');
    const own = git(work, 'rev-parse', 'HEAD');
    const res = await checkoutPr({ cwd: work, artifactsDir: artifacts, pr: PR, ownWorktree: true, baseBranch: 'main', offline: false, exec: noGh });
    expect(res.checkedOut).toBe(false);
    expect(res.problems.join('\n')).toContain('1 commit(s) of its own');
    expect(git(work, 'rev-parse', 'HEAD')).toBe(own);
  });

  it('refuses to overwrite untracked or ignored files at paths the PR tracks', async () => {
    // The PR adds `seeded.env`; the worktree already has an ignored file there.
    git(work, 'checkout', '-q', '--detach', prSha);
    writeFileSync(join(work, 'seeded.env'), 'from the PR\n');
    git(work, 'add', '-A'); git(work, ...GIT_ID, 'commit', '-q', '-m', 'pr adds seeded.env');
    git(work, 'push', '-q', '-f', 'origin', 'HEAD:refs/pull/7/head');
    git(work, 'checkout', '-q', 'cez/task');
    writeFileSync(join(work, '.git', 'info', 'exclude'), 'seeded.env\n');
    writeFileSync(join(work, 'seeded.env'), 'SECRET=local\n');
    const res = await checkoutPr({ cwd: work, artifactsDir: artifacts, pr: PR, ownWorktree: true, baseBranch: 'main', offline: false, exec: noGh });
    expect(res.checkedOut).toBe(false);
    expect(res.problems.join('\n')).toContain('untracked or ignored files would be overwritten (seeded.env)');
    expect(readFileSync(join(work, 'seeded.env'), 'utf8')).toBe('SECRET=local\n');
  });

  it('lets the PR add files beside an untracked folder\'s own files', async () => {
    // The PR adds .claude/settings.json; the worktree has only a seeded .claude/settings.local.json.
    git(work, 'checkout', '-q', '--detach', prSha);
    mkdirSync(join(work, '.claude'), { recursive: true });
    writeFileSync(join(work, '.claude', 'settings.json'), '{}\n');
    git(work, 'add', '-A'); git(work, ...GIT_ID, 'commit', '-q', '-m', 'pr adds .claude/settings.json');
    const head = git(work, 'rev-parse', 'HEAD');
    git(work, 'push', '-q', '-f', 'origin', 'HEAD:refs/pull/7/head');
    git(work, 'checkout', '-q', 'cez/task');
    mkdirSync(join(work, '.claude'), { recursive: true });
    writeFileSync(join(work, '.claude', 'settings.local.json'), '{"seeded":true}\n');
    const res = await checkoutPr({ cwd: work, artifactsDir: artifacts, pr: PR, ownWorktree: true, baseBranch: 'main', offline: false, exec: noGh });
    expect(res.checkedOut).toBe(true);
    expect(res.head).toBe(head);
    expect(readFileSync(join(work, '.claude', 'settings.local.json'), 'utf8')).toBe('{"seeded":true}\n');
  });

  it('under CEZ_DRY_RUN fetches and checks out nothing', async () => {
    const res = await checkoutPr({ cwd: work, artifactsDir: artifacts, pr: PR, ownWorktree: true, baseBranch: 'main', offline: true });
    expect(res.checkedOut).toBe(false);
    expect(res.problems.join('\n')).toContain('CEZ_DRY_RUN=1');
    expect(git(work, 'rev-parse', 'HEAD')).toBe(baseSha);
  });

  it("never resets the repository's own working tree", async () => {
    const res = await checkoutPr({ cwd: work, artifactsDir: artifacts, pr: PR, ownWorktree: false, baseBranch: 'main', offline: false, exec: noGh });
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
    const res = await checkoutPr({ cwd: work, artifactsDir: artifacts, pr: PR, ownWorktree: true, baseBranch: 'main', offline: false, exec: noGh });
    expect(res.checkedOut).toBe(false);
    expect(readFileSync(join(work, 'a.txt'), 'utf8')).toBe('local edit\n');
    expect(existsSync(res.metaPath)).toBe(true);
  });
});
