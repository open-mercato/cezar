import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SandboxConfig } from '../config.ts';
import { agentKimiHome } from './kimi-home.ts';
import { BASE_IMAGE_TAG, GUEST_KIMI_HOME, hostKimiLogin, podmanExec, podmanRunArgs } from './podman-launcher.ts';
import { baseContainerfileHash, ensureBaseImage, ensureImage, syncKimiConfig } from './podman-lifecycle.ts';

/**
 * Kimi in an isolated task: the image ships `kimi`, the agent gets its own Kimi home on the host
 * (where cezar reads its token usage), and the host's login reaches it as mounted DIRECTORIES.
 * Plus the rebuild rules that get the new image onto a machine that built the old one.
 */

const cfg = (over: Partial<SandboxConfig> = {}): SandboxConfig => ({
  enabled: true,
  provider: 'podman',
  name: 'app',
  tmpdir: '/tmp/cez-agent',
  containerfile: '.ai/cezar/Containerfile',
  claudeCredentialPassthrough: true,
  resources: { shmSize: '1g' },
  ...over,
});

const REPO = '/Users/k/work/app';

describe('a Kimi agent in a podman container', () => {
  it('gets its own Kimi home, mounted where the image’s kimi looks for it', () => {
    const args = podmanRunArgs(cfg(), 'cez-run1', REPO, { credentialPassthrough: false });
    expect(args).toContain(`${agentKimiHome()}:${GUEST_KIMI_HOME}`);
    expect(GUEST_KIMI_HOME).toBe('/root/.kimi-code');
  });

  it('mounts the host’s Kimi login directories under passthrough, and only those that exist', () => {
    const [[credentials, guestCredentials], [oauth, guestOauth]] = hostKimiLogin() as [[string, string], [string, string]];
    const present = (path: string) => path === credentials;
    const args = podmanRunArgs(cfg(), 'c', REPO, { credentialPassthrough: true, credentialExists: present, backends: ['kimi'] });
    expect(args).toContain(`${credentials}:${guestCredentials}`);
    expect(args.join(' ')).not.toContain(`${oauth}:${guestOauth}`);
    expect(guestCredentials).toBe('/root/.kimi-code/credentials');
  });

  it('mounts no Kimi login into a container that is not running Kimi — a Claude task never sees it', () => {
    const args = podmanRunArgs(cfg(), 'c', REPO, { credentialPassthrough: true, credentialExists: () => true, backends: ['claude'] });
    expect(args.join(' ')).not.toContain('/root/.kimi-code/credentials');
  });

  it('passes no Kimi login when credential passthrough is off', () => {
    const args = podmanRunArgs(cfg(), 'c', REPO, { credentialPassthrough: false, credentialExists: () => true });
    expect(args.join(' ')).not.toContain('/root/.kimi-code/credentials');
  });

  it('never hands the container a host path as KIMI_CODE_HOME', () => {
    const { args, env } = podmanExec(
      cfg(),
      'c',
      'kimi',
      ['acp'],
      { cwd: REPO, env: { KIMI_CODE_HOME: '/Users/k/profiles/work', KIMI_API_KEY: 'k' } },
      '/tmp/pid',
    );
    expect(args).toContain('KIMI_API_KEY');
    expect(env.KIMI_API_KEY).toBe('k');
    expect(args.join(' ')).not.toContain('KIMI_CODE_HOME');
    expect(env.KIMI_CODE_HOME).toBeUndefined();
  });

  it('copies the host’s config.toml into the agent home, and is silent without one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-kimi-sync-'));
    const source = join(dir, 'config.toml');
    const home = join(dir, 'agent');
    syncKimiConfig(source, home);
    expect(existsSync(join(home, 'config.toml'))).toBe(false);
    writeFileSync(source, 'default_model = "kimi-code/k3"\n');
    syncKimiConfig(source, home);
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toContain('kimi-code/k3');
  });
});

/**
 * A stand-in `podman`: records every call; `image exists` answers from marker files,
 * `image inspect` answers the base's label and each tag's creation time from files too.
 */
