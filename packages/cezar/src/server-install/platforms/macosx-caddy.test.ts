import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  caddyfile,
  caddyfilePath,
  caddyPlist,
  macosxCaddy,
  needsRoot,
  probeArgs,
  probeUrl,
  siteAddress,
  siteUrl,
  type CaddySite,
} from './macosx-caddy.ts';
import { availablePlatformIds, getStrategy } from '../strategies.ts';
import { runInstall, runUninstall } from '../engine.ts';
import { loadServerState } from '../state.ts';
import { createAutoUi } from '../ui.ts';
import type { Runner } from '../types.ts';

const okRunner: Runner = { capture: async () => ({ code: 0, stdout: '', stderr: '' }), interactive: async () => 0 };

const site = (over: Partial<CaddySite> = {}): CaddySite => ({
  exposure: 'internal',
  host: 'studio.local',
  port: 8443,
  user: 'ops',
  hash: '$2a$14$abc',
  upstream: '127.0.0.1:4321',
  ...over,
});

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

function identityStepOf(ctx: Parameters<typeof macosxCaddy.steps>[0]) {
  const s = macosxCaddy.steps(ctx).find((x) => x.id === 'identity');
  if (!s) throw new Error('no identity step');
  return s;
}

/** A ledger entry shaped exactly as the caddy step records one. */
function recorded(exposure: string, host: string, port: number) {
  return {
    caddy: {
      status: 'done',
      created: { artifacts: [{ kind: 'owned', type: 'caddy-site', name: `${host}|${port}`, scope: exposure }] },
    },
  };
}

