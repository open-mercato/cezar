import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The container lifecycle is mocked, never run: an earlier version of this
// suite reached a real podman and left four containers on the developer's
// machine. Mocking is also what lets the podman branch be tested at all.
const lifecycle = vi.hoisted(() => ({
  start: vi.fn(),
}));
vi.mock('../core/podman-lifecycle.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/podman-lifecycle.ts')>();
  return { ...actual, startTaskContainer: lifecycle.start };
});

import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import { defaultSandboxFor, type SandboxConfig } from '../config.ts';
import { PodmanUnavailable } from '../core/podman-lifecycle.ts';
import type { ProcessLauncher } from '../core/process-launcher.ts';

/**
 * Where a task's agent ACTUALLY runs, and what the record says about it.
 *
 * The request (`isolated`) and the outcome (`isolation`) are different facts,
 * and the cockpit's indicator reads the second. They disagree whenever a
 * container was wanted and not obtained — and they disagreed in a worse way
 * before this: a container was started for a task marked isolated, the record
 * said so, and the agent then ran on the host because the launcher was built
 * from the config the caller had read instead of the placement just decided.
 */

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const roots: string[] = [];

type Seam = {
  launcherForTurn(
    runId: string,
    sandbox: SandboxConfig | undefined,
    backend: 'claude' | undefined,
    stepId: string,
    accountEnv?: Record<string, string>,
    purpose?: 'agent' | 'check',
  ): Promise<{ launcher: ProcessLauncher; fatal: string | null }>;
};

