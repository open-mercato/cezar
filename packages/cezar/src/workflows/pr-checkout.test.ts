import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { batchSshEnv, checkoutPr, parsePrUrl, pickPr, prRemote, prRemoteMatch, type Exec } from './pr-checkout.ts';

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const PR = { host: 'github.com', owner: 'o', repo: 'r', number: 7, url: 'https://github.com/o/r/pull/7' };
const REF_PREFIX = 'refs/cezar/pr-checkouts/test-run';
const NO_SLEEP = async () => {};
/** `git config --get-regexp` output naming `origin` as the PR's repository. */
const ORIGIN_IS_PR = { ok: true, stdout: 'remote.origin.url https://github.com/o/r.git' };

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
  it('matches an SSH host alias, but never the same owner/repo on another GitHub host, nor an unsafe remote name', async () => {
    const alias = scripted([['git config --get-regexp', { ok: true, stdout: 'remote.work.url git@github-work:o/r.git' }]]);
    expect(await prRemote('/w', PR, alias.exec)).toBe('work');
    const otherHost = scripted([['git config --get-regexp', { ok: true, stdout: 'remote.ghe.url https://foo.ghe.com/o/r.git' }]]);
    expect(await prRemote('/w', PR, otherHost.exec)).toBeUndefined();
    const unsafe = scripted([['git config --get-regexp', { ok: true, stdout: 'remote.-x.url https://github.com/o/r.git' }]]);
    expect(await prRemote('/w', PR, unsafe.exec)).toBeUndefined();
  });
  it('takes an alias only as an SSH URL on a host that is no other forge, and says it is one', async () => {
    const remotes = (url: string) => scripted([['git config --get-regexp', { ok: true, stdout: `remote.m.url ${url}` }]]).exec;
    expect(await prRemoteMatch('/w', PR, remotes('git@github-work:o/r.git'))).toEqual({ name: 'm', viaAlias: true });
    expect(await prRemoteMatch('/w', PR, remotes('ssh://git@github-work/o/r.git'))).toEqual({ name: 'm', viaAlias: true });
    expect(await prRemoteMatch('/w', PR, remotes('https://github.com/o/r.git'))).toEqual({ name: 'm', viaAlias: false });
    for (const other of ['git@gitlab.com:o/r.git', 'ssh://git@gitlab.internal.example/o/r.git', 'git@bitbucket.org:o/r.git', 'https://mirror.example/o/r.git']) {
      expect(await prRemoteMatch('/w', PR, remotes(other)), other).toBeUndefined();
    }
    // The PR's own host wins over an alias listed first.
    const both = scripted([['git config --get-regexp', { ok: true, stdout: 'remote.alias.url git@github-work:o/r.git\nremote.origin.url https://github.com/o/r.git' }]]);
    expect(await prRemoteMatch('/w', PR, both.exec)).toEqual({ name: 'origin', viaAlias: false });
  });

  it("picks none when no remote is the PR's repository", async () => {
    const { exec } = scripted([['git config --get-regexp', { ok: true, stdout: 'remote.origin.url git@github.com:me/r.git' }]]);
    expect(await prRemote('/w', PR, exec)).toBeUndefined();
  });
});

