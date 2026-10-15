import { describe, expect, it } from 'vitest';
import { applyCredentialsToRunning, containerClaudeLogin, syncClaudeCredential, taskContainerName, type MountSpec } from './podman-lifecycle.ts';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SandboxConfig } from '../config.ts';

describe('podman lifecycle', () => {
  it('names a container after its run, prefixed so a stray one is obviously cezar\'s', () => {
    expect(taskContainerName('ab57117a-607c-4393-8bfc-b9c99145dac8')).toBe('cez-ab57117a');
    // Stable for the same run: a Continue must find the container the first
    // turn created, not make a second one beside it.
    expect(taskContainerName('ab57117a-607c-4393-8bfc-b9c99145dac8'))
      .toBe(taskContainerName('ab57117a-607c-4393-8bfc-b9c99145dac8'));
  });
});


/**
 * A stand-in `podman` binary: records every call, and keeps each container's
 * credential manifest in a directory so a later `cat` sees an earlier `cp`.
 * Tests pass its path as `bin`, so nothing here can reach a real podman.
 */
function fakePodman(): { bin: string; calls: () => string[]; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cez-fake-podman-'));
  const bin = join(dir, 'podman');
  const log = join(dir, 'calls.log');
  writeFileSync(bin, `#!/bin/sh
echo "$*" >> "${log}"
if [ "$1" = exec ] && [ "$3" = cat ]; then
  [ -f "${dir}/manifest-$2" ] && cat "${dir}/manifest-$2" && exit 0
  exit 1
fi
if [ "$1" = cp ]; then
  case "$3" in *:/root/.cezar-credentials.json) cp "$2" "${dir}/manifest-\${3%%:*}";; esac
fi
exit 0
`, { mode: 0o755 });
  return {
    bin,
    dir,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []),
  };
}

describe('applying a credential to containers that already exist', () => {
  const REPO = '/Users/k/work/app';
  const OTHER = '/Users/k/work/other';
  // A selection whose file is absent: resolved (so the early return does not
  // fire) but with an empty copy plan, so nothing is executed and the test
  // observes the CHOICE of containers rather than the copying.
  const cfg = {
    credentials: { enabled: { aws: true } },
  } as unknown as SandboxConfig;

  const podman = (mounts: Record<string, string[]>): (args: string[]) => Promise<string> => async (args) => {
    if (args[0] === 'ps') return Object.keys(mounts).join('\n');
    if (args[0] === 'inspect') return (mounts[args[1] as string] ?? []).join('\n');
    throw new Error(`unexpected: ${args.join(' ')}`);
  };

  it('updates this project\'s containers and NOBODY else\'s', async () => {
    // Matched by the workspace a container has mounted, because that is the
    // only statement about which repo it belongs to that cannot drift. Pushing
    // one project's keys into another project's container is the failure this
    // is designed against.
    const updated = await applyCredentialsToRunning(cfg, REPO, fakePodman().bin, podman({
      'cez-aaaaaaaa': [REPO, '/Users/k/.claude-agent'],
      'cez-bbbbbbbb': [OTHER],
      'cez-cccccccc': [REPO],
    }));
    expect(updated).toEqual(['cez-aaaaaaaa', 'cez-cccccccc']);
  });

  it('ignores containers that are not cezar\'s', async () => {
    const updated = await applyCredentialsToRunning(cfg, REPO, fakePodman().bin, podman({
      'postgres-dev': [REPO],
      'cez-aaaaaaaa': [REPO],
    }));
    expect(updated).toEqual(['cez-aaaaaaaa']);
  });

  it('answers empty when podman is not there — a save must not fail on it', async () => {
    const broken = async (): Promise<string> => { throw new Error('podman: command not found'); };
    await expect(applyCredentialsToRunning(cfg, REPO, fakePodman().bin, broken)).resolves.toEqual([]);
  });

  it('still reaches running containers when NOTHING is selected any more', async () => {
    // This used to return early — so "revoke everything", the one change that
    // most needs to reach a running container, never did.
    const none = { credentials: {} } as unknown as SandboxConfig;
    const updated = await applyCredentialsToRunning(none, REPO, fakePodman().bin, podman({ 'cez-aaaaaaaa': [REPO] }));
    expect(updated).toEqual(['cez-aaaaaaaa']);
  });

  it('REMOVES a credential that was revoked since the last apply', async () => {
    // Before, this only ever copied: an un-ticked ssh key stayed usable in the
    // running container while the page said the change applied to it.
    const fake = fakePodman();
    const home = mkdtempSync(join(tmpdir(), 'cez-cred-home-'));
    const keyA = join(home, 'a');
    const keyB = join(home, 'b');
    writeFileSync(keyA, 'A');
    writeFileSync(keyB, 'B');
    const grant = (ids: string[]) => ({
      credentials: {
        custom: ids.map((id) => ({ id, hostPath: id === 'a' ? keyA : keyB, guestPath: `/root/.keys/${id}` })),
      },
    }) as unknown as SandboxConfig;
    const containers = podman({ 'cez-aaaaaaaa': [REPO] });

    await applyCredentialsToRunning(grant(['a', 'b']), REPO, fake.bin, containers);
    expect(fake.calls().some((c) => c.includes('rm -f'))).toBe(false);

    await applyCredentialsToRunning(grant(['a']), REPO, fake.bin, containers);
    const removed = fake.calls().filter((c) => c.startsWith('exec cez-aaaaaaaa rm -f'));
    expect(removed).toEqual(['exec cez-aaaaaaaa rm -f /root/.keys/b']);
    // And what is still granted is left alone.
    expect(removed.some((c) => c.endsWith('/root/.keys/a'))).toBe(false);
  });
});

