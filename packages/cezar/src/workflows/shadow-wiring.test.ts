import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { shadowDir, shadowPaths } from '../shadow/ledger.ts';
import { ShadowSetupError } from '../shadow/setup.ts';
import { registerProject } from '../workspace/projects.ts';
import { RunManager } from './run.ts';

/**
 * Shadow mode reaches the spawn through `agentEnvForStep` - the last common path before every
 * backend spawn, fresh step and Continue alike (spec 2026-10-06-shadow-runs § Arming). Exercised
 * at that seam for the reason the TMPDIR tests give: what matters is the exact environment handed
 * to the child, and a dry run would prove nothing.
 *
 * The first case is the guard test AGENTS.md asks for when a feature is additive: with every new
 * knob at its default, the environment an ordinary run gets is the environment it always got.
 */
describe('RunManager - shadow wiring (spec 2026-10-06-shadow-runs)', { timeout: 30_000 }, () => {
  const savedHome = process.env.CEZ_HOME;
  let home: string;
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let manager: RunManager;

  type Seam = {
    agentEnvForStep(runId: string, backend: 'claude'): Promise<{ env: Record<string, string>; profileId: string }>;
  };
  const seam = () => manager as unknown as Seam;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });

  beforeEach(async () => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-shadow-wiring-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-shadow-wiring-repo-'));
    dataDir = join(repoRoot, '.ai/cezar');
    process.env.CEZ_HOME = home;
    git('init', '--quiet', '-b', 'main');
    git('config', 'user.name', 'Shadow Test');
    git('config', 'user.email', 'shadow@example.com');
    writeFileSync(join(repoRoot, 'a.txt'), 'a\n');
    git('add', 'a.txt');
    git('commit', '--quiet', '-m', 'init');
    git('remote', 'add', 'origin', 'https://github.com/acme/widget.git');
    store = RunStore.open(dataDir);
    manager = new RunManager(store, repoRoot);
    await registerProject(repoRoot);
  });

  afterEach(() => {
    store.flush();
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
  });

  const newRun = (shadow?: true) =>
    store.createRun({ title: 't', workflow: 'w', task: 't', steps: [{ id: 's', name: 's', kind: 'agent' }], ...(shadow ? { shadow } : {}) });

  it('leaves an ordinary run exactly as it was: no shim on PATH, no git redirect, no shadow state', async () => {
    const run = newRun();
    const { env } = await seam().agentEnvForStep(run.id, 'claude');
    expect(env.CEZ_SHADOW).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(env.PATH).toBeUndefined(); // the per-run env never overrides PATH on its own
    expect(store.getRun(run.id)?.shadow).toBeUndefined();
  });

  it('arms a shadow run: the shim leads PATH, pushes are redirected, and the transcript says so once', async () => {
    const run = newRun(true);
    const { env } = await seam().agentEnvForStep(run.id, 'claude');
    await seam().agentEnvForStep(run.id, 'claude'); // a Continue re-arms, and is not announced again

    expect(env.CEZ_SHADOW).toBe('1');
    expect(env.PATH?.startsWith(shadowPaths(shadowDir(dataDir, run.id)).bin)).toBe(true);
    expect(Number(env.GIT_CONFIG_COUNT)).toBeGreaterThan(0);
    const pushUrl = execFileSync('git', ['remote', 'get-url', '--push', 'origin'], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
    expect(pushUrl.replace(/\\/g, '/')).toContain(`/shadow/${run.id}/remotes/`);
    const announced = store.readEvents(run.id).filter((event) => String(event.message ?? '').startsWith('shadow mode armed'));
    expect(announced).toHaveLength(1);
  });

  it('withholds tracker credentials: a Jira or Linear write would leave through a door the shim does not watch', async () => {
    manager = new RunManager(store, repoRoot, {
      resolveTrackerEnv: async () => {
        throw new Error('a shadow run must not resolve tracker credentials');
      },
    });
    const run = newRun(true);
    const association = { kind: 'jira' as const, source: { id: 'source', webUrl: 'https://example.com' }, externalId: 'SAM', externalName: 'Sam' };
    store.updateRun(run.id, {
      automationTracker: { automationId: 'a', automationRevision: 1, receiptId: 'r', provider: 'jira', key: 'SAM-1', url: 'https://example.com', association },
    });
    const { env } = await seam().agentEnvForStep(run.id, 'claude');
    expect(env.CEZ_SHADOW).toBe('1');
    expect(env.JIRA_API_TOKEN).toBeUndefined();
  });

  it('fails closed: a shadow run whose redirect cannot be proven never gets an environment', async () => {
    git('remote', 'set-url', '--push', 'origin', 'https://github.com/acme/widget.git');
    const run = newRun(true);
    await expect(seam().agentEnvForStep(run.id, 'claude')).rejects.toBeInstanceOf(ShadowSetupError);
  });
});
