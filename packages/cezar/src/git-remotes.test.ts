import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setForkParentLookup, splitRemoteRef } from './git-remotes.ts';
import { chooseForkBase, pushBranch, syncWithBase, taskRemotes, worktreeShortstat } from './git-worktree.ts';
import { prRepoArgs } from './server/forge/github.ts';

/**
 * Fork layouts: the PR-target ("base") remote is not always `origin`. Real git
 * throughout — a canonical repo, a fork cloned from it that has fallen behind,
 * and a working clone wired to both in either layout.
 */

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const roots: string[] = [];

const PARENTS: Record<string, string> = { 'marta/shop': 'acme/shop' };

beforeEach(() => setForkParentLookup(async (r) => PARENTS[`${r.owner}/${r.repo}`] ?? null));

afterEach(() => {
  setForkParentLookup(null);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

const git = async (cwd: string, ...args: string[]) => (await run('git', args, { cwd })).stdout.trim();

async function commit(repo: string, content: string, message: string): Promise<void> {
  writeFileSync(join(repo, 'a.txt'), content);
  await run('git', ['add', '-A'], { cwd: repo });
  await run('git', [...GIT_ID, 'commit', '-q', '-m', message], { cwd: repo });
}

const CANONICAL_URL = 'https://github.com/acme/shop.git';
const FORK_URL = 'https://github.com/marta/shop.git';

/**
 * `canonical` (the repo PRs go to) moves on after `fork` was cloned from it, so the fork's
 * `main` is stale. `work` has both as GitHub-style remotes (`insteadOf` maps them to the local
 * repos) and GitHub — the stubbed lookup — reports the fork's parent as the canonical repo.
 */
async function forkFixture(layout: 'origin-is-fork' | 'origin-is-canonical') {
  const canonical = tempDir('cez-canonical-');
  await run('git', ['init', '-q', '-b', 'main'], { cwd: canonical });
  await commit(canonical, '1\n', 'c1');
  const fork = tempDir('cez-fork-');
  await run('git', ['clone', '-q', '--bare', canonical, fork], { cwd: tmpdir() });
  await commit(canonical, '2\n', 'c2 — only upstream has this');
  const canonicalTip = await git(canonical, 'rev-parse', 'HEAD');

  const work = tempDir('cez-forkwork-');
  const [originUrl, otherName, otherUrl] =
    layout === 'origin-is-fork' ? [FORK_URL, 'upstream', CANONICAL_URL] : [CANONICAL_URL, 'fork', FORK_URL];
  await git(work, 'init', '-q', '-b', 'main');
  await git(work, 'config', 'gc.auto', '0');
  await git(work, 'config', `url.${canonical}.insteadOf`, CANONICAL_URL);
  await git(work, 'config', `url.${fork}.insteadOf`, FORK_URL);
  await git(work, 'remote', 'add', 'origin', originUrl);
  await git(work, 'remote', 'add', otherName, otherUrl);
  await git(work, 'fetch', '-q', 'origin');
  await git(work, 'checkout', '-q', '-b', 'main', 'origin/main');
  await git(work, 'remote', 'set-head', 'origin', 'main');
  return { canonical, fork, work, canonicalTip };
}

describe('splitRemoteRef', () => {
  const names = ['origin', 'upstream', 'my/fork'];
  it.each([
    ['upstream/main', { remote: 'upstream', branch: 'main' }],
    ['origin/feat/x', { remote: 'origin', branch: 'feat/x' }],
    ['my/fork/main', { remote: 'my/fork', branch: 'main' }],
    ['feat/x', { remote: null, branch: 'feat/x' }],
    ['main', { remote: null, branch: 'main' }],
    ['origin/', { remote: null, branch: 'origin/' }],
  ])('%s', (ref, expected) => {
    expect(splitRemoteRef(ref, names)).toEqual(expected);
  });
});

describe('taskRemotes (real git)', () => {
  it('origin = fork, upstream = canonical: fork from upstream, push to origin', async () => {
    const { work } = await forkFixture('origin-is-fork');
    expect(await taskRemotes(work)).toMatchObject({ base: 'upstream', push: 'origin' });
  });

  it('origin = canonical, fork = yours: base and push are both origin', async () => {
    const { work } = await forkFixture('origin-is-canonical');
    expect(await taskRemotes(work)).toMatchObject({ base: 'origin', push: 'origin' });
  });

  it('honours `gh repo set-default` (remote.<name>.gh-resolved = base) over the name order', async () => {
    const { work } = await forkFixture('origin-is-fork');
    await git(work, 'config', 'remote.origin.gh-resolved', 'base');
    expect((await taskRemotes(work)).base).toBe('origin');
  });

  it('honours remote.pushDefault for the push remote', async () => {
    const { work } = await forkFixture('origin-is-canonical');
    await git(work, 'config', 'remote.pushDefault', 'fork');
    expect(await taskRemotes(work)).toMatchObject({ base: 'origin', push: 'fork' });
  });

  it('a lone remote with an unconventional name is both; no remote is null', async () => {
    const solo = tempDir('cez-solo-');
    await run('git', ['init', '-q', '-b', 'main'], { cwd: solo });
    expect(await taskRemotes(solo)).toEqual({ base: null, push: null, names: [] });
    await git(solo, 'remote', 'add', 'gitlab', CANONICAL_URL);
    expect(await taskRemotes(solo)).toMatchObject({ base: 'gitlab', push: 'gitlab' });
  });

  it('downstream fork: an `upstream` that is NOT origin\'s GitHub parent leaves origin as the base', async () => {
    // A company's own copy of an OSS project: PRs go to origin, `upstream` is only synced from.
    const repo = tempDir('cez-downstream-');
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    await git(repo, 'remote', 'add', 'origin', 'git@github.com:company/shop.git');
    await git(repo, 'remote', 'add', 'upstream', 'https://github.com/oss/shop.git');
    expect(await taskRemotes(repo)).toMatchObject({ base: 'origin', push: 'origin' });
  });

  it('an unanswered lookup (no gh, offline) keeps origin — never worse than before', async () => {
    setForkParentLookup(async () => null);
    const { work } = await forkFixture('origin-is-fork');
    expect((await taskRemotes(work)).base).toBe('origin');
  });

  it('skips the GitHub lookup entirely under CEZ_DRY_RUN=1', async () => {
    const { work } = await forkFixture('origin-is-fork');
    let asked = false;
    setForkParentLookup(async () => ((asked = true), 'acme/shop'));
    const prev = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    try {
      expect((await taskRemotes(work)).base).toBe('origin');
    } finally {
      if (prev === undefined) delete process.env.CEZ_DRY_RUN;
      else process.env.CEZ_DRY_RUN = prev;
    }
    expect(asked).toBe(false);
  });

  it('never asks GitHub about a non-GitHub origin', async () => {
    const repo = tempDir('cez-gitlab-');
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    await git(repo, 'remote', 'add', 'origin', 'git@gitlab.com:marta/shop.git');
    await git(repo, 'remote', 'add', 'upstream', 'https://gitlab.com/acme/shop.git');
    let asked = false;
    setForkParentLookup(async () => ((asked = true), 'acme/shop'));
    expect((await taskRemotes(repo)).base).toBe('origin');
    expect(asked).toBe(false);
  });

  it('ignores option-like remote names (#431 dash-guard)', async () => {
    const repo = tempDir('cez-dashremote-');
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    await git(repo, 'config', 'remote.--upload-pack=evil.url', CANONICAL_URL);
    await git(repo, 'remote', 'add', 'origin', FORK_URL);
    expect(await taskRemotes(repo)).toEqual({ base: 'origin', push: 'origin', names: ['origin'] });
  });
});

describe('a new task on a fork clone starts from the PR target, not the stale fork', () => {
  it('origin = fork: forks from the freshly fetched upstream/main', async () => {
    const { work, canonicalTip } = await forkFixture('origin-is-fork');
    // Local main == origin/main == the stale fork; only upstream has c2.
    const base = await chooseForkBase(work, 'main', undefined, () => undefined);
    expect(base).toBe('upstream/main');
    expect(await git(work, 'rev-parse', base)).toBe(canonicalTip);
  });

  it('origin = fork with a configured base: still upstream', async () => {
    const { work, canonicalTip } = await forkFixture('origin-is-fork');
    const base = await chooseForkBase(work, 'some-feature', 'main', () => undefined);
    expect(base).toBe('upstream/main');
    expect(await git(work, 'rev-parse', base)).toBe(canonicalTip);
  });

  it('origin = canonical (fork as a side remote): forks from origin/main as before', async () => {
    const { work, canonical, canonicalTip } = await forkFixture('origin-is-canonical');
    await commit(canonical, '3\n', 'c3 — after the clone');
    const freshTip = await git(canonical, 'rev-parse', 'HEAD');
    expect(freshTip).not.toBe(canonicalTip);
    const base = await chooseForkBase(work, 'main', undefined, () => undefined);
    expect(base).toBe('origin/main');
    expect(await git(work, 'rev-parse', base)).toBe(freshTip);
  });

  it('diffs measure against upstream, so the fork lag never counts as task work', async () => {
    const { work } = await forkFixture('origin-is-fork');
    const base = await chooseForkBase(work, 'main', undefined, () => undefined);
    await git(work, 'checkout', '-q', '-b', 'cez/t', base);
    writeFileSync(join(work, 'mine.txt'), 'x\n');
    // Recorded as `main` (a name) the read-time rule must still pick upstream/main.
    expect(await worktreeShortstat(work, 'main', { taskBranch: 'cez/t' })).toEqual({ adds: 1, dels: 0, files: 1 });
  });

  it('git.sync-base merges the latest upstream, even for a base recorded as upstream/main', async () => {
    const { work, canonical } = await forkFixture('origin-is-fork');
    const base = await chooseForkBase(work, 'main', undefined, () => undefined);
    await git(work, 'checkout', '-q', '-b', 'cez/t', base);
    await commit(canonical, '2\nmore\n', 'c3 — upstream moved again');
    const tip = await git(canonical, 'rev-parse', 'HEAD');
    expect(await syncWithBase(work, base)).toEqual({ result: 'done' });
    expect(await git(work, 'rev-parse', 'HEAD')).toBe(tip);
  });

  it('git.push sends the task branch to the push remote (the fork)', async () => {
    const { work, fork, canonical } = await forkFixture('origin-is-fork');
    await git(work, 'checkout', '-q', '-b', 'cez/t');
    expect(await pushBranch(work, 'cez/t')).toEqual({ ok: true });
    expect(await git(fork, 'branch', '--list', 'cez/t')).toContain('cez/t');
    expect(await git(canonical, 'branch', '--list', 'cez/t')).toBe('');
  });
});

describe('prRepoArgs (gh pr create target)', () => {
  async function withUrls(urls: Record<string, string>): Promise<string> {
    const repo = tempDir('cez-prargs-');
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    for (const [name, url] of Object.entries(urls)) await git(repo, 'remote', 'add', name, url);
    return repo;
  }

  it('opens the PR on the base repo with an owner-qualified head from the fork', async () => {
    const repo = await withUrls({
      origin: 'git@github.com:marta/cezar.git',
      upstream: 'https://github.com/open-mercato/cezar.git',
    });
    expect(await prRepoArgs(repo, 'upstream', 'origin', 'cez/ab12cd34')).toEqual([
      '--repo',
      'github.com/open-mercato/cezar',
      '--head',
      'marta:cez/ab12cd34',
    ]);
  });

  it('a same-repo push keeps a plain head but still pins --repo', async () => {
    const repo = await withUrls({ origin: 'git@github.com:open-mercato/cezar.git' });
    expect(await prRepoArgs(repo, 'origin', 'origin', 'cez/x')).toEqual([
      '--repo',
      'github.com/open-mercato/cezar',
      '--head',
      'cez/x',
    ]);
  });

  it('an unparseable base remote falls back to gh\'s own resolution', async () => {
    const repo = await withUrls({ origin: '/some/local/path' });
    expect(await prRepoArgs(repo, 'origin', 'origin', 'cez/x')).toEqual(['--head', 'cez/x']);
  });
});
