import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { macosxExternalProxy } from './macosx-external-proxy.ts';
import { cezarLaunchdPlist } from './macosx-shared.ts';
import { availablePlatformIds, getStrategy } from '../strategies.ts';
import { runInstall, runUninstall } from '../engine.ts';
import { loadServerState } from '../state.ts';
import { createAutoUi } from '../ui.ts';
import type { Runner } from '../types.ts';

const okRunner: Runner = { capture: async () => ({ code: 0, stdout: '', stderr: '' }), interactive: async () => 0 };

function ctxFor(runner: Runner, over: Record<string, unknown> = {}) {
  return {
    state: { schema: 1, installed: false, primaryPort: 4321, steps: {} },
    ui: createAutoUi(),
    runner,
    save: async () => {},
    dryRun: false,
    assumeYes: true,
    reconfigure: new Set<string>(),
    repoRoot: '/repo',
    now: '2026-09-01T00:00:00.000Z',
    prefs: {},
    ...over,
  } as never;
}

function identityStepOf(ctx: Parameters<typeof macosxExternalProxy.steps>[0]) {
  const s = macosxExternalProxy.steps(ctx).find((x) => x.id === 'identity');
  if (!s) throw new Error('no identity step');
  return s;
}

describe('macosx-external-proxy', () => {
  let home: string;
  const original = process.env.CEZ_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-mac-ext-'));
    process.env.CEZ_HOME = home;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = original;
    rmSync(home, { recursive: true, force: true });
  });

  it('is registered', () => {
    expect(getStrategy('macosx-external-proxy')?.id).toBe('macosx-external-proxy');
    expect(availablePlatformIds()).toContain('macosx-external-proxy');
  });

  it('installs the service only — no proxy step of its own', () => {
    const ids = macosxExternalProxy.steps(ctxFor(okRunner)).map((s) => s.id);
    expect(ids).toEqual(['deps', 'autostart', 'identity']);
  });

  it('preflight records external-proxy mode (a flag-less resume stays external)', async () => {
    const ctx = ctxFor(okRunner, { dryRun: true }); // dry-run skips the uname probe
    await macosxExternalProxy.preflight(ctx);
    expect((ctx as unknown as { state: { externalProxy?: boolean } }).state.externalProxy).toBe(true);
  });

  it('the cezar plist binds the given host only when one is set', () => {
    const plain = cezarLaunchdPlist('/repo', 4321, ['/usr/local/bin/node', '/app/dist/index.js']);
    expect(plain).not.toContain('--bind-host');
    const bound = cezarLaunchdPlist('/repo', 4321, ['/usr/local/bin/node', '/app/dist/index.js'], { bindHost: '172.17.0.1' });
    expect(bound).toContain('<string>--bind-host</string>');
    expect(bound).toContain('<string>172.17.0.1</string>');
    // Loopback is the flag-less default — an explicit 127.0.0.1 stays byte-identical.
    expect(cezarLaunchdPlist('/repo', 4321, ['/usr/local/bin/node', '/app/dist/index.js'], { bindHost: '127.0.0.1' })).not.toContain('--bind-host');
  });

  it('dry-run install walks every step and server-uninstall reverses it', async () => {
    const run = {
      dryRun: true,
      assumeYes: true,
      reconfigure: new Set<string>(),
      repoRoot: '/repo',
      now: '2026-09-01T00:00:00.000Z',
      ui: createAutoUi(),
      runner: okRunner,
    };
    const res = await runInstall(macosxExternalProxy, run);
    expect(res.status).toBe('complete');
    const state = loadServerState();
    expect(state.platform).toBe('macosx-external-proxy');
    expect(state.externalProxy).toBe(true);
    expect(state.steps.autostart?.status).toBe('done');
    expect(state.steps.identity?.status).toBe('done');

    const undone = await runUninstall(macosxExternalProxy, run);
    expect(undone.status).toBe('complete');
    expect(loadServerState().steps).toEqual({});
  });

  it('identity passes when cezar answers on the bound host', async () => {
    const runner: Runner = {
      capture: async (p) => (p === 'curl' ? { code: 0, stdout: '200', stderr: '' } : { code: 0, stdout: '', stderr: '' }),
      interactive: async () => 0,
    };
    const ctx = ctxFor(runner, { state: { schema: 1, installed: false, primaryPort: 4321, steps: {}, externalProxy: true, bindHost: '172.17.0.1' } });
    await expect(identityStepOf(ctx).run(ctx)).resolves.toEqual({ artifacts: [] });
  });

  it('identity aborts when nothing is listening', async () => {
    const runner: Runner = {
      capture: async (p) => (p === 'curl' ? { code: 7, stdout: '000', stderr: '' } : { code: 0, stdout: '', stderr: '' }),
      interactive: async () => 0,
    };
    const ctx = ctxFor(runner, { state: { schema: 1, installed: false, primaryPort: 4321, steps: {}, externalProxy: true } });
    await expect(identityStepOf(ctx).run(ctx)).rejects.toThrow(/verification failed/);
  });
});
