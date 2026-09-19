import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDeploy, runInstall, runUninstall, type RunOptions } from './engine.ts';
import { loadServerState } from './state.ts';
import { StepAborted } from './steps.ts';
import { createAutoUi } from './ui.ts';
import type { InstallStep, PlatformStrategy, Runner } from './types.ts';
import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';

const noRunner: Runner = { capture: async () => ({ code: 0, stdout: '', stderr: '' }), interactive: async () => 0 };

function opts(over: Partial<RunOptions> = {}): RunOptions {
  return {
    dryRun: false,
    assumeYes: true,
    reconfigure: new Set(),
    repoRoot: '/repo',
    now: '2026-07-16T00:00:00.000Z',
    ui: createAutoUi(),
    runner: noRunner,
    ...over,
  };
}

/** A step whose run/undo/check are spies. */
function fakeStep(id: string, over: Partial<InstallStep> = {}): InstallStep {
  return {
    id,
    title: id,
    check: vi.fn(async () => false),
    run: vi.fn(async () => ({ artifacts: [{ kind: 'owned' as const, type: 'file', path: `/etc/${id}` }] })),
    undo: vi.fn(async () => {}),
    ...over,
  };
}

function strategyOf(steps: InstallStep[], redeploy?: PlatformStrategy['redeploy']): PlatformStrategy {
  return { id: 'ubuntu-vps', label: 'Ubuntu VPS', preflight: async () => {}, steps: () => steps, redeploy };
}