describe('the claude credential in a container from an older cezar', () => {
  // These containers bind-MOUNTED the credential. A relogin on the host
  // rewrites that file atomically, which unlinks the inode the mount holds:
  // `ls` still reports 508 bytes and every read fails with ENOENT. The agent
  // then says "Not logged in — please run /login", which is the one action that
  // cannot help, because doing it rewrites the file and breaks the mount again.
  const calls: string[][] = [];
  // A real file, so the test exercises the same path a logged-in machine does
  // and does not quietly skip itself on a machine that has never logged in.
  const source = ['{"claudeAiOauth":{"accessToken":"sk-ant-test"}}'];
  const podman = (readable: boolean): (args: string[]) => Promise<string> => async (args) => {
    calls.push(args);
    if (args[0] === 'exec' && args[2] === 'head' && !readable) throw new Error('ENOENT');
    return '';
  };

  it('restarts the container when the credential cannot be READ, and copies again', async () => {
    calls.length = 0;
    await syncClaudeCredential('cez-old', 'podman', podman(false), source);
    expect(calls.some((c) => c[0] === 'restart' && c[1] === 'cez-old')).toBe(true);
    // And the copy is redone AFTER the restart, or the container would come
    // back up holding whatever the stale mount resolves to.
    const restartAt = calls.findIndex((c) => c[0] === 'restart');
    expect(calls.slice(restartAt).some((c) => c[0] === 'cp')).toBe(true);
  });

  it('does NOT restart when the credential reads fine — the normal case', async () => {
    calls.length = 0;
    await syncClaudeCredential('cez-new', 'podman', podman(true), source);
    expect(calls.some((c) => c[0] === 'restart')).toBe(false);
  });

  it('checks by READING, never by ls — a deleted inode still stats', async () => {
    calls.length = 0;
    await syncClaudeCredential('cez-new', 'podman', podman(true), source);
    const probe = calls.find((c) => c[0] === 'exec' && c.includes('head'));
    expect(probe).toBeDefined();
    expect(calls.some((c) => c.includes('ls'))).toBe(false);
  });

  it('syncs nothing when the host has no credential — the Keychain case', async () => {
    // The container may hold its own login; overwriting it with nothing, or
    // restarting it in a loop, would be worse than leaving it alone.
    calls.length = 0;
    await syncClaudeCredential('cez-new', 'podman', podman(false), []);
    expect(calls).toEqual([]);
  });
});

