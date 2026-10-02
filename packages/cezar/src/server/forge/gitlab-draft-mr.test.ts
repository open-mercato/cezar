import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Real `git` (autosave, remote check, push to a local bare repo), mocked `glab`: every
// `execFile('glab', …)` goes to this mock, everything else runs for real. No network.
const glabMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const realExecFile = actual.execFile as unknown as (...args: unknown[]) => unknown;
  const execFile = (...args: unknown[]) => (args[0] === 'glab' ? glabMock(...args) : realExecFile(...args));
  return { ...actual, execFile };
});

import type { RunRecord } from '../../runs/store.ts';
import { createGitlabDriver } from './gitlab.ts';
import { parseRemote, type ParsedRemote } from './index.ts';

type Callback = (err: unknown, stdout?: string, stderr?: string) => void;

/** Answer the next `glab` call with (err, stdout, stderr), the way `execFile` calls back. */
const glabReply = (err: unknown, stdout = '', stderr = '') =>
  glabMock.mockImplementation((...args: unknown[]) => (args[args.length - 1] as Callback)(err, stdout, stderr));

const glabFails = (stderr: string) => glabReply(Object.assign(new Error('Command failed: glab mr create'), { code: 1 }), '', stderr);

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

const remoteOf = (url: string): ParsedRemote => {
  const p = parseRemote(url);
  if (!p) throw new Error('fixture remote must parse');
  return p;
};

let rootSeq = 0;
/** A fresh driver root per case, so the module-level project-identity cache never leaks. */
const freshRoot = () => `/repo/gitlab-draft-mr-${++rootSeq}`;

/**
 * GitLab's `createPR` (spec 2026-08-10-forge-provider-adapters, Step 4.1) mirrors GitHub's
 * `createDraftPr` (see draft-pr-autosave.test.ts): the same final autosave, conflicted-worktree
 * refusal, push and base-branch rule, then `glab mr create --draft`.
 */