describe('engine', () => {
  let home: string;
  const original = process.env.CEZ_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-engine-'));
    process.env.CEZ_HOME = home;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = original;
    rmSync(home, { recursive: true, force: true });
  });

  it('runs all steps and flips installed=true', async () => {
    const a = fakeStep('a');
    const b = fakeStep('b');
    const res = await runInstall(strategyOf([a, b]), opts());
    expect(res.status).toBe('complete');
    expect(res.state.installed).toBe(true);
    expect(a.run).toHaveBeenCalledOnce();
    expect(loadServerState().steps.a?.status).toBe('done');
  });

  it('resume skips already-done steps', async () => {
    const a = fakeStep('a');
    await runInstall(strategyOf([a]), opts());
    const a2 = fakeStep('a');
    await runInstall(strategyOf([a2]), opts());
    expect(a2.run).not.toHaveBeenCalled(); // resolved from state → skipped
  });

  it('a flag-less resume preserves the recorded external-proxy mode', async () => {
    const externalStep = fakeStep('external');
    const managedProxyStep = fakeStep('managed-proxy');
    const strategy: PlatformStrategy = {
      id: 'ubuntu-vps',
      label: 'Ubuntu VPS',
      preflight: async () => {},
      steps: (ctx) => (ctx.state.externalProxy ? [externalStep] : [managedProxyStep]),
    };

    await runInstall(strategy, opts({ externalProxy: true }));
    expect(loadServerState().externalProxy).toBe(true);

    await runInstall(strategy, opts({ externalProxy: undefined }));
    expect(loadServerState().externalProxy).toBe(true);
    expect(managedProxyStep.run).not.toHaveBeenCalled();
  });

  it('--reconfigure re-runs a named done step', async () => {
    const a = fakeStep('a');
    await runInstall(strategyOf([a]), opts());
    const a2 = fakeStep('a');
    await runInstall(strategyOf([a2]), opts({ reconfigure: new Set(['a']) }));
    expect(a2.run).toHaveBeenCalledOnce();
  });

  it('--reinstall re-runs every step even when all are already done', async () => {
    const a = fakeStep('a');
    const b = fakeStep('b');
    await runInstall(strategyOf([a, b]), opts());
    const a2 = fakeStep('a');
    const b2 = fakeStep('b');
    const res = await runInstall(strategyOf([a2, b2]), opts({ reinstall: true }));
    expect(res.status).toBe('complete');
    expect(a2.run).toHaveBeenCalledOnce();
    expect(b2.run).toHaveBeenCalledOnce();
    // check() is bypassed for forced steps, so a "present" probe can't skip them
    expect(a2.check).not.toHaveBeenCalled();
  });

  it('a failing (aborted) required step stops with state intact, installed stays false', async () => {
    const a = fakeStep('a', { run: vi.fn(async () => { throw new StepAborted('nope'); }) });
    const b = fakeStep('b');
    const res = await runInstall(strategyOf([a, b]), opts());
    expect(res.status).toBe('failed');
    expect(res.state.installed).toBe(false);
    expect(b.run).not.toHaveBeenCalled();
    expect(loadServerState().steps.a?.status).toBe('failed');
  });

  it('runDeploy invokes the strategy redeploy and completes', async () => {
    await runInstall(strategyOf([fakeStep('a')]), opts()); // deploy needs a completed install
    const redeploy = vi.fn(async () => {});
    const res = await runDeploy(strategyOf([fakeStep('a')], redeploy), opts());
    expect(res.status).toBe('complete');
    expect(redeploy).toHaveBeenCalledOnce();
  });

  it('runDeploy fails cleanly when nothing is installed (no redeploy attempt)', async () => {
    const redeploy = vi.fn(async () => {});
    const res = await runDeploy(strategyOf([fakeStep('a')], redeploy), opts());
    expect(res.status).toBe('failed');
    expect(redeploy).not.toHaveBeenCalled();
  });

  it('runDeploy fails (not throws) when the strategy has no redeploy', async () => {
    await runInstall(strategyOf([fakeStep('a')]), opts());
    const res = await runDeploy(strategyOf([fakeStep('a')]), opts());
    expect(res.status).toBe('failed');
  });

  it('runDeploy reports failed when redeploy aborts (e.g. verify fails)', async () => {
    await runInstall(strategyOf([fakeStep('a')]), opts());
    const redeploy = vi.fn(async () => { throw new StepAborted('cockpit down'); });
    const res = await runDeploy(strategyOf([fakeStep('a')], redeploy), opts());
    expect(res.status).toBe('failed');
  });

  it('install-then-uninstall calls each undo with its recorded created and empties state', async () => {
    const a = fakeStep('a');
    const b = fakeStep('b');
    await runInstall(strategyOf([a, b]), opts());
    const a2 = fakeStep('a');
    const b2 = fakeStep('b');
    const res = await runUninstall(strategyOf([a2, b2]), opts());
    expect(res.status).toBe('complete');
    // reverse order: b undone before a
    expect(b2.undo).toHaveBeenCalledWith(expect.anything(), { artifacts: [{ kind: 'owned', type: 'file', path: '/etc/b' }] });
    expect(a2.undo).toHaveBeenCalledOnce();
    const after = loadServerState();
    expect(after.steps).toEqual({});
    expect(after.installed).toBe(false);
    // platform is cleared so the host can be re-installed with any platform
    expect(after.platform).toBeUndefined();
  });

  it('warns and cancels before uninstalling a server that serves registered projects', async () => {
    await mergeWriteWorkspaceConfig((config) => {
      config.projects = [
        {
          id: 'api',
          root: '/srv/api',
          name: 'API',
          addedAt: '2026-07-20T00:00:00.000Z',
          lastOpenedAt: '2026-07-20T00:00:00.000Z',
          source: 'local',
        },
        {
          id: 'web',
          root: '/srv/web',
          name: 'Web',
          addedAt: '2026-07-20T00:00:00.000Z',
          lastOpenedAt: '2026-07-20T00:00:00.000Z',
          source: 'local',
        },
      ];
    });
    await runInstall(strategyOf([fakeStep('a')]), opts());
    const undo = fakeStep('a');
    const warn = vi.fn();
    const ui = { ...createAutoUi(), warn, confirm: vi.fn(async () => false) };

    const res = await runUninstall(strategyOf([undo]), opts({ ui, assumeYes: false }));

    expect(res.status).toBe('cancelled');
    expect(undo.undo).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('2 projects are registered in ~/.cezar/config.json.');
  });

  it('after a full uninstall the host can be installed with a different platform', async () => {
    await runInstall(strategyOf([fakeStep('a')]), opts()); // records platform ubuntu-vps
    await runUninstall(strategyOf([fakeStep('a')]), opts());
    // a strategy with a different id must not trip the "already has X install" guard
    const other: PlatformStrategy = { id: 'macosx-ngrok', label: 'mac', preflight: async () => {}, steps: () => [fakeStep('m')] };
    const res = await runInstall(other, opts());
    expect(res.status).toBe('complete');
    expect(res.state.platform).toBe('macosx-ngrok');
  });

  it('optional step declined at the confirm prompt is skipped and does not block installed=true', async () => {
    const a = fakeStep('a');
    const opt = fakeStep('opt', { optional: true });
    const ui = { ...createAutoUi(), confirm: async () => false };
    const res = await runInstall(strategyOf([a, opt]), opts({ ui, assumeYes: false }));
    expect(opt.run).not.toHaveBeenCalled();
    expect(res.state.steps.opt?.status).toBe('skipped');
    expect(res.state.installed).toBe(true); // optional skip doesn't block
  });

  it('two instances install to separate records that do not resume each other', async () => {
    // default install
    await runInstall(strategyOf([fakeStep('a')]), opts());
    // a second install for a different domain, keyed by its slug + its own port
    const b = fakeStep('a');
    const res = await runInstall(
      strategyOf([b]),
      opts({ instance: 'shop-example-com', domain: 'shop.example.com', port: 4322 }),
    );
    expect(res.status).toBe('complete');
    // the second run actually RAN its step — it did NOT report "already done"
    // from the default record (the "asks me to reinstall" bug being fixed)
    expect(b.run).toHaveBeenCalledOnce();
    expect(loadServerState('shop-example-com').domain).toBe('shop.example.com');
    expect(loadServerState('shop-example-com').primaryPort).toBe(4322);
    expect(loadServerState('shop-example-com').instance).toBe('shop-example-com');
    // the default record is untouched (still port 4321, no domain)
    expect(loadServerState().primaryPort).toBe(4321);
    expect(loadServerState().domain).toBeUndefined();
  });

  it('a named instance uninstall removes its record; a default uninstall keeps the file', async () => {
    await runInstall(strategyOf([fakeStep('a')]), opts({ instance: 'shop-example-com', domain: 'shop.example.com', port: 4322 }));
    const res = await runUninstall(strategyOf([fakeStep('a')]), opts({ instance: 'shop-example-com' }));
    expect(res.status).toBe('complete');
    // the named record file is gone → it no longer reserves a port or lists
    const { listServerInstances } = await import('./state.ts');
    expect(listServerInstances().some((i) => i.instance === 'shop-example-com')).toBe(false);
  });

  it('--yes skips optional steps rather than running them non-interactively', async () => {
    const a = fakeStep('a');
    const opt = fakeStep('opt', { optional: true });
    // confirm would return true, but --yes must not even ask for an optional step.
    const confirm = vi.fn(async () => true);
    const ui = { ...createAutoUi(), confirm };
    const res = await runInstall(strategyOf([a, opt]), opts({ ui, assumeYes: true }));
    expect(confirm).not.toHaveBeenCalled();
    expect(opt.run).not.toHaveBeenCalled();
    expect(res.state.steps.opt?.status).toBe('skipped');
    expect(res.state.installed).toBe(true);
  });
});