describe('macosx-caddy', () => {
  let home: string;
  const original = process.env.CEZ_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-mac-caddy-'));
    process.env.CEZ_HOME = home;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = original;
    rmSync(home, { recursive: true, force: true });
  });

  it('is registered alongside the other platforms', () => {
    expect(getStrategy('macosx-caddy')?.id).toBe('macosx-caddy');
    expect(availablePlatformIds()).toContain('macosx-caddy');
  });

  it('runs the front as its own step, after the cockpit service', () => {
    expect(macosxCaddy.steps(ctxFor(okRunner)).map((s) => s.id)).toEqual(['deps', 'autostart', 'caddy', 'identity']);
  });

  it('the internal-CA site carries the login, the local cert and an SSE-safe proxy', () => {
    const f = caddyfile(site());
    expect(f).toContain('https://studio.local:8443 {');
    expect(f).toContain('basic_auth {');
    expect(f).toContain('ops $2a$14$abc');
    expect(f).toContain('tls internal');
    expect(f).toContain('reverse_proxy 127.0.0.1:4321');
    expect(f).toContain('flush_interval -1');
    // The local admin API can reconfigure the front without authentication.
    expect(f).toContain('admin off');
  });

  it('a public domain gets automatic HTTPS (no `tls internal`), plain HTTP matches any Host', () => {
    const acme = caddyfile(site({ exposure: 'acme', host: 'cezar.example.com', port: 443 }));
    expect(acme).toContain('cezar.example.com {');
    expect(acme).not.toContain('tls internal');
    expect(acme).toContain('basic_auth {'); // the login is local in every exposure

    const plain = caddyfile(site({ exposure: 'http', port: 8080 }));
    // Port-only address: a tunnel forwarding some other Host still matches.
    expect(plain).toContain('http://:8080 {');
    expect(plain).not.toContain('tls internal');
    expect(plain).toContain('basic_auth {');
  });

  it('site address and URL differ per exposure', () => {
    expect(siteAddress(site())).toBe('https://studio.local:8443');
    expect(siteUrl(site())).toBe('https://studio.local:8443');
    expect(siteAddress(site({ exposure: 'acme', host: 'a.example.com', port: 443 }))).toBe('a.example.com');
    expect(siteUrl(site({ exposure: 'acme', host: 'a.example.com', port: 443 }))).toBe('https://a.example.com');
    expect(siteAddress(site({ exposure: 'http', port: 8080 }))).toBe('http://:8080');
  });

  it('a privileged port needs the root daemon; anything else is a user agent', () => {
    expect(needsRoot(443)).toBe(true);
    expect(needsRoot(80)).toBe(true);
    expect(needsRoot(1024)).toBe(false);
    expect(needsRoot(8443)).toBe(false);
  });

  it('the plist runs caddy against the config, logs it, and gives the root job a HOME', () => {
    const user = caddyPlist('/opt/homebrew/bin/caddy', '/home/.cezar/Caddyfile', false);
    expect(user).toContain('<string>/opt/homebrew/bin/caddy</string>');
    expect(user).toContain('<string>run</string>');
    expect(user).toContain('<string>/home/.cezar/Caddyfile</string>');
    expect(user).toContain('<string>caddyfile</string>');
    expect(user).toContain('<key>StandardErrorPath</key>');
    expect(user).toContain('<key>KeepAlive</key>');
    // A user agent inherits the operator's HOME already.
    expect(user).not.toContain('<key>HOME</key>');

    const root = caddyPlist('/opt/homebrew/bin/caddy', '/home/.cezar/Caddyfile', true);
    // Caddy resolves its certificate storage from HOME; a LaunchDaemon has none.
    expect(root).toContain('<key>HOME</key>');
    expect(root).toContain('<string>/var/root</string>');
    expect(root).toContain('<string>/var/log/cezar-caddy.log</string>');
  });

  it('probes pin the hostname at this Mac (and accept the local CA)', () => {
    expect(probeArgs(site())).toEqual(['-k', '--resolve', 'studio.local:8443:127.0.0.1']);
    expect(probeUrl(site())).toBe('https://studio.local:8443');
    expect(probeArgs(site({ exposure: 'acme', host: 'a.example.com', port: 443 }))).toEqual([
      '-k',
      '--resolve',
      'a.example.com:443:127.0.0.1',
    ]);
    // Plain HTTP matches any Host, so the probe just dials loopback.
    expect(probeArgs(site({ exposure: 'http', port: 8080 }))).toEqual([]);
    expect(probeUrl(site({ exposure: 'http', port: 8080 }))).toBe('http://127.0.0.1:8080/');
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
    const res = await runInstall(macosxCaddy, run);
    expect(res.status).toBe('complete');
    const state = loadServerState();
    expect(state.platform).toBe('macosx-caddy');
    expect(state.steps.caddy?.status).toBe('done');
    expect(state.steps.identity?.status).toBe('done');
    // A dry run must not leave a real Caddyfile behind.
    expect(existsSync(caddyfilePath())).toBe(false);

    const undone = await runUninstall(macosxCaddy, run);
    expect(undone.status).toBe('complete');
    expect(loadServerState().steps).toEqual({});
  });

  it('identity aborts when the cockpit itself is not listening', async () => {
    const runner: Runner = {
      capture: async (p) => (p === 'curl' ? { code: 7, stdout: '000', stderr: '' } : { code: 0, stdout: '', stderr: '' }),
      interactive: async () => 0,
    };
    const ctx = ctxFor(runner);
    await expect(identityStepOf(ctx).run(ctx)).rejects.toThrow(/verification failed/);
  });

  it('identity aborts when Caddy does not challenge an anonymous request', async () => {
    // The cockpit answers, but the front returns 200 without asking for a login.
    const runner: Runner = {
      capture: async (p) => (p === 'curl' ? { code: 0, stdout: '200', stderr: '' } : { code: 0, stdout: '', stderr: '' }),
      interactive: async () => 0,
    };
    const ctx = ctxFor(runner, {
      state: { schema: 1, installed: false, primaryPort: 4321, steps: recorded('internal', 'studio.local', 8443) },
    });
    await expect(identityStepOf(ctx).run(ctx)).rejects.toThrow(/verification failed/);
  });

  it('identity passes when anonymous is challenged and the credentials get through', async () => {
    const seen: string[][] = [];
    const runner: Runner = {
      capture: async (p, args) => {
        if (p !== 'curl') return { code: 0, stdout: '', stderr: '' };
        seen.push(args);
        if (args.some((a) => a.includes('/api/v1/health'))) return { code: 0, stdout: '200', stderr: '' };
        // The authenticated probe is the one reading curl's config from stdin.
        return args.includes('-K') ? { code: 0, stdout: '200', stderr: '' } : { code: 0, stdout: '401', stderr: '' };
      },
      interactive: async () => 0,
    };
    const ctx = ctxFor(runner, {
      state: { schema: 1, installed: false, primaryPort: 4321, steps: recorded('internal', 'studio.local', 8443) },
      prefs: { cockpit: { user: 'ops', password: 'hunter2' } },
    });
    await expect(identityStepOf(ctx).run(ctx)).resolves.toEqual({ artifacts: [] });
    // The password must never ride in argv, where `ps` would read it.
    expect(seen.flat().join(' ')).not.toContain('hunter2');
    expect(seen.some((a) => a.includes('--resolve'))).toBe(true);
  });

  it('identity warns instead of failing when the ledger has no recorded site', async () => {
    const runner: Runner = {
      capture: async (p) => (p === 'curl' ? { code: 0, stdout: '200', stderr: '' } : { code: 0, stdout: '', stderr: '' }),
      interactive: async () => 0,
    };
    const ctx = ctxFor(runner); // no steps.caddy record
    await expect(identityStepOf(ctx).run(ctx)).resolves.toEqual({ artifacts: [] });
  });

  it('the Caddyfile is written 0600 with the hash, never the password', async () => {
    // Exercise the real write path through the step, with every command faked.
    // HOME points at the temp dir too, so the launchd plist lands there.
    const realHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const runner: Runner = {
        capture: async (p, args) => {
          if (p === 'bash') return { code: 0, stdout: '/opt/homebrew/bin/caddy', stderr: '' };
          if (p === 'scutil') return { code: 0, stdout: 'studio', stderr: '' };
          if (p.endsWith('caddy') && args[0] === 'hash-password') return { code: 0, stdout: '$2a$14$hashhash\n', stderr: '' };
          return { code: 0, stdout: '', stderr: '' };
        },
        interactive: async () => 0,
      };
      const ui = createAutoUi({
        'Cockpit login username (Basic-Auth — you type this in the browser)': 'ops',
        'Set the cockpit password for "ops"': 'hunter2!',
      });
      const ctx = ctxFor(runner, { ui, assumeYes: true, prefs: {} });
      const step = macosxCaddy.steps(ctx).find((s) => s.id === 'caddy');
      if (!step) throw new Error('no caddy step');
      const created = await step.run(ctx);

      const written = readFileSync(caddyfilePath(), 'utf8');
      expect(written).toContain('ops $2a$14$hashhash');
      // The default exposure needs no public DNS and no root.
      expect(written).toContain('https://studio.local:8443');
      expect(written).toContain('tls internal');
      // The plaintext lives in memory for the identity probe only.
      expect(written).not.toContain('hunter2!');
      expect(statSync(caddyfilePath()).mode & 0o777).toBe(0o600);

      expect(created?.artifacts.some((a) => a.type === 'caddy-site' && a.scope === 'internal')).toBe(true);
      // A non-privileged port stays a user agent — no sudo anywhere in this run.
      expect(created?.artifacts.some((a) => a.type === 'launchd' && a.scope === 'user')).toBe(true);
      expect(existsSync(join(home, 'Library', 'LaunchAgents', 'ai.cezar.caddy.plist'))).toBe(true);
    } finally {
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
    }
  });
});
