import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { agentClaudeHome, imageTag, podmanBuildArgs, podmanExec, podmanExecArgs, podmanRunArgs } from './podman-launcher.ts';
import { createLauncher } from './launcher-factory.ts';
import { localLauncher } from './process-launcher.ts';
import type { SandboxConfig } from '../config.ts';

const cfg = (over: Partial<SandboxConfig> = {}): SandboxConfig => ({
  enabled: true,
  provider: 'podman',
  name: 'textbook',
  tmpdir: '/tmp/cez-agent',
  containerfile: '.ai/cezar/Containerfile',
  claudeCredentialPassthrough: true,
  resources: { shmSize: '1g' },
  ...over,
});

const REPO = '/Users/k/work/app';

describe('podman launcher', () => {
  it('mounts the repo at its own absolute path — nothing translates paths', () => {
    const args = podmanRunArgs(cfg(), 'cez-run1', REPO);
    expect(args).toContain(`${REPO}:${REPO}`);
  });

  it('gives the agent its own claude home and none of the operator\'s conversations', () => {
    const args = podmanRunArgs(cfg(), 'cez-run1', REPO).join(' ');
    // On a host volume, so transcripts are never stranded in a dead container.
    expect(args).toContain(`${agentClaudeHome()}:/root/.claude`);
    expect(args).not.toContain('/.claude/projects');
    expect(args).not.toContain('/.claude/sessions');
    expect(args).not.toContain('history.jsonl');
  });

  it('NEVER mounts the Claude credential — a rewrite permanently breaks a file mount', () => {
    // Claude Code refreshes its OAuth token with temp-file-plus-rename, which
    // unlinks the inode a bind mount holds: the container keeps a deleted file,
    // reads fail, and the agent reports "Not logged in". Seen after ~35 hours.
    // `syncClaudeCredential` copies it in before every spawn instead.
    const args = podmanRunArgs(cfg(), 'cez-run1', REPO).join(' ');
    expect(args).not.toContain(`${homedir()}/.claude/.credentials.json:`);
  });


  it('a repo with no Containerfile runs the BASE image, not a tag that cannot exist', () => {
    // The derived tag is only buildable when there is a Containerfile to build
    // it from; naming it anyway made the default configuration unable to run.
    expect(imageTag(cfg(), false)).toBe('localhost/cezar-agent/base:latest');
    expect(imageTag(cfg(), true)).toBe('cezar-agent/textbook:latest');
    // A pin is a fallback for a repo with no Containerfile, NOT an override:
    // a config key must not silently shadow a file sitting in the repo.
    expect(imageTag(cfg({ image: 'my/img:1' }), false)).toBe('my/img:1');
    expect(imageTag(cfg({ image: 'my/img:1' }), true)).toBe('cezar-agent/textbook:latest');
    expect(podmanRunArgs(cfg(), 'c', REPO, { credentialPassthrough: false, hasContainerfile: false }))
      .toContain('localhost/cezar-agent/base:latest');
  });

  it('does NOT unset ANTHROPIC_API_KEY/GH_TOKEN', () => {
    // buildChildEnv forwards the host's REAL keys. Unsetting them here deleted
    // the only credential an API-key user has.
    const args = podmanExecArgs(cfg(), 'c', 'claude', [], { cwd: REPO, env: {} }, '/tmp/p.pid');
    expect(args.join(' ')).not.toContain('unset ANTHROPIC_API_KEY');
  });



  it('cache volumes survive the per-task container, so installs stay warm', () => {
    const args = podmanRunArgs(cfg({ cacheVolumes: { 'cez-npm': '/root/.npm' } }), 'cez-run1', REPO);
    expect(args).toContain('cez-npm:/root/.npm');
  });

  it('ephemeral paths get a fresh anonymous volume, shadowing the slow bind mount', () => {
    const args = podmanRunArgs(
      cfg({ ephemeralPaths: ['/Users/k/work/app/web/node_modules'] }),
      'cez-run1',
      REPO,
    );
    // A bare target with no source = anonymous volume: VM-native speed, never
    // on the host, discarded with the container.
    expect(args).toContain('/Users/k/work/app/web/node_modules');
    expect(args).not.toContain(`/Users/k/work/app/web/node_modules:/Users/k/work/app/web/node_modules`);
  });

  it('shm defaults to 1g — podman\'s 64m kills any headless browser the agent starts', () => {
    // And it fails as an out-of-memory error, not a shared-memory one, which is
    // why the default is set here rather than left to whoever debugs it.
    const args = podmanRunArgs(cfg(), 'cez-run1', REPO);
    expect(args).toContain('--shm-size');
    expect(args[args.indexOf('--shm-size') + 1]).toBe('1g');
  });

  it('memory and cpu limits are passed when set, and omitted when not', () => {
    const limited = podmanRunArgs(cfg({ resources: { shmSize: '2g', memory: '6g', cpus: 4 } }), 'c', REPO);
    expect(limited).toContain('--memory');
    expect(limited).toContain('6g');
    expect(limited).toContain('--cpus');
    expect(limited).toContain('4');
    // Unset means "whatever the VM has" — NOT a guessed cap.
    expect(podmanRunArgs(cfg(), 'c', REPO)).not.toContain('--memory');
  });

  it('publishes a loopback port for HTTP-speaking backends only when asked', () => {
    const withPort = podmanRunArgs(cfg(), 'c', REPO, { credentialPassthrough: true, publishPort: 41234 });
    expect(withPort).toContain('-p');
    expect(withPort).toContain('127.0.0.1:41234:41234');
    expect(podmanRunArgs(cfg(), 'c', REPO)).not.toContain('-p');
  });

  it('the image is per repo and prepared once, not built per task', () => {
    expect(imageTag(cfg())).toBe('cezar-agent/textbook:latest');
    // A pin applies only where there is no Containerfile to build from.
    expect(imageTag(cfg({ image: 'my/toolchain:v3' }), false)).toBe('my/toolchain:v3');
    expect(podmanBuildArgs(cfg(), `${REPO}/.ai/cezar/Containerfile`, REPO)).toEqual([
      'build', '-t', 'cezar-agent/textbook:latest', '-f', `${REPO}/.ai/cezar/Containerfile`, REPO,
    ]);
  });

  it('exec keeps stdin open, sets the worktree cwd, and never allocates a pty', () => {
    const { args, env } = podmanExec(cfg(), 'cez-run1', 'claude', ['--verbose'], {
      cwd: `${REPO}/.ai/cezar/worktrees/abc`,
      env: { CEZ_TASK_ID: 'abc', STRIPE_KEY: 'sk_live_secret_value' },
    }, '/tmp/cez-agent/p.pid');
    expect(args.slice(0, 4)).toEqual(['exec', '-i', '-w', `${REPO}/.ai/cezar/worktrees/abc`]);
    expect(args).not.toContain('-t');
    expect(args.slice(-3)).toEqual(['cez-podman', 'claude', '--verbose']);
    // Names on the argv, values in podman's own environment: argv is readable by every local
    // user through `ps`, and these carry Vault secrets and tokens.
    expect(args[args.indexOf('CEZ_TASK_ID') - 1]).toBe('-e');
    expect(env.CEZ_TASK_ID).toBe('abc');
    expect(args.join(' ')).not.toContain('sk_live_secret_value');
    expect(env.STRIPE_KEY).toBe('sk_live_secret_value');
    // Container-local TMPDIR, never the host's per-run one (see the base Containerfile).
    expect(env.TMPDIR).toBe('/tmp/cez-agent');
  });

  it('withholds the host\'s GitHub token unless the GitHub CLI is passed through', () => {
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = 'ghp_host_token_value';
    try {
      const off = podmanExec(cfg(), 'c', 'claude', [], { cwd: REPO, env: {} }, '/tmp/p');
      expect(off.args).not.toContain('GH_TOKEN');
      expect(off.env.GH_TOKEN).toBeUndefined();
      const on = podmanExec(cfg({ credentials: { enabled: { 'github-cli': true } } }), 'c', 'claude', [], { cwd: REPO, env: {} }, '/tmp/p');
      expect(on.env.GH_TOKEN).toBe('ghp_host_token_value');
    } finally {
      if (saved === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = saved;
    }
  });

  it('podman without a container falls back to local rather than faking isolation', () => {
    // A misconfigured run must not silently exec into nothing.
    expect(createLauncher(cfg())).toBe(localLauncher);
    expect(createLauncher(cfg(), { name: 'cez-run1' }).id).toBe('podman');
    expect(createLauncher(cfg(), { name: 'cez-run1' }).describe()).toContain('cez-run1');
  });
});