function fakePodman(): { bin: string; dir: string; calls: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'cez-fake-podman-'));
  const bin = join(dir, 'podman');
  const log = join(dir, 'calls.log');
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$*" >> "${log}"
key=$(echo "$3" | tr '/:' '__')
if [ "$1" = image ] && [ "$2" = exists ]; then [ -f "${dir}/exists-$key" ] && exit 0; exit 1; fi
if [ "$1" = image ] && [ "$2" = inspect ]; then
  case "$5" in
    *Labels*) [ -f "${dir}/label-$key" ] && cat "${dir}/label-$key"; exit 0;;
    *Created*) [ -f "${dir}/created-$key" ] && cat "${dir}/created-$key" && exit 0; exit 1;;
  esac
fi
exit 0
`,
    { mode: 0o755 },
  );
  return { bin, dir, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []) };
}

const keyOf = (tag: string) => tag.replace(/[/:]/g, '_');

describe('keeping the base image current', () => {
  it('rebuilds a base built from an older Containerfile, stamping the new hash', async () => {
    const podman = fakePodman();
    writeFileSync(join(podman.dir, `exists-${keyOf(BASE_IMAGE_TAG)}`), '');
    writeFileSync(join(podman.dir, `label-${keyOf(BASE_IMAGE_TAG)}`), 'an-older-hash\n');
    await ensureBaseImage(podman.bin);
    const build = podman.calls().find((call) => call.startsWith('build'));
    expect(build).toContain(`--label dev.cezar.containerfile-sha256=${baseContainerfileHash()}`);
  });

  it('keeps a base whose label matches — no build before every task', async () => {
    const podman = fakePodman();
    writeFileSync(join(podman.dir, `exists-${keyOf(BASE_IMAGE_TAG)}`), '');
    writeFileSync(join(podman.dir, `label-${keyOf(BASE_IMAGE_TAG)}`), `${baseContainerfileHash()}\n`);
    await ensureBaseImage(podman.bin);
    expect(podman.calls().some((call) => call.startsWith('build'))).toBe(false);
  });

  it('rebuilds a base that predates the label (every base built before this cezar)', async () => {
    const podman = fakePodman();
    writeFileSync(join(podman.dir, `exists-${keyOf(BASE_IMAGE_TAG)}`), '');
    await ensureBaseImage(podman.bin);
    expect(podman.calls().some((call) => call.startsWith('build'))).toBe(true);
  });
});

describe('keeping a repo image current with its base', () => {
  function repoWithContainerfile(): string {
    const repo = mkdtempSync(join(tmpdir(), 'cez-repo-'));
    mkdirSync(join(repo, '.ai', 'cezar'), { recursive: true });
    writeFileSync(join(repo, '.ai', 'cezar', 'Containerfile'), `FROM ${BASE_IMAGE_TAG}\n`);
    return repo;
  }

  function currentBase(podman: ReturnType<typeof fakePodman>, created: string): void {
    writeFileSync(join(podman.dir, `exists-${keyOf(BASE_IMAGE_TAG)}`), '');
    writeFileSync(join(podman.dir, `label-${keyOf(BASE_IMAGE_TAG)}`), `${baseContainerfileHash()}\n`);
    writeFileSync(join(podman.dir, `created-${keyOf(BASE_IMAGE_TAG)}`), `${created}\n`);
  }

  it('rebuilds a repo image built FROM an older base, so it gains what the base gained', async () => {
    const podman = fakePodman();
    currentBase(podman, '2030-01-02T00:00:00Z');
    const tag = 'cezar-agent/app:latest';
    writeFileSync(join(podman.dir, `exists-${keyOf(tag)}`), '');
    writeFileSync(join(podman.dir, `created-${keyOf(tag)}`), '2030-01-01T00:00:00Z\n');
    await ensureImage(cfg(), repoWithContainerfile(), podman.bin);
    expect(podman.calls().filter((call) => call.startsWith('build'))).toEqual([
      expect.stringContaining(`-t ${tag}`),
    ]);
  });

  it('reuses a repo image newer than its base and its Containerfile', async () => {
    const podman = fakePodman();
    currentBase(podman, '2000-01-01T00:00:00Z');
    const tag = 'cezar-agent/app:latest';
    writeFileSync(join(podman.dir, `exists-${keyOf(tag)}`), '');
    writeFileSync(join(podman.dir, `created-${keyOf(tag)}`), '2999-01-01T00:00:00Z\n');
    await ensureImage(cfg(), repoWithContainerfile(), podman.bin);
    expect(podman.calls().some((call) => call.startsWith('build'))).toBe(false);
  });
});
