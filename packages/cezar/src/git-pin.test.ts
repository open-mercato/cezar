import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pinnedGitEnv, pinWorktreeGitDir, resolveTrustedGitDir, verifyWorktreeGitPointer } from './git-pin.ts';
import { worktreeChangedFiles, worktreeShortstat } from './git-worktree.ts';

const GIT_ID = ['-c', 'user.email=t@t', '-c', 'user.name=t'];

// a sandboxed model can rewrite a linked worktree's `.git` pointer; host-side git
// then loads a config it controls, and core.fsmonitor runs a program outside the sandbox.
describe.skipIf(process.platform === 'win32')('harness worktree git pinning', () => {
  let root: string;
  let repo: string;
  let wt: string;
  let marker: string;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', [...GIT_ID, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  /** Repoint the worktree at a repository whose config runs `marker`-touching fsmonitor. */
  const tamper = () => {
    const attacker = join(root, 'attacker');
    git(root, 'init', '-q', attacker);
    const hook = join(root, 'hook.sh');
    writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`);
    chmodSync(hook, 0o755);
    git(attacker, 'config', 'core.fsmonitor', hook);
    writeFileSync(join(wt, '.git'), `gitdir: ${join(attacker, '.git')}\n`);
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'cez-git-pin-')));
    repo = join(root, 'repo');
    wt = join(root, 'wt');
    marker = join(root, 'pwned');
    git(root, 'init', '-q', '-b', 'main', repo);
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'worktree', 'add', '-q', '-b', 'task', wt);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves the real gitdir from the main repository, whatever the pointer says', () => {
    const trusted = resolveTrustedGitDir(repo, wt);
    expect(trusted && realpathSync(trusted)).toBe(realpathSync(join(repo, '.git', 'worktrees', 'wt')));
    tamper();
    expect(resolveTrustedGitDir(repo, wt)).toBe(trusted);
  });

  it('runs no repository config the pointer names once the worktree is pinned', async () => {
    const trusted = resolveTrustedGitDir(repo, wt)!;
    tamper();
    // The exploit is real: unpinned git loads the attacker's config.
    try { git(wt, 'status', '--porcelain'); } catch { /* the hook's exit status is irrelevant */ }
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    pinWorktreeGitDir(wt, trusted);
    expect(pinnedGitEnv(wt)).toMatchObject({ GIT_DIR: trusted });
    writeFileSync(join(wt, 'b.txt'), 'two\n');
    expect(await worktreeChangedFiles(wt, 'main')).toContain('b.txt');
    execFileSync('git', ['status', '--porcelain'], { cwd: wt, env: { ...process.env, ...pinnedGitEnv(wt) } });
    expect(existsSync(marker)).toBe(false);
  });

  // a relative core.hooksPath (husky's `.husky/_`) resolves inside the model-writable
  // worktree, so a planted hook ran on cezar's own index writes, unsandboxed, with its environment.
  it('runs no hook a model planted in the worktree on pinned index writes', async () => {
    git(repo, 'config', 'core.hooksPath', '.husky/_');
    const hooks = join(wt, '.husky', '_');
    mkdirSync(hooks, { recursive: true });
    for (const hook of ['post-index-change', 'pre-commit']) {
      writeFileSync(join(hooks, hook), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
      chmodSync(join(hooks, hook), 0o755);
    }
    writeFileSync(join(wt, 'b.txt'), 'two\n');
    pinWorktreeGitDir(wt, resolveTrustedGitDir(repo, wt)!);

    expect(await worktreeShortstat(wt, 'main')).not.toBeNull();
    expect(await worktreeChangedFiles(wt, 'main')).toContain('b.txt');
    expect(existsSync(marker)).toBe(false);
  });

  // the restore must never write through a symlink at the path.
  it('restores a pointer replaced by a symlink without writing through it', () => {
    const trusted = resolveTrustedGitDir(repo, wt)!;
    const hostFile = join(root, 'host-file');
    writeFileSync(hostFile, 'host content\n');
    rmSync(join(wt, '.git'));
    symlinkSync(hostFile, join(wt, '.git'));

    expect(verifyWorktreeGitPointer(wt, trusted)).toMatchObject({ ok: false });
    expect(readFileSync(hostFile, 'utf8')).toBe('host content\n');
    expect(lstatSync(join(wt, '.git')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(wt, '.git'), 'utf8').trim()).toBe(`gitdir: ${trusted}`);
  });

  it('restores a rewritten pointer and reports it', () => {
    const trusted = resolveTrustedGitDir(repo, wt)!;
    expect(verifyWorktreeGitPointer(wt, trusted)).toEqual({ ok: true });
    tamper();
    expect(verifyWorktreeGitPointer(wt, trusted)).toMatchObject({ ok: false, error: expect.stringContaining('rewritten') });
    expect(readFileSync(join(wt, '.git'), 'utf8').trim()).toBe(`gitdir: ${trusted}`);
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('task');
  });
});