describe('the Claude login a container gets', () => {
  const login = (accessToken: string, expiresAt: number, extra: object = {}) =>
    JSON.stringify({ claudeAiOauth: { accessToken, refreshToken: `rt-${accessToken}`, expiresAt, refreshTokenExpiresAt: 1, scopes: ['user:inference'] }, ...extra });

  it('never carries a refresh token — a container refreshing would spend the host’s', () => {
    const out = containerClaudeLogin([login('at-1', 2_000, { mcpOAuth: { s: { accessToken: 'm', refreshToken: 'mr' } } })]);
    expect(out?.json).not.toMatch(/rt-at-1|"mr"/);
    // Blanked, not deleted: a CLI that requires the key must still accept the file.
    expect(JSON.parse(out!.json)).toEqual({
      claudeAiOauth: { accessToken: 'at-1', refreshToken: '', expiresAt: 2_000, refreshTokenExpiresAt: 1, scopes: ['user:inference'] },
      mcpOAuth: { s: { accessToken: 'm', refreshToken: '' } },
    });
    expect(out?.expiresAt).toBe(2_000);
  });

  it('takes the freshest of the host’s logins, and skips a logged-out one', () => {
    // A logged-out Keychain item keeps its shape with every token emptied.
    const loggedOut = JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0 } });
    expect(containerClaudeLogin([login('old', 1_000), loggedOut, login('new', 5_000), 'not json'])?.expiresAt).toBe(5_000);
    expect(containerClaudeLogin([loggedOut])).toBeUndefined();
  });

  it('copies the stripped login, and says when it expires', async () => {
    const copied: string[] = [];
    const ask = async (args: string[]) => {
      if (args[0] === 'cp') copied.push(readFileSync(args[1]!, 'utf8'));
      return '';
    };
    expect(await syncClaudeCredential('cez-x', 'podman', ask, [login('at-2', 9_000)])).toEqual({ expiresAt: 9_000 });
    expect(copied).toHaveLength(1);
    expect(JSON.parse(copied[0]!).claudeAiOauth.refreshToken).toBe('');
  });
});

describe('pushing a credential change to running containers after a save', () => {
  const cfgWith = (marker: string) => ({ name: marker }) as unknown as SandboxConfig;

  it('runs pushes for one project one at a time, each with the config as it is when it starts', async () => {
    const { pushCredentialsToRunning } = await import('./podman-lifecycle.ts');
    let current = 'first';
    const applied: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const apply = async (cfg: SandboxConfig) => {
      applied.push(`start ${cfg.name}`);
      if (cfg.name === 'first') await gate;
      applied.push(`end ${cfg.name}`);
    };
    const load = async () => cfgWith(current);

    const one = pushCredentialsToRunning('/repo/a', load, apply);
    await Promise.resolve();
    await Promise.resolve();
    // Two more saves while the first push is still in the containers: they collapse into ONE
    // follow-up push, and it reads the config only when it starts — so it applies the latest.
    current = 'second';
    const two = pushCredentialsToRunning('/repo/a', load, apply);
    current = 'third';
    const three = pushCredentialsToRunning('/repo/a', load, apply);
    expect(three).toBe(two);
    release();
    await Promise.all([one, two, three]);
    expect(applied).toEqual(['start first', 'end first', 'start third', 'end third']);
  });

  it('never rejects: a podman failure does not reach the save', async () => {
    const { pushCredentialsToRunning } = await import('./podman-lifecycle.ts');
    await expect(
      pushCredentialsToRunning('/repo/b', async () => cfgWith('x'), async () => { throw new Error('no VM'); }),
    ).resolves.toBeUndefined();
  });

  it('keeps projects independent', async () => {
    const { pushCredentialsToRunning } = await import('./podman-lifecycle.ts');
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = pushCredentialsToRunning('/repo/c', async () => cfgWith('c'), async () => { await gate; seen.push('c'); });
    await pushCredentialsToRunning('/repo/d', async () => cfgWith('d'), async () => { seen.push('d'); });
    expect(seen).toEqual(['d']);
    release();
    await slow;
    expect(seen).toEqual(['d', 'c']);
  });
});