describe('GitLab driver — createPR (draft merge request)', () => {
  let repo: string;
  let bare: string;
  let warn: ReturnType<typeof vi.spyOn>;

  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

  const input = (extra: Partial<RunRecord> = {}) => ({
    repoRoot: repo,
    handoffText: '## Goal\n\nship it\n',
    run: { worktreePath: repo, branch: 'cez/abc123', task: 'do the thing', title: 'Ship it', ...extra } as RunRecord,
  });

  const glabArgs = (): string[] => {
    expect(glabMock).toHaveBeenCalledTimes(1);
    return glabMock.mock.calls[0]?.[1] as string[];
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'cez-draft-mr-'));
    bare = mkdtempSync(join(tmpdir(), 'cez-draft-mr-remote-'));
    execFileSync('git', ['init', '--bare', '-q', bare]);
    git(['init', '-q', '-b', 'main']);
    writeFileSync(join(repo, 'a.txt'), 'base\n');
    git(['add', '-A']);
    git([...GIT_ID, 'commit', '-q', '-m', 'base']);
    git(['checkout', '-q', '-b', 'cez/abc123']);
    git(['remote', 'add', 'origin', bare]);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    glabMock.mockReset();
    vi.stubEnv('CEZ_DRY_RUN', '');
  });

  afterEach(() => {
    warn.mockRestore();
    vi.unstubAllEnvs();
    rmSync(repo, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  });

  it('pushes, runs `glab mr create --draft … --yes` in the worktree and returns the MR URL', async () => {
    writeFileSync(join(repo, 'a.txt'), 'finished work\n');
    glabReply(null, '\nCreating draft merge request for cez/abc123 into develop in acme/demo\n\nhttps://gitlab.com/acme/demo/-/merge_requests/42\n');
    const driver = createGitlabDriver(freshRoot(), remoteOf('git@gitlab.com:acme/demo.git'));

    const outcome = await driver.createPR(input({ baseBranch: 'origin/develop' }));

    expect(outcome).toEqual({ ok: true, url: 'https://gitlab.com/acme/demo/-/merge_requests/42', dryRun: false });
    const args = glabArgs();
    expect(args.slice(0, 7)).toEqual([
      'mr', 'create', '--draft', '--source-branch', 'cez/abc123', '--target-branch', 'develop',
    ]);
    expect(args.slice(7, 9)).toEqual(['--title', 'Ship it']);
    expect(args[9]).toBe('--description');
    expect(args[10]).toContain('ship it');
    expect(args[10]).toContain('🤖 made with cezar');
    expect(args[11]).toBe('--yes');
    expect(args).toHaveLength(12);
    const opts = glabMock.mock.calls[0]?.[2] as { cwd: string };
    expect(opts.cwd).toBe(repo);
    // The final autosave landed and the branch reached the remote before glab ran.
    expect(git(['log', '-1', '--format=%s']).trim()).toBe('cezar autosave (pre-PR)');
    const pushed = execFileSync('git', ['rev-parse', 'cez/abc123'], { cwd: bare, encoding: 'utf8' }).trim();
    expect(pushed).toBe(git(['rev-parse', 'HEAD']).trim());
  });

  it('matches the URL against a self-managed instance host (port, subgroups), not gitlab.com', async () => {
    glabReply(
      null,
      'see also https://gitlab.com/other/proj/-/merge_requests/1\n',
      'https://git.example.com:8443/grp/sub/demo/-/merge_requests/9\n',
    );
    const driver = createGitlabDriver(freshRoot(), remoteOf('https://git.example.com:8443/grp/sub/demo.git'));
    expect(await driver.createPR(input())).toEqual({
      ok: true,
      url: 'https://git.example.com:8443/grp/sub/demo/-/merge_requests/9',
      dryRun: false,
    });
  });

  it('lets glab pick the default branch when the base is a raw sha (detached-HEAD fork point)', async () => {
    glabReply(null, 'https://gitlab.com/acme/demo/-/merge_requests/43\n');
    const driver = createGitlabDriver(freshRoot(), remoteOf('git@gitlab.com:acme/demo.git'));
    const outcome = await driver.createPR(input({ baseBranch: 'a1b2c3d4e5f6' }));
    expect(outcome.ok).toBe(true);
    expect(glabArgs()).not.toContain('--target-branch');
  });

  it('names the missing glab CLI', async () => {
    glabReply(Object.assign(new Error('spawn glab ENOENT'), { code: 'ENOENT' }));
    const driver = createGitlabDriver(freshRoot(), remoteOf('git@gitlab.com:acme/demo.git'));
    expect(await driver.createPR(input())).toEqual({
      ok: false,
      error: 'glab not found — install the GitLab CLI and run `glab auth login`, or merge the branch locally',
    });
  });

  it.each([
    'POST https://git.example.com/api/v4/projects/grp%2Fdemo/merge_requests: 401 {message: 401 Unauthorized}',
    'ERROR: 403 Forbidden',
    'You are not logged in to any GitLab hosts',
  ])('turns an auth failure into the host-specific login hint (%s)', async (stderr) => {
    glabFails(stderr);
    const driver = createGitlabDriver(freshRoot(), remoteOf('git@git.example.com:grp/demo.git'));
    expect(await driver.createPR(input())).toEqual({
      ok: false,
      error: 'glab is not authenticated for git.example.com — run `glab auth login --hostname git.example.com`, or merge the branch locally',
    });
  });

  it('reports any other glab failure with the tail of its stderr', async () => {
    glabFails('some noise\nfailed to create merge request: 409 {message: [Another open merge request already exists for this source branch]}\n');
    const driver = createGitlabDriver(freshRoot(), remoteOf('git@gitlab.com:acme/demo.git'));
    const outcome = await driver.createPR(input());
    expect(outcome).toEqual({
      ok: false,
      error:
        'glab mr create failed — some noise | failed to create merge request: 409 {message: [Another open merge request already exists for this source branch]}',
    });
  });

  it("reports glab 1.118's boxed failure as one readable line (live: MR already exists)", async () => {
    // Captured live from `glab mr create` on a branch that already had an open MR (gitlab.com, glab 1.118).
    glabFails(
      '\nCreating draft merge request for cez/abc123 into main in acme/demo\n\n' +
        'Failed to create merge request. Created recovery file: /home/u/.config/glab-cli/recover/acme/demo/mr.json\n' +
        "Run the command again with the '--recover' option to retry.\n" +
        '          \n   ERROR  \n          \n' +
        '  Post https://gitlab.com/api/v4/projects/acme%2Fdemo/merge_requests: 409 {message: [Another \n' +
        '  open merge request already exists for this source branch: !2]}.                    \n\n',
    );
    const driver = createGitlabDriver(freshRoot(), remoteOf('git@gitlab.com:acme/demo.git'));
    expect(await driver.createPR(input())).toEqual({
      ok: false,
      error:
        'glab mr create failed — Post https://gitlab.com/api/v4/projects/acme%2Fdemo/merge_requests: 409 {message: [Another open merge request already exists for this source branch: !2]}.',
    });
  });

  it('refuses success when glab printed no merge request URL', async () => {
    glabReply(null, 'Creating merge request…\n', 'https://gitlab.com/acme/demo/-/issues/5\n');
    const driver = createGitlabDriver(freshRoot(), remoteOf('git@gitlab.com:acme/demo.git'));
    expect(await driver.createPR(input())).toEqual({
      ok: false,
      error: 'glab mr create finished but printed no merge request URL — check the GitLab project',
    });
  });

  it('stops at a failed push and never runs glab', async () => {
    git(['remote', 'set-url', 'origin', join(bare, 'does-not-exist')]);
    const driver = createGitlabDriver(freshRoot(), remoteOf('git@gitlab.com:acme/demo.git'));
    const outcome = await driver.createPR(input());
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toMatch(/^git push failed — /);
    expect(glabMock).not.toHaveBeenCalled();
  });

  it('refuses to publish a worktree holding conflict markers', async () => {
    writeFileSync(join(repo, 'a.txt'), ['<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> other', ''].join('\n'));
    const driver = createGitlabDriver(freshRoot(), remoteOf('git@gitlab.com:acme/demo.git'));
    expect(await driver.createPR(input())).toEqual({
      ok: false,
      error: 'worktree has unresolved merge conflicts — resolve them, then publish again',
    });
    expect(glabMock).not.toHaveBeenCalled();
  });

  it('fakes an MR URL on the instance under CEZ_DRY_RUN=1, after the autosave, without push or glab', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    writeFileSync(join(repo, 'a.txt'), 'finished work\n');
    const driver = createGitlabDriver(freshRoot(), remoteOf('https://git.example.com/grp/sub/demo.git'));
    expect(await driver.createPR(input())).toEqual({
      ok: true,
      url: 'https://git.example.com/grp/sub/demo/-/merge_requests/777',
      dryRun: true,
    });
    expect(git(['log', '-1', '--format=%s']).trim()).toBe('cezar autosave (pre-PR)');
    expect(glabMock).not.toHaveBeenCalled();
    const heads = execFileSync('git', ['for-each-ref', 'refs/heads'], { cwd: bare, encoding: 'utf8' });
    expect(heads.trim()).toBe('');
  });
});