function harness(): { store: RunStore; seam: Seam; runId: (isolated?: boolean) => string } {
  const root = mkdtempSync(join(tmpdir(), 'cez-isolation-record-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', [...GIT_ID, 'commit', '--allow-empty', '-q', '-m', 'base'], { cwd: root });
  const store = RunStore.open(join(root, '.ai/cezar'));
  const manager = new RunManager(store, root);
  return {
    store,
    seam: manager as unknown as Seam,
    runId: (isolated?: boolean) =>
      store.createRun({
        title: 't',
        workflow: 'w',
        task: 't',
        steps: [{ id: 'step', name: 'step', kind: 'agent' }],
        ...(isolated === undefined ? {} : { isolated }),
      }).id,
  };
}

const podman = (over: Partial<SandboxConfig> = {}): SandboxConfig => ({
  enabled: true,
  provider: 'podman',
  name: 'x',
  tmpdir: '/tmp/cez-agent',
  containerfile: '.ai/cezar/Containerfile',
  claudeCredentialPassthrough: false,
  resources: { shmSize: '1g' },
  ...over,
} as SandboxConfig);

beforeEach(() => {
  lifecycle.start.mockReset();
  lifecycle.start.mockImplementation(async (_cfg: SandboxConfig, _root: string, runId: string) => ({
    name: `cez-${runId.slice(0, 8)}`,
  }));
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('a task marked isolated runs its agent IN the container', () => {
  it('when the project switch is OFF', async () => {
    // The regression: `prepareSandbox` started the container and recorded
    // `effective: true`, then the caller built the launcher from ITS sandbox —
    // `enabled: false` — and the launcher factory answered with the local one.
    const { store, seam, runId } = harness();
    const id = runId(true);
    const turn = await seam.launcherForTurn(id, podman({ enabled: false }), 'claude', 'step');
    expect(lifecycle.start).toHaveBeenCalledTimes(1);
    expect(turn.launcher.id).toBe('podman');
    expect(store.getRun(id)?.isolation).toMatchObject({ effective: true });
  });

  it('when the project has no sandbox config at all', async () => {
    const { store, seam, runId } = harness();
    const id = runId(true);
    const turn = await seam.launcherForTurn(id, undefined, 'claude', 'step');
    expect(turn.launcher.id).toBe('podman');
    expect(store.getRun(id)?.isolation?.effective).toBe(true);
  });

  it('and the record never claims isolation for a turn that is not isolated', async () => {
    // The invariant the indicator depends on, checked from both ends.
    const { store, seam, runId } = harness();
    for (const [isolated, sandbox] of [
      [true, podman({ enabled: false })],
      [undefined, podman()],
      [false, podman()],
      [undefined, undefined],
    ] as const) {
      const id = runId(isolated);
      const turn = await seam.launcherForTurn(id, sandbox, 'claude', 'step');
      expect(turn.launcher.id !== 'local', JSON.stringify({ isolated, sandbox: !!sandbox }))
        .toBe(store.getRun(id)?.isolation?.effective === true);
    }
  });
});

describe('what a run records about where it ran', () => {
  it('records "not isolated" with no reason when nobody asked', async () => {
    const { store, seam, runId } = harness();
    const id = runId();
    const turn = await seam.launcherForTurn(id, undefined, 'claude', 'step');
    expect(turn.launcher.id).toBe('local');
    expect(store.getRun(id)?.isolation).toEqual({ effective: false });
  });

  it('a task that opts OUT stays on the host even where the project isolates', async () => {
    const { store, seam, runId } = harness();
    const id = runId(false);
    const turn = await seam.launcherForTurn(id, podman(), 'claude', 'step');
    expect(lifecycle.start).not.toHaveBeenCalled();
    expect(turn.launcher.id).toBe('local');
    expect(store.getRun(id)?.isolation).toEqual({ effective: false });
  });

  it('records WHY a wanted container did not happen, and keeps the request intact', async () => {
    lifecycle.start.mockRejectedValueOnce(new PodmanUnavailable('podman machine is stopped'));
    const { store, seam, runId } = harness();
    const id = runId(true);
    const turn = await seam.launcherForTurn(id, podman(), 'claude', 'step');
    expect(turn.launcher.id).toBe('local');
    expect(store.getRun(id)?.isolation).toMatchObject({ effective: false, reason: expect.stringMatching(/stopped/) });
    // The REQUEST survives: a Continue reads `isolated` as its override.
    expect(store.getRun(id)?.isolated).toBe(true);
  });

  it('a later turn keeps the first fallback\'s reason instead of erasing it', async () => {
    // Before this, turn 2 read `effective: false`, took the "not wanted" branch
    // and wrote a bare `{ effective: false }` — making a run that asked for
    // isolation and missed it look like one that never asked.
    lifecycle.start.mockRejectedValueOnce(new PodmanUnavailable('podman machine is stopped'));
    const { store, seam, runId } = harness();
    const id = runId(true);
    await seam.launcherForTurn(id, podman(), 'claude', 'step');
    const first = store.getRun(id)?.isolation;
    await seam.launcherForTurn(id, podman(), 'claude', 'step');
    expect(store.getRun(id)?.isolation).toEqual(first);
    expect(store.getRun(id)?.isolation?.reason).toMatch(/stopped/);
  });

  it('a run that already executed goes BACK where it went, not where it asked', async () => {
    // Its conversation lives in the home that wrote it; `claude --resume` on a
    // session it cannot see fails with an opaque error_during_execution.
    const { store, seam, runId } = harness();
    const id = runId(false);
    await seam.launcherForTurn(id, podman(), 'claude', 'step');
    // The task is later marked isolated, and podman is available. It must not move.
    store.updateRun(id, { isolated: true });
    const turn = await seam.launcherForTurn(id, podman(), 'claude', 'step');
    expect(turn.launcher.id).toBe('local');
    expect(lifecycle.start).not.toHaveBeenCalled();
  });
});

describe('a dry run', () => {
  it('never puts a task in a container — its agents are the bundled mocks on this machine', async () => {
    const saved = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    try {
      const { store, seam, runId } = harness();
      const id = runId(true);
      const turn = await seam.launcherForTurn(id, podman(), 'claude', 'step');
      expect(turn.launcher.id).toBe('local');
      expect(lifecycle.start).not.toHaveBeenCalled();
      expect(store.getRun(id)?.isolation).toMatchObject({ effective: false, reason: expect.stringContaining('dry run') });
    } finally {
      if (saved === undefined) delete process.env.CEZ_DRY_RUN;
      else process.env.CEZ_DRY_RUN = saved;
    }
  });
});

describe('secrets are fetched only where they can be delivered', () => {
  const vaultSecret = {
    credentials: { custom: [{ id: 'k', env: ['K'], valueFrom: 'vault://kv/app#k', required: true }] },
  } as Partial<SandboxConfig>;

  it('a required secret cannot fail a turn that runs on the host', async () => {
    // The local launcher ignores fetched values, so fetching for a host turn
    // only created a way to fail a task over a secret it would have discarded.
    const { seam, runId } = harness();
    const id = runId(false);
    const turn = await seam.launcherForTurn(id, podman(vaultSecret), 'claude', 'step');
    expect(turn.fatal).toBeNull();
    expect(turn.launcher.id).toBe('local');
  });
});

describe('a login the container keeps for itself', () => {
  const savedHome = process.env.CEZ_HOME;
  afterEach(() => {
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
  });

  /** A copied Claude login about to expire, and a fresh CEZ_HOME holding only what the case stores. */
  async function expiringTurn(store?: { name: string; value: string }) {
    process.env.CEZ_HOME = mkdtempSync(join(tmpdir(), 'cez-container-secrets-'));
    roots.push(process.env.CEZ_HOME);
    if (store) {
      const { SecretStore } = await import('../workspace/secrets.ts');
      await new SecretStore(process.env, { keychain: async () => null }).set({ kind: 'workspace' }, store.name, store.value, ['containers']);
    }
    lifecycle.start.mockImplementation(async (_cfg: SandboxConfig, _root: string, runId: string) => ({
      name: `cez-${runId.slice(0, 8)}`,
      claudeLoginExpiresAt: Date.now() + 60_000,
    }));
    const { store: runs, seam, runId } = harness();
    const id = runId(true);
    const turn = await seam.launcherForTurn(id, podman(), 'claude', 'step');
    const notes = runs.readEvents(id).filter((e) => e.type === 'note').map((e) => String(e.message));
    return { turn, notes };
  }

  it('hands a `containers` secret to the container, and a stored token silences the expiry warning', async () => {
    const { turn, notes } = await expiringTurn({ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'sk-ant-oat01-test-token' });
    expect(turn.launcher.id).toBe('podman');
    expect((turn.launcher as unknown as { fetchedEnv: string[] }).fetchedEnv).toContain('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-test-token');
    expect(notes.some((n) => n.includes('Claude login copied'))).toBe(false);
  });

  it('never hands a `containers` secret to a check step — the audience names agents', async () => {
    process.env.CEZ_HOME = mkdtempSync(join(tmpdir(), 'cez-container-secrets-'));
    roots.push(process.env.CEZ_HOME);
    const { SecretStore } = await import('../workspace/secrets.ts');
    await new SecretStore(process.env, { keychain: async () => null }).set({ kind: 'workspace' }, 'CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat01-x', ['containers']);
    const { store: runs, seam, runId } = harness();
    const id = runId(true);
    const turn = await seam.launcherForTurn(id, podman(), 'claude', 'step', undefined, 'check');
    expect(turn.launcher.id).toBe('podman');
    expect((turn.launcher as unknown as { fetchedEnv: string[] }).fetchedEnv.join(' ')).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    // And a check step leaves the step's agent-turn record alone.
    expect(runs.getRun(id)?.steps[0]?.isolated).toBeUndefined();
  });

  it('warns about a copy that is about to expire, naming both lasting fixes', async () => {
    const { notes } = await expiringTurn();
    const warning = notes.find((n) => n.includes('Claude login copied'));
    expect(warning).toContain('cez container-login claude');
    expect(warning).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });
});

describe('the default sandbox for an unconfigured repo', () => {
  it('is the same configuration the Settings switch would write', () => {
    const sandbox = defaultSandboxFor('commetria');
    expect(sandbox).toMatchObject({ enabled: true, provider: 'podman', name: 'commetria' });
    expect(sandbox.resources?.shmSize).toBe('1g');
  });

  it('cleans a directory name into one podman accepts', () => {
    expect(defaultSandboxFor('My Repo (v2)').name).toBe('my-repo-v2');
    expect(defaultSandboxFor('...').name).toBe('cezar');
  });
});
