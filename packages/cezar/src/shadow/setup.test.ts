import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shadowDir, shadowPaths } from './ledger.ts';
import {
  SHADOW_CHECK_WRAPPER,
  ShadowSetupError,
  findExecutable,
  prepareShadowRun,
  shimInvocation,
  withEnvOverrides,
} from './setup.ts';

/**
 * The shadow boundary against a REAL git: the guarantees this feature makes are git's behaviour
 * under an injected environment, and a stubbed git would prove only that the stub agrees with the
 * plan. Every case runs actual pushes through actual hooks.
 */
// Real git, real hooks and a node start per hook: well past vitest's 5 s default on a loaded Windows host.
describe('prepareShadowRun (real git)', { timeout: 30_000 }, () => {
  let root: string;
  let repo: string;
  let dataDir: string;
  const RUN = 'run-1';

  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  const tryGit = (cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) =>
    spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  const intents = () => {
    const path = shadowPaths(shadowDir(dataDir, RUN)).intents;
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  };

  beforeEach(() => {
    root = mkdtempSync(join(realpathSync(tmpdir()), 'cez-shadow-'));
    repo = join(root, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '--quiet', '-b', 'main');
    git(repo, 'config', 'user.name', 'Shadow Test');
    git(repo, 'config', 'user.email', 'shadow@example.com');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '--quiet', '-m', 'init');
    // Never contacted: every push is redirected before git would open a connection.
    git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widget.git');
    dataDir = join(repo, '.ai', 'cezar');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('records a push to origin, rejects it, pins the commit and leaves no remote-tracking ref', async () => {
    const shadow = await prepareShadowRun({ dataDir, runId: RUN, repoRoot: repo });
    writeFileSync(join(repo, 'b.txt'), 'b\n');
    git(repo, 'add', 'b.txt');
    git(repo, 'commit', '--quiet', '-m', 'work');
    const head = git(repo, 'rev-parse', 'HEAD').trim();

    const push = tryGit(repo, ['push', 'origin', 'HEAD:refs/heads/feature'], withEnvOverrides(process.env, shadow.env));

    expect(push.status).not.toBe(0);
    expect(push.stderr).toContain('cezar shadow: recorded the push of refs/heads/feature');
    const [intent] = intents();
    expect(intent).toMatchObject({ kind: 'push', remote: 'origin', ref: 'refs/heads/feature', sha: head, pinned: true });
    expect(git(repo, 'rev-parse', `refs/cezar/shadow/${RUN}/${String(intent?.id)}`).trim()).toBe(head);
    // The load-bearing half: an ACCEPTED push would have moved origin/feature, and through
    // `resolveBaseRef` every later task would fork from a commit origin does not have.
    expect(tryGit(repo, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/feature']).status).not.toBe(0);
  });

  it('blocks a push to a URL no remote names, without recording it', async () => {
    const shadow = await prepareShadowRun({ dataDir, runId: RUN, repoRoot: repo });
    const push = tryGit(
      repo,
      ['push', 'https://gitlab.example.com/other/repo.git', 'HEAD:refs/heads/x'],
      withEnvOverrides(process.env, shadow.env),
    );
    expect(push.status).not.toBe(0);
    expect(intents()).toEqual([]);
  });

  it('blocks an scp-style push to another host as well', async () => {
    const shadow = await prepareShadowRun({ dataDir, runId: RUN, repoRoot: repo });
    const push = tryGit(repo, ['push', 'git@gitlab.example.com:other/repo.git', 'HEAD:refs/heads/x'], withEnvOverrides(process.env, shadow.env));
    expect(push.status).not.toBe(0);
    expect(intents()).toEqual([]);
  });

  it('redirects an explicit pushurl through insteadOf and leaves the fetch URL alone', async () => {
    git(repo, 'remote', 'set-url', '--push', 'origin', 'git@github.com:acme/widget.git');
    const shadow = await prepareShadowRun({ dataDir, runId: RUN, repoRoot: repo });
    const env = withEnvOverrides(process.env, shadow.env);
    expect(tryGit(repo, ['remote', 'get-url', '--push', 'origin'], env).stdout.trim().replace(/\\/g, '/')).toContain(`/shadow/${RUN}/remotes/`);
    expect(tryGit(repo, ['remote', 'get-url', 'origin'], env).stdout.trim()).toBe('https://github.com/acme/widget.git');
  });

  it('refuses to arm a remote that pushes to the very URL it fetches from', async () => {
    git(repo, 'remote', 'set-url', '--push', 'origin', 'https://github.com/acme/widget.git');
    const armed = prepareShadowRun({ dataDir, runId: RUN, repoRoot: repo });
    await expect(armed).rejects.toBeInstanceOf(ShadowSetupError);
    await expect(armed).rejects.toThrow(/also how it fetches/);
  });

  it('is idempotent: arming again keeps the redirect working', async () => {
    await prepareShadowRun({ dataDir, runId: RUN, repoRoot: repo });
    const again = await prepareShadowRun({ dataDir, runId: RUN, repoRoot: repo });
    const push = tryGit(repo, ['push', 'origin', 'HEAD:refs/heads/again'], withEnvOverrides(process.env, again.env));
    expect(push.status).not.toBe(0);
    expect(intents()).toHaveLength(1);
  });

  it('records a gh write through the shim entry and executes nothing', async () => {
    const shadow = await prepareShadowRun({ dataDir, runId: RUN, repoRoot: repo });
    const shim = shimInvocation();
    const out = spawnSync(
      shim.node,
      [...shim.args, 'gh', shadowDir(dataDir, RUN), 'pr', 'create', '--title', 'Fix login', '--body', 'x'],
      { cwd: repo, env: withEnvOverrides(process.env, shadow.env), encoding: 'utf8' },
    );
    expect(out.stderr).toBe('');
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('recorded "gh pr create"');
    expect(intents()).toMatchObject([{ kind: 'forge', tool: 'gh', argv: ['pr', 'create', '--title', 'Fix login', '--body', 'x'] }]);
  });

  it('arms outside any git repository: the probe has a scratch repository of its own', async () => {
    const outside = mkdtempSync(join(realpathSync(tmpdir()), 'cez-shadow-norepo-'));
    try {
      const shadow = await prepareShadowRun({ dataDir: join(outside, '.ai', 'cezar'), runId: RUN, repoRoot: outside });
      expect(shadow.remotes).toEqual([]);
      expect(shadow.env.CEZ_SHADOW).toBe('1');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('check-step wrapper: puts the shim back in front of a PATH a login profile replaced', async () => {
    const hasBash = spawnSync('bash', ['-c', 'true']).status === 0;
    if (!hasBash) return; // check steps need bash; without it there is nothing to wrap
    const shadow = await prepareShadowRun({ dataDir, runId: RUN, repoRoot: repo });
    // The profile "replaced" PATH: the env the wrapper starts with has no shim directory at all.
    const env = withEnvOverrides(process.env, {
      ...shadow.env,
      PATH: process.env.PATH ?? '',
      CEZ_SHADOW_COMMAND: 'command -v gh',
    });
    const out = spawnSync('bash', ['-c', SHADOW_CHECK_WRAPPER], { cwd: repo, env, encoding: 'utf8' });
    expect(out.status).toBe(0);
    expect(out.stdout.trim().endsWith('/bin/gh')).toBe(true);
    expect(out.stdout).toContain(`shadow/${RUN}/bin/gh`);
  });

  it('puts the gh shim first on PATH and works in a repository with no remote', async () => {
    git(repo, 'remote', 'remove', 'origin');
    const shadow = await prepareShadowRun({ dataDir, runId: RUN, repoRoot: repo });
    expect(shadow.remotes).toEqual([]);
    const bin = shadowPaths(shadowDir(dataDir, RUN)).bin;
    expect(shadow.env.PATH?.startsWith(bin)).toBe(true);
    expect(existsSync(join(bin, 'gh'))).toBe(true);
    expect(existsSync(join(bin, 'gh.cmd'))).toBe(true);
  });
});

describe('findExecutable', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(realpathSync(tmpdir()), 'cez-shadow-path-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips a directory that merely has the binary name (#1066) and the excluded shim directory', () => {
    // Host-native platform and separator: a Windows path carries a drive-letter colon, so a
    // POSIX-style search path cannot be built from real directories there.
    const platform = process.platform;
    const separator = platform === 'win32' ? ';' : ':';
    const binary = platform === 'win32' ? 'gh.exe' : 'gh';
    const fake = join(dir, 'a');
    const shims = join(dir, 'shims');
    const real = join(dir, 'real');
    mkdirSync(join(fake, binary), { recursive: true }); // a DIRECTORY named like the binary
    mkdirSync(shims, { recursive: true });
    mkdirSync(real, { recursive: true });
    writeFileSync(join(shims, binary), '#!/bin/sh\n', { mode: 0o755 });
    expect(findExecutable('gh', [fake, shims].join(separator), platform, [shims])).toBeNull();
    writeFileSync(join(real, binary), '#!/bin/sh\n', { mode: 0o755 });
    expect(findExecutable('gh', [fake, shims, real].join(separator), platform, [shims])).toBe(join(real, binary));
  });

  it('only accepts .exe and .com on Windows', () => {
    writeFileSync(join(dir, 'gh.cmd'), '@echo off\r\n');
    expect(findExecutable('gh', dir, 'win32')).toBeNull();
    writeFileSync(join(dir, 'gh.exe'), '');
    expect(findExecutable('gh', dir, 'win32')).toBe(join(dir, 'gh.exe'));
  });
});
