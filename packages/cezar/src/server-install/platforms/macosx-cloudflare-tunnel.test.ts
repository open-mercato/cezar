import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloudflaredPlist, macosxCloudflareTunnel } from './macosx-cloudflare-tunnel.ts';
import { availablePlatformIds, getStrategy } from '../strategies.ts';
import { runInstall, runUninstall } from '../engine.ts';
import { loadServerState } from '../state.ts';
import { createAutoUi } from '../ui.ts';
import type { Runner } from '../types.ts';

const okRunner: Runner = { capture: async () => ({ code: 0, stdout: '', stderr: '' }), interactive: async () => 0 };

function ctxFor(runner: Runner, over: Record<string, unknown> = {}) {
  return {
    state: { schema: 1, installed: false, primaryPort: 4321, steps: {} },
    ui: {
      ...createAutoUi(),
      password: async (o: { message: string }) => (o.message.includes('tunnel token') ? 'SECRET-TUNNEL-TOKEN' : 'longenough'),
      text: async (o: { message: string }) => (o.message.includes('hostname') ? '' : 'ops'),
    },
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

function cloudflaredStepOf() {
  const s = macosxCloudflareTunnel.steps({} as never).find((x) => x.id === 'cloudflared');
  if (!s) throw new Error('no cloudflared step');
  return s;
}

describe('macosx-cloudflare-tunnel', () => {
  let home: string;
  const original = process.env.CEZ_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-mac-cf-'));
    process.env.CEZ_HOME = home;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = original;
    rmSync(home, { recursive: true, force: true });
  });

  it('is registered', () => {
    expect(getStrategy('macosx-cloudflare-tunnel')?.id).toBe('macosx-cloudflare-tunnel');
    expect(availablePlatformIds()).toContain('macosx-cloudflare-tunnel');
  });

  it('the plist carries the token in EnvironmentVariables, never in argv', () => {
    const p = cloudflaredPlist('SECRET-TUNNEL-TOKEN');
    expect(p).toContain('<string>ai.cezar.cloudflared</string>');
    expect(p).toContain('<key>TUNNEL_TOKEN</key>');
    expect(p).toContain('<string>SECRET-TUNNEL-TOKEN</string>');
    expect(p).toContain('<string>--no-autoupdate</string>');
    expect(p).toContain('<string>run</string>');
    // The secret must sit in the env dict, NOT in ProgramArguments (`ps`-visible).
    const argvSection = p.slice(p.indexOf('<array>'), p.indexOf('</array>'));
    expect(argvSection).not.toContain('SECRET-TUNNEL-TOKEN');
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
    const res = await runInstall(macosxCloudflareTunnel, run);
    expect(res.status).toBe('complete');
    const state = loadServerState();
    expect(state.platform).toBe('macosx-cloudflare-tunnel');
    expect(state.steps.autostart?.status).toBe('done');
    expect(state.steps.cloudflared?.status).toBe('done');
    expect(state.steps.identity?.status).toBe('done');
    expect(state.ephemeral).toBe(true); // no hostname given in dry-run
    const artifacts = state.steps.cloudflared?.created?.artifacts ?? [];
    expect(artifacts.find((a) => a.type === 'launchd')?.kind).toBe('owned');

    const undone = await runUninstall(macosxCloudflareTunnel, run);
    expect(undone.status).toBe('complete');
    expect(loadServerState().steps).toEqual({});
  });

  it('writes the token-bearing plist 0600', async () => {
    const runner: Runner = {
      capture: async (_p, args) => {
        if (args[0] === 'print' || args.join(' ').includes('command -v')) return { code: 0, stdout: '/opt/homebrew/bin/cloudflared', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
      interactive: async () => 0,
    };
    const oldHome = process.env.HOME;
    process.env.HOME = home; // node's os.homedir() honors $HOME on posix
    try {
      await cloudflaredStepOf().run(ctxFor(runner));
      const p = join(home, 'Library', 'LaunchAgents', 'ai.cezar.cloudflared.plist');
      expect(statSync(p).mode & 0o777).toBe(0o600);
      expect(readFileSync(p, 'utf8')).toContain('SECRET-TUNNEL-TOKEN'); // token lives here → hence 0600
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });

  it('a failed launchctl bootstrap fails the step instead of recording done', async () => {
    const runner: Runner = {
      capture: async (_p, args) => {
        if (args.join(' ').includes('command -v')) return { code: 0, stdout: '/opt/homebrew/bin/cloudflared', stderr: '' };
        if (args[0] === 'print') return { code: 113, stdout: '', stderr: '' }; // not loaded
        return { code: 0, stdout: '', stderr: '' };
      },
      interactive: async (_p, args) => (args[0] === 'bootstrap' ? 5 : 0),
    };
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      await expect(cloudflaredStepOf().run(ctxFor(runner))).rejects.toThrow(/launchctl could not load/);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });

  it('undo removes the agent from static label/path even with created:null', async () => {
    const commands: string[][] = [];
    const runner: Runner = {
      capture: async (_p, args) => {
        commands.push(args);
        return { code: 0, stdout: '', stderr: '' };
      },
      interactive: async () => 0,
    };
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      await cloudflaredStepOf().undo(ctxFor(runner), null);
      expect(commands.some((c) => c[0] === 'bootout' && (c[1] ?? '').includes('ai.cezar.cloudflared'))).toBe(true);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });
});
