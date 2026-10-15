import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  backendRunning,
  dnsNameFromStatus,
  macosxTailscale,
  magicDnsSuffix,
  normalizeServiceName,
  offArgs,
  serveArgs,
} from './macosx-tailscale.ts';
import { availablePlatformIds, getStrategy } from '../strategies.ts';
import { runInstall, runUninstall } from '../engine.ts';
import { loadServerState } from '../state.ts';
import { createAutoUi } from '../ui.ts';
import type { Runner } from '../types.ts';

const STATUS = JSON.stringify({
  BackendState: 'Running',
  MagicDNSSuffix: 'tail1234.ts.net',
  Self: { DNSName: 'mac-mini.tail1234.ts.net.' },
});

/** A runner that answers `status --json` and reports everything else as fine. */
function tailscaleRunner(over: { serveCode?: number; calls?: string[][] } = {}): Runner {
  return {
    capture: async (program, args) => {
      over.calls?.push([program, ...args]);
      if (args[0] === 'status' && args[1] === '--json') return { code: 0, stdout: STATUS, stderr: '' };
      if (args.join(' ').includes('command -v tailscale')) return { code: 0, stdout: '/opt/homebrew/bin/tailscale', stderr: '' };
      // The health probe: any status but "000" means the cockpit answered.
      if (program === 'curl') return { code: 0, stdout: '200', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    interactive: async (program, args) => {
      over.calls?.push([program, ...args]);
      return args[0] === 'serve' || args[0] === 'funnel' ? (over.serveCode ?? 0) : 0;
    },
  };
}

function ctxFor(runner: Runner, over: Record<string, unknown> = {}, answers: Record<string, unknown> = {}) {
  return {
    state: { schema: 1, installed: false, primaryPort: 4321, steps: {} },
    ui: createAutoUi(answers),
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

function stepOf(id: string) {
  const s = macosxTailscale.steps({} as never).find((x) => x.id === id);
  if (!s) throw new Error(`no ${id} step`);
  return s;
}

const MODE_PROMPT = 'How should the cockpit be reachable?';

describe('macosx-tailscale', () => {
  let home: string;
  const original = process.env.CEZ_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-mac-ts-'));
    process.env.CEZ_HOME = home;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = original;
    rmSync(home, { recursive: true, force: true });
  });

  it('is registered alongside the other platforms', () => {
    expect(getStrategy('macosx-tailscale')?.id).toBe('macosx-tailscale');
    expect(availablePlatformIds()).toEqual([
      'ubuntu-vps',
      'macosx-ngrok',
      'macosx-cloudflare-tunnel',
      'macosx-tailscale',
      'macosx-caddy',
      'macosx-external-proxy',
    ]);
  });

  describe('status parsing', () => {
    it('reads the node name, the tailnet suffix and the backend state', () => {
      expect(dnsNameFromStatus(STATUS)).toBe('mac-mini.tail1234.ts.net');
      expect(magicDnsSuffix(STATUS)).toBe('tail1234.ts.net');
      expect(backendRunning(STATUS)).toBe(true);
    });

    it('falls back to the node name minus its first label when MagicDNSSuffix is absent', () => {
      expect(magicDnsSuffix(JSON.stringify({ Self: { DNSName: 'mac-mini.tail1234.ts.net.' } }))).toBe('tail1234.ts.net');
    });

    it('treats unparseable status as not-running rather than throwing', () => {
      expect(backendRunning('tailscaled not running')).toBe(false);
      expect(dnsNameFromStatus('')).toBeUndefined();
      expect(magicDnsSuffix('')).toBeUndefined();
    });
  });

  describe('argv', () => {
    it('serve and funnel go through --bg on :443', () => {
      expect(serveArgs('serve', 'http://127.0.0.1:4321')).toEqual(['serve', '--bg', '--https=443', 'http://127.0.0.1:4321']);
      expect(serveArgs('funnel', 'http://127.0.0.1:4321')).toEqual(['funnel', '--bg', '--https=443', 'http://127.0.0.1:4321']);
    });

    it('a service is served under --service, which is persistent config (no --bg)', () => {
      expect(serveArgs('service', 'http://127.0.0.1:4321', 'svc:cezar')).toEqual([
        'serve',
        '--service=svc:cezar',
        '--https=443',
        'http://127.0.0.1:4321',
      ]);
    });

    it('off repeats the original flags, as tailscale requires', () => {
      expect(offArgs('serve')).toEqual(['serve', '--https=443', 'off']);
      expect(offArgs('service', 'svc:cezar')).toEqual(['serve', '--service=svc:cezar', '--https=443', 'off']);
    });

    it('normalizes a service name to a single svc: prefix', () => {
      expect(normalizeServiceName('cezar')).toBe('svc:cezar');
      expect(normalizeServiceName(' svc:Cezar ')).toBe('svc:cezar');
    });
  });

  it('dry-run install walks every step and server-uninstall reverses it', async () => {
    const run = {
      dryRun: true,
      assumeYes: true,
      reconfigure: new Set<string>(),
      repoRoot: '/repo',
      now: '2026-09-01T00:00:00.000Z',
      ui: createAutoUi(),
      runner: tailscaleRunner(),
    };
    const res = await runInstall(macosxTailscale, run);
    expect(res.status).toBe('complete');
    const state = loadServerState();
    expect(state.platform).toBe('macosx-tailscale');
    expect(state.steps.autostart?.status).toBe('done');
    expect(state.steps.tailscale?.status).toBe('done');
    expect(state.steps.identity?.status).toBe('done');
    // Every Tailscale mode lands on a stable MagicDNS name.
    expect(state.ephemeral).toBe(false);
    expect(state.tailscaleMode).toBe('serve');

    const undone = await runUninstall(macosxTailscale, run);
    expect(undone.status).toBe('complete');
    expect(loadServerState().steps).toEqual({});
  });

  it('serve mode publishes the node name and records no launchd agent of its own', async () => {
    const calls: string[][] = [];
    const ctx = ctxFor(tailscaleRunner({ calls }));
    const created = await stepOf('tailscale').run(ctx);
    // Narrows the type AND fails with a reason: every case here expects a result.
    if (!created) throw new Error('the tailscale step produced no result');
    expect(calls).toContainEqual(['/opt/homebrew/bin/tailscale', 'serve', '--bg', '--https=443', 'http://127.0.0.1:4321']);
    expect((ctx as unknown as { state: { publicUrl?: string } }).state.publicUrl).toBe('https://mac-mini.tail1234.ts.net');
    const mapping = created.artifacts.find((a) => a.type === 'tailscale-serve');
    expect(mapping?.kind).toBe('owned');
    expect(mapping?.scope).toBe('serve');
    expect(created.artifacts.some((a) => a.type === 'launchd')).toBe(false);
  });

  it('service mode serves under svc: and publishes the service name, not the Mac\'s', async () => {
    const calls: string[][] = [];
    const ctx = ctxFor(tailscaleRunner({ calls }), {}, { [MODE_PROMPT]: 'service' });
    const created = await stepOf('tailscale').run(ctx);
    // Narrows the type AND fails with a reason: every case here expects a result.
    if (!created) throw new Error('the tailscale step produced no result');
    expect(calls).toContainEqual([
      '/opt/homebrew/bin/tailscale',
      'serve',
      '--service=svc:cezar',
      '--https=443',
      'http://127.0.0.1:4321',
    ]);
    const state = (ctx as unknown as { state: { publicUrl?: string; tailscaleMode?: string } }).state;
    expect(state.publicUrl).toBe('https://cezar.tail1234.ts.net');
    expect(state.tailscaleMode).toBe('service');
    expect(created.artifacts.find((a) => a.type === 'tailscale-serve')?.name).toBe('svc:cezar');
  });

  it('funnel mode is recorded as its own scope so undo withdraws the right mapping', async () => {
    const calls: string[][] = [];
    const ctx = ctxFor(tailscaleRunner({ calls }), {}, { [MODE_PROMPT]: 'funnel' });
    const created = await stepOf('tailscale').run(ctx);
    // Narrows the type AND fails with a reason: every case here expects a result.
    if (!created) throw new Error('the tailscale step produced no result');
    expect(calls).toContainEqual(['/opt/homebrew/bin/tailscale', 'funnel', '--bg', '--https=443', 'http://127.0.0.1:4321']);
    expect(created.artifacts.find((a) => a.type === 'tailscale-serve')?.scope).toBe('funnel');
  });

  it('a rejected serve fails the step instead of recording done', async () => {
    const ctx = ctxFor(tailscaleRunner({ serveCode: 1 }));
    await expect(stepOf('tailscale').run(ctx)).rejects.toThrow(/HTTPS certificates are not enabled/);
  });

  it('a service that will not serve names the tagged-host requirement', async () => {
    const ctx = ctxFor(tailscaleRunner({ serveCode: 1 }), {}, { [MODE_PROMPT]: 'service' });
    await expect(stepOf('tailscale').run(ctx)).rejects.toThrow(/must be tagged|advertise-tags/);
  });

  it('a Mac that is not logged into a tailnet aborts instead of serving into the void', async () => {
    const runner: Runner = {
      capture: async (_p, args) => {
        if (args[0] === 'status') return { code: 0, stdout: JSON.stringify({ BackendState: 'NeedsLogin' }), stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
      interactive: async () => 0,
    };
    await expect(stepOf('tailscale').run(ctxFor(runner))).rejects.toThrow(/still not running\/logged in/);
  });

  it('undo drains and withdraws a service, and never resets the whole serve config', async () => {
    const calls: string[][] = [];
    await stepOf('tailscale').undo(ctxFor(tailscaleRunner({ calls })), {
      artifacts: [{ kind: 'owned', type: 'tailscale-serve', name: 'svc:cezar', scope: 'service' }],
    });
    const ts = calls.filter((c) => c[0] === '/opt/homebrew/bin/tailscale').map((c) => c.slice(1));
    expect(ts).toContainEqual(['serve', 'drain', 'svc:cezar']);
    expect(ts).toContainEqual(['serve', '--service=svc:cezar', '--https=443', 'off']);
    expect(ts.some((c) => c[1] === 'reset')).toBe(false);
  });

  it('undo with created:null still withdraws both node-level mappings', async () => {
    const calls: string[][] = [];
    await stepOf('tailscale').undo(ctxFor(tailscaleRunner({ calls })), null);
    const ts = calls.filter((c) => c[0] === '/opt/homebrew/bin/tailscale').map((c) => c.slice(1));
    expect(ts).toContainEqual(['funnel', '--https=443', 'off']);
    expect(ts).toContainEqual(['serve', '--https=443', 'off']);
  });

  it('redeploy restarts the cockpit and re-advertises a drained service host', async () => {
    const calls: string[][] = [];
    const ctx = ctxFor(tailscaleRunner({ calls }), {
      state: {
        schema: 1,
        installed: true,
        primaryPort: 4321,
        tailscaleMode: 'service',
        publicUrl: 'https://cezar.tail1234.ts.net',
        steps: {
          tailscale: {
            status: 'done',
            created: { artifacts: [{ kind: 'owned', type: 'tailscale-serve', name: 'svc:cezar', scope: 'service' }] },
          },
        },
      },
    });
    await macosxTailscale.redeploy?.(ctx);
    expect(calls.some((c) => c[0] === 'launchctl' && c[1] === 'kickstart')).toBe(true);
    expect(calls).toContainEqual(['/opt/homebrew/bin/tailscale', 'serve', 'advertise', 'svc:cezar']);
  });
});