describe('a stopped podman VM', () => {
  /** A fake podman whose `machine list` answers `running`, and whose `machine start` exits `startCode`. */
  function machinePodman(running: boolean, startCode = 0): { bin: string; calls: () => string[] } {
    const dir = mkdtempSync(join(tmpdir(), 'cez-fake-machine-'));
    const bin = join(dir, 'podman');
    const log = join(dir, 'calls.log');
    writeFileSync(bin, `#!/bin/sh
echo "$*" >> "${log}"
if [ "$1" = machine ] && [ "$2" = list ]; then echo '[{"Name":"podman-machine-default","Running":${running}}]'; exit 0; fi
if [ "$1" = machine ] && [ "$2" = start ]; then sleep 0.2; [ ${startCode} = 0 ] || echo "VM is broken" >&2; exit ${startCode}; fi
exit 0
`, { mode: 0o755 });
    return { bin, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []) };
  }

  it('is started, so a task that asked for isolation gets it instead of running on the host', async () => {
    const { ensurePodmanMachine } = await import('./podman-lifecycle.ts');
    const podman = machinePodman(false);
    expect(await ensurePodmanMachine(podman.bin, 'darwin')).toBe('podman-machine-default');
    expect(podman.calls()).toContain('machine start podman-machine-default');
  });

  it('is started once for tasks that launch together', async () => {
    const { ensurePodmanMachine } = await import('./podman-lifecycle.ts');
    const podman = machinePodman(false);
    await Promise.all([ensurePodmanMachine(podman.bin, 'darwin'), ensurePodmanMachine(podman.bin, 'darwin')]);
    expect(podman.calls().filter((c) => c.startsWith('machine start'))).toHaveLength(1);
  });

  it('leaves a running VM alone, and Linux has none to start', async () => {
    const { ensurePodmanMachine } = await import('./podman-lifecycle.ts');
    const podman = machinePodman(true);
    expect(await ensurePodmanMachine(podman.bin, 'darwin')).toBeUndefined();
    expect(podman.calls().some((c) => c.startsWith('machine start'))).toBe(false);
    expect(await ensurePodmanMachine(podman.bin, 'linux')).toBeUndefined();
  });

  it('says so in podman’s own words when the VM cannot be started', async () => {
    const { ensurePodmanMachine, PodmanUnavailable } = await import('./podman-lifecycle.ts');
    const failing = ensurePodmanMachine(machinePodman(false, 1).bin, 'darwin');
    await expect(failing).rejects.toBeInstanceOf(PodmanUnavailable);
    await expect(failing).rejects.toThrow(/podman-machine-default.*could not be started.*VM is broken/);
  });
});