describe('engine — ledger preservation and uninstall safety (PR #423 review fixes)', () => {
  let home: string;
  const original = process.env.CEZ_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-engine-'));
    process.env.CEZ_HOME = home;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = original;
    rmSync(home, { recursive: true, force: true });
  });

  it('a cancelled --reconfigure re-run keeps the previously recorded artifacts', async () => {
    const a = fakeStep('a');
    await runInstall(strategyOf([a]), opts());
    expect(loadServerState().steps.a?.created?.artifacts).toHaveLength(1);
    const a2 = fakeStep('a', {
      run: vi.fn(async () => {
        const { StepCancelled } = await import('./steps.ts');
        throw new StepCancelled();
      }),
    });
    const res = await runInstall(strategyOf([a2]), opts({ reconfigure: new Set(['a']) }));
    expect(res.status).toBe('cancelled');
    const after = loadServerState().steps.a;
    expect(after?.status).toBe('pending');
    expect(after?.created?.artifacts).toHaveLength(1); // ledger survives the cancel
  });

  it('a failed re-run keeps the ledger and uninstall still reverses it', async () => {
    const a = fakeStep('a');
    await runInstall(strategyOf([a]), opts());
    const aFail = fakeStep('a', { run: vi.fn(async () => { throw new StepAborted('boom'); }) });
    await runInstall(strategyOf([aFail]), opts({ reinstall: true }));
    expect(loadServerState().steps.a?.created?.artifacts).toHaveLength(1);
    const aUndo = fakeStep('a');
    const res = await runUninstall(strategyOf([aUndo]), opts());
    expect(res.status).toBe('complete');
    expect(aUndo.undo).toHaveBeenCalledOnce(); // failed outcomes are undone too
  });

  it('uninstall refuses a mismatched --platform and leaves the ledger intact', async () => {
    await runInstall(strategyOf([fakeStep('a')]), opts());
    const mac: PlatformStrategy = {
      id: 'macosx-ngrok',
      label: 'macOS + ngrok',
      preflight: async () => {},
      steps: () => [fakeStep('a')],
    };
    await expect(runUninstall(mac, opts())).rejects.toThrow(/ubuntu-vps/);
    expect(loadServerState().steps.a?.status).toBe('done');
  });

  it('uninstall keeps (and reports) records for step ids this binary does not know', async () => {
    await runInstall(strategyOf([fakeStep('a'), fakeStep('future-step')]), opts());
    // an older binary that only knows step "a"
    const res = await runUninstall(strategyOf([fakeStep('a')]), opts());
    expect(res.status).toBe('failed'); // not "complete" — something was left behind
    const state = loadServerState();
    expect(state.steps['future-step']?.status).toBe('done'); // ledger preserved
    expect(state.platform).toBe('ubuntu-vps'); // still claims the host
  });

  it('unknown --reconfigure ids fail fast instead of silently no-opping', async () => {
    await runInstall(strategyOf([fakeStep('a')]), opts());
    await expect(
      runInstall(strategyOf([fakeStep('a')]), opts({ reconfigure: new Set(['htpasswd']) })),
    ).rejects.toThrow(/unknown --reconfigure step id.*htpasswd.*valid ids/s);
  });

  it('a dry-run NEVER persists over a real install record (preview cannot poison the ledger)', async () => {
    await runInstall(strategyOf([fakeStep('a')]), opts()); // real install
    const before = JSON.stringify(loadServerState());
    // preview install AND preview uninstall on top of the real record
    const resI = await runInstall(strategyOf([fakeStep('a')]), opts({ dryRun: true }));
    expect(resI.status).toBe('complete');
    const resU = await runUninstall(strategyOf([fakeStep('a')]), opts({ dryRun: true }));
    expect(resU.status).toBe('complete');
    // the on-disk ledger is byte-identical: no dryRun stamp, no deleted steps
    expect(JSON.stringify(loadServerState())).toBe(before);
    expect(loadServerState().dryRun).toBeUndefined();
    expect(loadServerState().steps.a?.status).toBe('done');
  });

  it('a dry-run preview of platform A does not block a real install of platform B', async () => {
    await runInstall(strategyOf([fakeStep('a')]), opts({ dryRun: true })); // ubuntu-vps preview
    expect(loadServerState().dryRun).toBe(true);
    const mac: PlatformStrategy = {
      id: 'macosx-ngrok',
      label: 'macOS + ngrok',
      preflight: async () => {},
      steps: () => [fakeStep('m')],
    };
    const res = await runInstall(mac, opts());
    expect(res.status).toBe('complete');
    expect(res.state.platform).toBe('macosx-ngrok');
  });

  it('a real install does not resume from a CEZ_DRY_RUN preview record', async () => {
    const dry = fakeStep('a');
    await runInstall(strategyOf([dry]), opts({ dryRun: true }));
    expect(loadServerState().dryRun).toBe(true);
    const real = fakeStep('a');
    const res = await runInstall(strategyOf([real]), opts());
    expect(real.run).toHaveBeenCalledOnce(); // did NOT report "already done"
    expect(res.state.installed).toBe(true);
    expect(loadServerState().dryRun).toBeUndefined();
  });
});