describe('batchSshEnv', () => {
  const config = (sshCommand?: string) => scripted([['git config --get core.sshCommand', sshCommand ? { ok: true, stdout: `${sshCommand}\n` } : { ok: false }]]);
  it("appends BatchMode to the user's own GIT_SSH_COMMAND, without asking git", async () => {
    const { exec, calls } = config('ssh -i ~/.ssh/other');
    expect((await batchSshEnv('/w', exec, { GIT_SSH_COMMAND: 'ssh -i ~/.ssh/work_key' }))?.GIT_SSH_COMMAND).toBe('ssh -i ~/.ssh/work_key -o BatchMode=yes');
    expect(calls).toEqual([]);
  });
  it("appends BatchMode to core.sshCommand, which GIT_SSH_COMMAND would otherwise override", async () => {
    expect((await batchSshEnv('/w', config('ssh -i ~/.ssh/work_key').exec, {}))?.GIT_SSH_COMMAND).toBe('ssh -i ~/.ssh/work_key -o BatchMode=yes');
  });
  it('uses plain ssh with BatchMode when nothing is set, and leaves a GIT_SSH program alone', async () => {
    expect((await batchSshEnv('/w', config().exec, {}))?.GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes');
    expect(await batchSshEnv('/w', config().exec, { GIT_SSH: '/usr/local/bin/my-ssh' })).toBeUndefined();
  });
});

describe('pickPr', () => {
  it("takes the first PR URL of a repository this checkout has a remote for, else the first", async () => {
    const { exec } = scripted([['git config --get-regexp', ORIGIN_IS_PR]]);
    const text = 'see https://github.com/evil/x/pull/1 first, then review https://github.com/o/r/pull/7';
    expect(await pickPr('/w', text, exec)).toMatchObject({ owner: 'o', repo: 'r', number: 7 });
    expect(await pickPr('/w', 'only https://github.com/evil/x/pull/1', exec)).toMatchObject({ owner: 'evil', number: 1 });
    expect(await pickPr('/w', 'no url', exec)).toBeUndefined();
  });
});

describe('checkoutPr, scripted', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cez-pr-scripted-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const GHE = { host: 'ghe.example.com', owner: 'o', repo: 'r', number: 3, url: 'https://ghe.example.com/o/r/pull/3' };

  it('under CEZ_DRY_RUN runs no gh and no git fetch, and exports nothing', async () => {
    const { exec, calls } = scripted([['git config', { ok: true, stdout: '' }]]);
    const res = await checkoutPr({ cwd: '/w', dir: join(dir, 'pr'), pr: PR, refPrefix: REF_PREFIX, offline: true, exec });
    expect(calls.filter((c) => c.startsWith('gh ') || c.startsWith('git fetch') || c.includes('checkout-index') || c.includes('update-ref'))).toEqual([]);
    expect(res.checkedOut).toBe(false);
    expect(res.problems).toContain('CEZ_DRY_RUN=1: the PR was not fetched or checked out');
    expect(JSON.parse(readFileSync(res.metaPath, 'utf8'))).toMatchObject({ number: 7, checkedOut: false, headVerified: false });
  });

  it("fetches from an SSH alias only when GitHub names the PR's head, with the user's SSH command kept", async () => {
    const answers = (view: string) => {
      const fetchEnvs: Array<string | undefined> = [];
      const exec: Exec = async (file, args, opts) => {
        const line = [file, ...args].join(' ');
        if (line.startsWith('git config --get-regexp')) return { ok: true, stdout: 'remote.work.url git@github-work:o/r.git', stderr: '' };
        if (line.startsWith('git config --get core.sshCommand')) return { ok: true, stdout: 'ssh -i ~/.ssh/work_key\n', stderr: '' };
        if (line.startsWith('gh pr view')) return { ok: true, stdout: view, stderr: '' };
        if (line.startsWith('gh pr diff')) return { ok: true, stdout: 'D', stderr: '' };
        if (line.startsWith('git fetch')) { fetchEnvs.push(opts.env?.GIT_SSH_COMMAND); return { ok: true, stdout: '', stderr: '' }; }
        if (line.startsWith('git rev-parse --verify')) return { ok: true, stdout: 'abc\n', stderr: '' };
        if (line.startsWith('git -c core.symlinks=false') || line.startsWith('git update-ref')) return { ok: true, stdout: '', stderr: '' };
        return { ok: false, stdout: '', stderr: `unscripted: ${line}` };
      };
      return { exec, fetchEnvs };
    };
    // Hermetic: the machine's own SSH settings play no part.
    vi.stubEnv('GIT_SSH_COMMAND', '');
    vi.stubEnv('GIT_SSH', '');
    const unverified = answers('{}');
    const refused = await checkoutPr({ cwd: '/w', dir: join(dir, 'a'), pr: PR, refPrefix: REF_PREFIX, exec: unverified.exec, sleep: NO_SLEEP });
    expect(unverified.fetchEnvs).toEqual([]);
    expect(refused.checkedOut).toBe(false);
    expect(refused.problems).toEqual(["the remote work is an SSH alias and GitHub did not confirm the PR's head; the PR was not fetched"]);
    const verified = answers(JSON.stringify({ headRefOid: 'abc' }));
    const ok = await checkoutPr({ cwd: '/w', dir: join(dir, 'b'), pr: PR, refPrefix: REF_PREFIX, exec: verified.exec, sleep: NO_SLEEP });
    expect(ok.checkedOut).toBe(true);
    expect(verified.fetchEnvs).toEqual(['ssh -i ~/.ssh/work_key -o BatchMode=yes']);
    vi.unstubAllEnvs();
  });

  it("fetches nothing from a repository this checkout has no remote for, and still saves gh's diff", async () => {
    const { exec, calls } = scripted([
      ['git config', { ok: true, stdout: 'remote.origin.url git@github.com:me/fork.git' }],
      ['gh pr view', { ok: true, stdout: '{}' }],
      ['gh pr diff', { ok: true, stdout: 'GH DIFF' }],
    ]);
    const res = await checkoutPr({ cwd: '/w', dir: join(dir, 'pr'), pr: PR, refPrefix: REF_PREFIX, exec });
    expect(calls.filter((c) => c.startsWith('git fetch'))).toEqual([]);
    expect(res.checkedOut).toBe(false);
    expect(res.problems).toEqual(['no remote of this repository is o/r on github.com; the PR was not fetched']);
    expect(readFileSync(res.diffPath, 'utf8')).toBe('GH DIFF');
  });

  it('never throws: an unwritable PR folder is a failed checkout', async () => {
    writeFileSync(join(dir, 'file'), 'x');
    const { exec } = scripted([['git config', ORIGIN_IS_PR]]);
    const res = await checkoutPr({ cwd: '/w', dir: join(dir, 'file', 'pr'), pr: PR, refPrefix: REF_PREFIX, exec });
    expect(res).toMatchObject({ checkedOut: false, head: '', tree: '', diffPath: '', metaPath: '' });
    expect(res.problems[0]).toMatch(/^the PR checkout failed — /);
  });

  it('never throws: an unwritable artifacts folder is a failed checkout, with no tree left behind', async () => {
    writeFileSync(join(dir, 'file'), 'x');
    const { exec } = scripted([
      ['git config', ORIGIN_IS_PR],
      ['gh pr view', { ok: true, stdout: JSON.stringify({ headRefOid: 'abc' }) }],
      ['gh pr diff', { ok: true, stdout: 'D' }],
      ['git fetch', { ok: true }],
      [`git rev-parse --verify ${REF_PREFIX}/head^{commit}`, { ok: true, stdout: 'abc\n' }],
      ['git -c core.symlinks=false read-tree', { ok: true }],
      ['git -c core.symlinks=false checkout-index', { ok: true }],
      ['git update-ref -d', { ok: true }],
    ]);
    const pr = join(dir, 'pr');
    const res = await checkoutPr({ cwd: '/w', dir: pr, copyTo: join(dir, 'file', 'artifacts'), pr: PR, refPrefix: REF_PREFIX, exec });
    expect(res.checkedOut).toBe(false);
    expect(res.problems[0]).toMatch(/^the PR checkout failed — /);
    expect(existsSync(join(pr, 'tree'))).toBe(false);
    // The metadata was written before the copy failed: it must not still claim a checkout.
    expect(readdirSync(pr).filter((f) => /^pr-\d+\.(json|diff)$/.test(f))).toEqual([]);
  });

  it('leaves no partial tree and no throwaway index when the export fails', async () => {
    const pr = join(dir, 'pr');
    const exec: Exec = async (file, args) => {
      const line = [file, ...args].join(' ');
      if (line.startsWith('git config')) return { ...ORIGIN_IS_PR, stderr: '' };
      if (line.startsWith('gh pr view')) return { ok: true, stdout: JSON.stringify({ headRefOid: 'abc' }), stderr: '' };
      if (line.startsWith('gh pr diff')) return { ok: true, stdout: 'D', stderr: '' };
      if (line.startsWith('git fetch') || line.startsWith('git update-ref') || line.includes('read-tree')) {
        if (line.includes('read-tree')) writeFileSync(join(pr, 'index.tmp'), 'idx');
        return { ok: true, stdout: '', stderr: '' };
      }
      if (line.startsWith('git rev-parse --verify')) return { ok: true, stdout: 'abc\n', stderr: '' };
      if (line.includes('checkout-index')) {
        // Half the files written, then the disk filled up.
        execFileSync('mkdir', ['-p', join(pr, 'tree', 'half')]);
        return { ok: false, stdout: '', stderr: 'error: unable to write file: No space left on device' };
      }
      return { ok: false, stdout: '', stderr: `unscripted: ${line}` };
    };
    const res = await checkoutPr({ cwd: '/w', dir: pr, pr: PR, refPrefix: REF_PREFIX, exec });
    expect(res.checkedOut).toBe(false);
    expect(res.problems).toEqual(['could not export abc — error: unable to write file: No space left on device']);
    expect(existsSync(join(pr, 'tree'))).toBe(false);
    expect(existsSync(join(pr, 'index.tmp'))).toBe(false);
  });

  it('refuses an unsafe base branch name instead of fetching it', async () => {
    const { exec, calls } = scripted([
      ['git config', ORIGIN_IS_PR],
      ['gh pr view', { ok: true, stdout: JSON.stringify({ baseRefName: '--upload-pack=touch /tmp/x' }) }],
      ['gh pr diff', { ok: false, stderr: 'HTTP 502' }],
      ['git fetch', { ok: true }],
      [`git rev-parse --verify ${REF_PREFIX}/head^{commit}`, { ok: true, stdout: 'abc\n' }],
      ['git -c core.symlinks=false', { ok: true }],
      ['git update-ref -d', { ok: true }],
    ]);
    const res = await checkoutPr({ cwd: '/w', dir: join(dir, 'pr'), pr: PR, refPrefix: REF_PREFIX, exec });
    expect(calls.filter((c) => c.includes('upload-pack'))).toEqual([]);
    expect(res.problems).toContain('the base branch name "--upload-pack=touch /tmp/x" is not a safe git ref; no diff was made');
  });

  it('records an unreadable fetched ref, cleans it up, and stops', async () => {
    const { exec, calls } = scripted([
      ['git config', ORIGIN_IS_PR],
      ['gh pr view', { ok: true, stdout: '{}' }],
      ['gh pr diff', { ok: true, stdout: 'D' }],
      ['git fetch', { ok: true }],
      [`git rev-parse --verify ${REF_PREFIX}/head^{commit}`, { ok: false, stderr: 'fatal: bad object' }],
      [`git update-ref -d ${REF_PREFIX}/head`, { ok: true }],
    ]);
    const res = await checkoutPr({ cwd: '/w', dir: join(dir, 'pr'), pr: PR, refPrefix: REF_PREFIX, exec });
    expect(res.problems).toContain('fetched pull/7/head but could not read it — fatal: bad object');
    expect(res.checkedOut).toBe(false);
    expect(calls.some((c) => c.includes('read-tree'))).toBe(false);
    expect(calls).toContain(`git update-ref -d ${REF_PREFIX}/head`);
  });

  it('re-fetches once after a short wait when refs/pull/N/head lags headRefOid', async () => {
    const waits: number[] = [];
    let headReads = 0;
    const exec: Exec = async (file, args) => {
      const line = [file, ...args].join(' ');
      if (line.startsWith('git config')) return { ...ORIGIN_IS_PR, stderr: '' };
      if (line.startsWith('gh pr view')) return { ok: true, stdout: JSON.stringify({ number: 7, headRefOid: 'newsha' }), stderr: '' };
      if (line.startsWith('gh pr diff')) return { ok: true, stdout: 'DIFF', stderr: '' };
      if (line.startsWith('git fetch')) return { ok: true, stdout: '', stderr: '' };
      if (line === `git rev-parse --verify ${REF_PREFIX}/head^{commit}`) {
        headReads += 1;
        return { ok: true, stdout: headReads === 1 ? 'oldsha\n' : 'newsha\n', stderr: '' };
      }
      if (line.startsWith('git -c core.symlinks=false read-tree newsha')) return { ok: true, stdout: '', stderr: '' };
      if (line.startsWith('git -c core.symlinks=false checkout-index')) return { ok: true, stdout: '', stderr: '' };
      if (line.startsWith('git update-ref -d')) return { ok: true, stdout: '', stderr: '' };
      return { ok: false, stdout: '', stderr: `unscripted: ${line}` };
    };
    const res = await checkoutPr({
      cwd: '/w', dir: join(dir, 'pr'), pr: PR, refPrefix: REF_PREFIX, exec,
      sleep: async (ms) => { waits.push(ms); },
    });
    expect(waits).toEqual([3_000]);
    expect(headReads).toBe(2);
    expect(res.checkedOut).toBe(true);
    expect(res.head).toBe('newsha');
    expect(res.problems).toEqual([]);
    expect(JSON.parse(readFileSync(res.metaPath, 'utf8'))).toMatchObject({ headRefOid: 'newsha', headVerified: true, checkedOut: true });
  });

  it('gives up after one re-fetch when refs/pull/N/head still disagrees with headRefOid', async () => {
    const waits: number[] = [];
    const { exec, calls } = scripted([
      ['git config', ORIGIN_IS_PR],
      ['gh pr view', { ok: true, stdout: JSON.stringify({ number: 7, headRefOid: 'newsha' }) }],
      ['gh pr diff', { ok: true, stdout: 'DIFF' }],
      ['git fetch', { ok: true }],
      [`git rev-parse --verify ${REF_PREFIX}/head^{commit}`, { ok: true, stdout: 'oldsha\n' }],
      ['git update-ref -d', { ok: true }],
    ]);
    const res = await checkoutPr({
      cwd: '/w', dir: join(dir, 'pr'), pr: PR, refPrefix: REF_PREFIX, exec,
      sleep: async (ms) => { waits.push(ms); },
    });
    expect(waits).toEqual([3_000]);
    expect(calls.filter((c) => c.startsWith('git fetch'))).toHaveLength(2);
    expect(res.checkedOut).toBe(false);
    expect(res.head).toBe('');
    expect(res.problems.join('\n')).toContain("not the PR's head");
  });

  it('names an Enterprise repo with its host, merges metadata, and falls back to the local baseRefName', async () => {
    const { exec, calls } = scripted([
      ['git config', { ok: true, stdout: 'remote.ghe.url git@ghe.example.com:o/r.git' }],
      ['gh pr view', { ok: true, stdout: JSON.stringify({ title: 'Fix it', baseRefName: 'develop', number: 3 }) }],
      ['gh pr diff', { ok: false, stderr: 'warning\nHTTP 502: bad gateway' }],
      [`git fetch --no-tags --quiet --no-write-fetch-head ghe +refs/heads/develop:${REF_PREFIX}/base`, { ok: false, stderr: 'fatal: offline' }],
      ['git fetch', { ok: true }],
      [`git rev-parse --verify ${REF_PREFIX}/head^{commit}`, { ok: true, stdout: 'abc123\n' }],
      ['git -c core.symlinks=false read-tree abc123', { ok: true }],
      ['git -c core.symlinks=false checkout-index', { ok: true }],
      ['git rev-parse --verify ghe/develop^{commit}', { ok: true, stdout: 'd1\n' }],
      ['git merge-base ghe/develop abc123', { ok: true, stdout: 'base1\n' }],
      ['git diff --no-color --no-ext-diff base1 abc123', { ok: true, stdout: 'DIFF' }],
      ['git update-ref -d', { ok: true }],
    ]);
    const res = await checkoutPr({ cwd: '/w', dir: join(dir, 'pr'), pr: GHE, baseBranch: 'main', refPrefix: REF_PREFIX, exec });
    expect(calls).toContain(`git fetch --no-tags --quiet --no-write-fetch-head ghe +refs/pull/3/head:${REF_PREFIX}/head`);
    expect(calls).toContain(`git update-ref -d ${REF_PREFIX}/head`);
    expect(calls).toContain(`git update-ref -d ${REF_PREFIX}/base`);
    expect(calls.find((c) => c.startsWith('gh pr view'))).toContain('--repo ghe.example.com/o/r');
    expect(calls.find((c) => c.startsWith('gh pr diff'))).toContain('--repo ghe.example.com/o/r');
    expect(res.problems).toEqual([
      'gh pr diff failed — HTTP 502: bad gateway',
      'the diff is against the local ghe/develop, which may be behind the PR\'s base',
    ]);
    expect(readFileSync(res.diffPath, 'utf8')).toBe('DIFF');
    // gh named no head, so nothing from GitHub confirms the fetched one.
    expect(JSON.parse(readFileSync(res.metaPath, 'utf8'))).toMatchObject({
      title: 'Fix it', baseRefName: 'develop', headRefOid: 'abc123', headVerified: false, diffBase: 'local ghe/develop (may be stale)', checkedOut: true,
    });
  });

  it('reports a failed gh pr view and keeps what it knows', async () => {
    const { exec } = scripted([
      ['git config', ORIGIN_IS_PR],
      ['gh pr view', { ok: false, stderr: 'GraphQL: Could not resolve to a PullRequest' }],
      ['gh pr diff', { ok: true, stdout: 'GH DIFF' }],
      ['git fetch', { ok: false, stderr: 'fatal: could not read from remote' }],
      ['git update-ref -d', { ok: true }],
    ]);
    const res = await checkoutPr({ cwd: '/w', dir: join(dir, 'pr'), pr: { ...PR, number: 9 }, refPrefix: REF_PREFIX, exec });
    expect(res.problems).toEqual([
      'gh pr view failed — GraphQL: Could not resolve to a PullRequest',
      'git fetch origin pull/9/head failed — fatal: could not read from remote',
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
    // `origin` is a local path, so `upstream` is the remote that names o/r, mapped onto it here.
    git(work, 'config', `url.${origin}.insteadOf`, 'https://github.com/o/r.git');
    git(work, 'remote', 'add', 'upstream', 'https://github.com/o/r.git');
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
    // User's own FETCH_HEAD must never be overwritten.
    const fetchHeadPath = join(work, '.git', 'FETCH_HEAD');
    writeFileSync(fetchHeadPath, `${baseSha}\t\tbranch 'main' of origin\n`);

    const res = await checkoutPr({ cwd: work, dir, copyTo: artifacts, pr: PR, baseBranch: 'main', refPrefix: REF_PREFIX, exec: withGh(prHead), sleep: NO_SLEEP });
    expect(res.problems).toEqual([]);
    expect(res.checkedOut).toBe(true);
    expect(res.tree).toBe(join(dir, 'tree'));
    expect(readFileSync(join(res.tree, 'a.txt'), 'utf8')).toBe('one\ntwo from the PR\n');
    expect(readFileSync(join(res.tree, 'seeded.env'), 'utf8')).toBe('from the PR\n');
    // The task: same branch, same commit, same files, index, FETCH_HEAD and refs untouched.
    expect(git(work, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('cez/task');
    expect(git(work, 'rev-parse', 'HEAD')).toBe(own);
    expect(readFileSync(join(work, 'a.txt'), 'utf8')).toBe('one\n');
    expect(readFileSync(join(work, 'b.txt'), 'utf8')).toBe('uncommitted\n');
    expect(readFileSync(join(work, 'seeded.env'), 'utf8')).toBe('SECRET=local\n');
    expect(readFileSync(fetchHeadPath, 'utf8')).toBe(`${baseSha}\t\tbranch 'main' of origin\n`);
    expect(git(work, 'for-each-ref', 'refs/cezar/pr-checkouts/')).toBe('');
    expect(git(work, 'status', '--porcelain', '--untracked-files=no')).toBe('M b.txt');
    expect(JSON.parse(readFileSync(res.metaPath, 'utf8'))).toMatchObject({ headRefOid: prHead, headVerified: true, diffBase: 'github', checkedOut: true });
    // The user's copies sit in the artifacts; the agents read the ones beside the tree.
    expect(readFileSync(join(artifacts, 'pr-7.diff'), 'utf8')).toBe('diff from gh\n');
    expect(res.diffPath).toBe(join(dir, 'pr-7.diff'));
  });

  it('writes the diff and metadata read-only, beside the tree and in the artifacts, and a re-run replaces them', async () => {
    const first = await checkoutPr({ cwd: work, dir, copyTo: artifacts, pr: PR, baseBranch: 'main', refPrefix: REF_PREFIX, exec: withGh(prSha), sleep: NO_SLEEP });
    for (const file of [first.diffPath, first.metaPath, join(artifacts, 'pr-7.diff'), join(artifacts, 'pr-7.json')]) {
      expect(statSync(file).mode & 0o222).toBe(0);
    }
    const newer = pushPr({ 'a.txt': 'one\nnewer\n' });
    const again = await checkoutPr({ cwd: work, dir, copyTo: artifacts, pr: PR, baseBranch: 'main', refPrefix: REF_PREFIX, exec: withGh(newer), sleep: NO_SLEEP });
    expect(again.problems).toEqual([]);
    expect(JSON.parse(readFileSync(join(artifacts, 'pr-7.json'), 'utf8'))).toMatchObject({ headRefOid: newer });
  });

  // GIT_ATTR_SOURCE needs git 2.42; older git exports as before.
  const gitMinor = (() => { const m = /(\d+)\.(\d+)/.exec(execFileSync('git', ['--version'], { encoding: 'utf8' })); return m ? Number(m[1]) * 100 + Number(m[2]) : 0; })();
  it.skipIf(gitMinor < 242)("never runs a filter driver the PR's .gitattributes names", async () => {
    const marker = join(root, 'filter-ran');
    git(work, 'config', 'filter.evil.smudge', `sh -c 'touch ${marker}; cat'`);
    git(work, 'config', 'filter.evil.clean', 'cat');
    const head = pushPr({ '.gitattributes': '* filter=evil\n', 'a.txt': 'one\nfiltered?\n' });
    rmSync(marker, { force: true });
    const res = await checkoutPr({ cwd: work, dir, pr: PR, baseBranch: 'main', refPrefix: REF_PREFIX, exec: withGh(head), sleep: NO_SLEEP });
    expect(res.checkedOut).toBe(true);
    expect(readFileSync(join(res.tree, 'a.txt'), 'utf8')).toBe('one\nfiltered?\n');
    expect(existsSync(marker)).toBe(false);
  });

  it('re-exports a newer head after a push to the PR, leaving nothing of the old one', async () => {
    await checkoutPr({ cwd: work, dir, pr: PR, baseBranch: 'main', refPrefix: REF_PREFIX, exec: withGh(prSha), sleep: NO_SLEEP });
    writeFileSync(join(dir, 'tree', 'stale.txt'), 'left over\n');
    const newer = pushPr({ 'a.txt': 'one\nthree, after review\n' });
    const res = await checkoutPr({ cwd: work, dir, pr: PR, baseBranch: 'main', refPrefix: REF_PREFIX, exec: withGh(newer), sleep: NO_SLEEP });
    expect(res.checkedOut).toBe(true);
    expect(res.head).toBe(newer);
    expect(readFileSync(join(res.tree, 'a.txt'), 'utf8')).toBe('one\nthree, after review\n');
    expect(existsSync(join(res.tree, 'stale.txt'))).toBe(false);
  });

  it("fetches from the remote that is the PR's repository, never another remote's pull ref", async () => {
    // `other` has a refs/pull/7/head too — of a different repository. It must not be used.
    const other = join(root, 'other.git');
    git(root, 'init', '-q', '--bare', '-b', 'main', other);
    git(work, 'push', '-q', other, `${baseSha}:refs/pull/7/head`);
    git(work, 'remote', 'set-url', 'origin', other);
    const res = await checkoutPr({ cwd: work, dir, pr: PR, baseBranch: 'main', refPrefix: REF_PREFIX, exec: withGh(prSha), sleep: NO_SLEEP });
    expect(res.head).toBe(prSha);
    expect(res.checkedOut).toBe(true);
  });

  it("refuses a fetched head that is not the PR's head", async () => {
    const res = await checkoutPr({ cwd: work, dir, pr: PR, baseBranch: 'main', refPrefix: REF_PREFIX, exec: withGh(baseSha), sleep: NO_SLEEP });
    expect(res.checkedOut).toBe(false);
    expect(res.head).toBe('');
    expect(res.problems.join('\n')).toContain("not the PR's head");
    expect(existsSync(join(dir, 'tree'))).toBe(false);
    expect(git(work, 'for-each-ref', 'refs/cezar/pr-checkouts/')).toBe('');
  });

  it('exports nothing when the PR ref cannot be fetched', async () => {
    const res = await checkoutPr({ cwd: work, dir, pr: { ...PR, number: 8 }, baseBranch: 'main', refPrefix: REF_PREFIX, exec: withGh(), sleep: NO_SLEEP });
    expect(res.checkedOut).toBe(false);
    expect(res.problems.join('\n')).toContain('git fetch upstream pull/8/head failed');
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
    const res = await checkoutPr({ cwd: work, dir, pr: PR, baseBranch: 'main', refPrefix: REF_PREFIX, exec: withGh(head), sleep: NO_SLEEP });
    expect(lstatSync(join(res.tree, 'link')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(res.tree, 'link'), 'utf8')).toBe('/etc/passwd');
  });

  it("without gh diffs against the PR's base fetched fresh, not a stale local one, without touching FETCH_HEAD", async () => {
    // origin/main moved on and the PR forked from there; the local main is still behind.
    git(work, 'checkout', '-q', '--detach', baseSha);
    writeFileSync(join(work, 'upstream.txt'), 'landed upstream\n');
    git(work, 'add', '-A'); git(work, ...GIT_ID, 'commit', '-q', '-m', 'upstream');
    git(work, 'push', '-q', 'origin', 'HEAD:main');
    const head = pushPr({ 'a.txt': 'one\nthe PR on a fresh base\n' }, git(work, 'rev-parse', 'HEAD'));
    expect(git(work, 'rev-parse', 'main')).toBe(baseSha);
    const fetchHeadPath = join(work, '.git', 'FETCH_HEAD');
    writeFileSync(fetchHeadPath, `${baseSha}\t\tbranch 'main' of origin\n`);
    const res = await checkoutPr({ cwd: work, dir, pr: PR, baseBranch: 'main', refPrefix: REF_PREFIX, exec: withGh(), sleep: NO_SLEEP });
    expect(res.head).toBe(head);
    const diff = readFileSync(res.diffPath, 'utf8');
    expect(diff).toContain('+the PR on a fresh base');
    expect(diff).not.toContain('upstream.txt');
    expect(readFileSync(fetchHeadPath, 'utf8')).toBe(`${baseSha}\t\tbranch 'main' of origin\n`);
    expect(git(work, 'for-each-ref', 'refs/cezar/pr-checkouts/')).toBe('');
    expect(JSON.parse(readFileSync(res.metaPath, 'utf8'))).toMatchObject({ headVerified: false, diffBase: "main (the task's base: GitHub did not name the PR's) fetched from upstream" });
    expect(res.problems).toEqual([
      'gh pr view failed — gh: offline',
      'gh pr diff failed — gh: offline',
      "the diff is against the task's base main, which may not be the PR's base",
    ]);
  });

  it('says so when it can only diff against a local base', async () => {
    git(work, 'branch', '-q', 'trunk', baseSha);
    const res = await checkoutPr({ cwd: work, dir, pr: PR, baseBranch: 'trunk', refPrefix: REF_PREFIX, exec: withGh(), sleep: NO_SLEEP });
    expect(readFileSync(res.diffPath, 'utf8')).toContain('+two from the PR');
    expect(res.problems).toContain('the diff is against the local trunk, which may be behind the PR\'s base');
    expect(JSON.parse(readFileSync(res.metaPath, 'utf8'))).toMatchObject({ diffBase: "local trunk (the task's base: GitHub did not name the PR's) (may be stale)" });
  });
});