describe('a credential mounted after the task container started', () => {
  const repo = mkdtempSync(join(tmpdir(), 'cez-remount-repo-'));
  const home = mkdtempSync(join(tmpdir(), 'cez-remount-home-'));
  const cfg = {
    enabled: true, provider: 'podman', name: 'app',
    tmpdir: '/tmp/cez-agent', containerfile: '.ai/cezar/Containerfile',
    claudeCredentialPassthrough: false, resources: { shmSize: '1g' },
    credentials: { enabled: { railway: true } },
  } as unknown as SandboxConfig;

  /** What `startTaskContainer` asks for — the same options, so the comparison is like for like. */
  async function wanted(runId: string): Promise<MountSpec[]> {
    const { wantedMounts } = await import('./podman-lifecycle.ts');
    const { agentHomesFor } = await import('./kimi-home.ts');
    const { mkdirSync } = await import('node:fs');
    // The dirs `startTaskContainer` creates before it compares — a mount is wanted only for a
    // path that exists.
    for (const dir of [join(repo, '.ai/cezar/tmp', runId), join(repo, '.ai/cezar/runs')]) mkdirSync(dir, { recursive: true });
    return wantedMounts(cfg, repo, `cez-${runId.slice(0, 8)}`, { runId, homes: agentHomesFor(repo), backends: [], accountEnv: {} });
  }

  /** A fake podman: the task container exists, `inspect` reports `mounts` as podman's JSON. */
  function existingContainer(mounts: MountSpec[]): { bin: string; calls: () => string[] } {
    const dir = mkdtempSync(join(tmpdir(), 'cez-fake-remount-'));
    const bin = join(dir, 'podman');
    const log = join(dir, 'calls.log');
    writeFileSync(join(dir, 'mounts'), JSON.stringify(mounts.map((m) => ({
      Type: m.type,
      ...(m.type === 'volume' ? { Name: m.source } : { Source: m.source }),
      Destination: m.destination,
      RW: !m.readOnly,
    }))) + '\n');
    writeFileSync(bin, `#!/bin/sh
echo "$*" >> "${log}"
case "$1 $2" in
  "machine list") echo '[{"Name":"m","Running":true}]'; exit 0;;
  "container exists") exit 0;;
  "image exists") exit 0;;
esac
if [ "$1" = inspect ]; then cat "${dir}/mounts"; exit 0; fi
if [ "$1" = port ]; then exit 1; fi
exit 0
`, { mode: 0o755 });
    return { bin, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []) };
  }

  it('recreates the container to mount it, between turns', async () => {
    const { startTaskContainer } = await import('./podman-lifecycle.ts');
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(join(home, '.railway'), { recursive: true });
      const all = await wanted('run12345-0000');
      expect(all.map((m) => m.destination)).toContain('/root/.railway');
      const podman = existingContainer(all.filter((m) => m.destination !== '/root/.railway'));
      const container = await startTaskContainer(cfg, repo, 'run12345-0000', podman.bin);
      expect(container.remounted).toEqual(['/root/.railway']);
      const calls = podman.calls();
      expect(calls).toContain('rm -f -v cez-run12345');
      expect(calls.some((c) => c.startsWith('run --detach --name cez-run12345'))).toBe(true);
    } finally {
      process.env.HOME = savedHome;
    }
  });

  it('recreates a container that has a mount it should NOT — an unticked credential leaves', async () => {
    const { startTaskContainer } = await import('./podman-lifecycle.ts');
    const extra: MountSpec = { type: 'bind', source: join(home, '.ssh'), destination: '/root/.ssh', readOnly: false };
    const podman = existingContainer([...(await wanted('runaaaaa-0000')), extra]);
    const container = await startTaskContainer(cfg, repo, 'runaaaaa-0000', podman.bin);
    expect(container.remounted).toEqual(['/root/.ssh']);
    expect(podman.calls()).toContain('rm -f -v cez-runaaaaa');
  });

  it('recreates a container whose cezar data mount is writable where it should be read-only', async () => {
    const { startTaskContainer } = await import('./podman-lifecycle.ts');
    const all = await wanted('runbbbbb-0000');
    // Containers made before the hardening mounted `.ai/cezar` writable — where the agent could
    // grant itself credentials. The flag alone differs, and that is drift.
    const data = all.find((m) => m.destination === join(repo, '.ai/cezar'));
    expect(data?.readOnly).toBe(true);
    const podman = existingContainer(all.map((m) => (m === data ? { ...m, readOnly: false } : m)));
    const container = await startTaskContainer(cfg, repo, 'runbbbbb-0000', podman.bin);
    expect(container.remounted).toEqual([data!.destination]);
  });

  /**
   * A fake podman with STATE: the container's CLI probe answers from a file, a `build` records the
   * image's `dev.cezar.agents` label and `image inspect` reads it back, and `rm` gives the next
   * container whatever the image carries.
   */
  function statefulContainer(mounts: MountSpec[], opts: { hasCodex: boolean }): { bin: string; calls: () => string[] } {
    const fake = existingContainer(mounts);
    const dir = dirname(fake.bin);
    writeFileSync(join(dir, 'has-codex'), opts.hasCodex ? 'present' : 'absent');
    writeFileSync(join(dir, 'labels'), '');
    const script = readFileSync(fake.bin, 'utf8').replace('if [ "$1" = inspect ]', [
      'case "$*" in',
      `  *"command -v codex"*) cat "${dir}/has-codex"; exit 0;;`,
      `  "image inspect"*dev.cezar.agents*) cat "${dir}/labels"; exit 0;;`,
      'esac',
      `if [ "$1" = build ]; then for a in "$@"; do case "$a" in dev.cezar.agents=*) echo "\${a#dev.cezar.agents=}" > "${dir}/labels";; esac; done; exit 0; fi`,
      `if [ "$1" = rm ]; then case "$(cat "${dir}/labels")" in *codex*) echo present > "${dir}/has-codex";; esac; exit 0; fi`,
      'if [ "$1" = inspect ]',
    ].join('\n'));
    writeFileSync(fake.bin, script);
    return fake;
  }

  it('recreates a container whose image lacks the runner this turn needs, from an image that has it', async () => {
    const { startTaskContainer } = await import('./podman-lifecycle.ts');
    const podman = statefulContainer(await wanted('runccccc-0000'), { hasCodex: false });
    const container = await startTaskContainer(cfg, repo, 'runccccc-0000', podman.bin, { backend: 'codex' });
    expect(container.addedAgent).toBe('codex');
    const calls = podman.calls();
    expect(calls).toContain('rm -f -v cez-runccccc');
    expect(calls.some((c) => c.startsWith('build ') && c.includes('CEZ_AGENTS=codex') && c.includes('dev.cezar.agents=codex'))).toBe(true);
    // Woken BEFORE it is probed: `exec` into a stopped container fails, and that is no answer.
    const startAt = calls.indexOf('start cez-runccccc');
    const probeAt = calls.findIndex((c) => c.includes('command -v codex'));
    expect(startAt).toBeGreaterThanOrEqual(0);
    expect(startAt).toBeLessThan(probeAt);
  });

  it('reuses a container whose image already has the runner', async () => {
    const { startTaskContainer } = await import('./podman-lifecycle.ts');
    const podman = statefulContainer(await wanted('runddddd-0000'), { hasCodex: true });
    const container = await startTaskContainer(cfg, repo, 'runddddd-0000', podman.bin, { backend: 'codex' });
    expect(container.addedAgent).toBeUndefined();
    expect(podman.calls().some((c) => c.startsWith('rm '))).toBe(false);
  });

  it('runs on the host, never recreating, when the image is one cezar cannot add the CLI to', async () => {
    const { MissingAgentCli, startTaskContainer } = await import('./podman-lifecycle.ts');
    const pinned = { ...cfg, image: 'my/claude-only:v1' } as SandboxConfig;
    const podman = statefulContainer(await wanted('runeeeee-0000'), { hasCodex: false });
    await expect(startTaskContainer(pinned, repo, 'runeeeee-0000', podman.bin, { backend: 'codex' }))
      .rejects.toBeInstanceOf(MissingAgentCli);
    expect(podman.calls().some((c) => c.startsWith('rm '))).toBe(false);
  });

  it('adds az to the image when the Azure credential is ticked', async () => {
    const { startTaskContainer } = await import('./podman-lifecycle.ts');
    const { mkdirSync } = await import('node:fs');
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    try {
      mkdirSync(join(home, '.azure'), { recursive: true });
      const azure = { ...cfg, credentials: { enabled: { azure: true } } } as SandboxConfig;
      // The container predates the tick: no `~/.azure` mount, so it is recreated — from an image with az.
      const podman = statefulContainer(await wanted('runfffff-0000'), { hasCodex: true });
      await startTaskContainer(azure, repo, 'runfffff-0000', podman.bin);
      expect(podman.calls().some((c) => c.startsWith('build ') && c.includes('CEZ_AGENTS=azure-cli'))).toBe(true);
    } finally {
      process.env.HOME = savedHome;
    }
  });

  it('reuses a container that already has every mount it should', async () => {
    const { startTaskContainer } = await import('./podman-lifecycle.ts');
    const podman = existingContainer(await wanted('run67890-0000'));
    const container = await startTaskContainer(cfg, repo, 'run67890-0000', podman.bin);
    expect(container.remounted).toBeUndefined();
    expect(podman.calls().some((c) => c.startsWith('rm '))).toBe(false);
  });
});
