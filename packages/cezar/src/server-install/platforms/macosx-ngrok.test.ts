import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectOwnerOnlyMode } from '../../private-mode.testkit.ts';
import { cezarLaunchdPlist, launchdPlist, macosxNgrok, macosxNgrokIdentityStep } from './macosx-ngrok.ts';
import { availablePlatformIds, getStrategy } from '../strategies.ts';
import { runInstall, runUninstall } from '../engine.ts';
import { loadServerState } from '../state.ts';
import { createAutoUi } from '../ui.ts';
import { StepAborted } from '../steps.ts';
import type { InstallContext, Runner, Ui } from '../types.ts';

const okRunner: Runner = { capture: async () => ({ code: 0, stdout: '', stderr: '' }), interactive: async () => 0 };

function redeployCtx(over: { runner?: Runner; ui?: Ui; dryRun?: boolean } = {}): InstallContext {
  return {
    state: { schema: 1, installed: true, primaryPort: 4321, steps: {} },
    ui: over.ui ?? createAutoUi(),
    instance: 'default',
    runner: over.runner ?? okRunner,
    save: async () => {},
    dryRun: over.dryRun ?? false,
    assumeYes: true,
    reconfigure: new Set(),
    repoRoot: '/repo',
    now: '2026-09-16T00:00:00.000Z',
    prefs: {},
  };
}

describe('macosx-ngrok', () => {
  let home: string;
  const original = process.env.CEZ_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-mac-'));
    process.env.CEZ_HOME = home;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = original;
    rmSync(home, { recursive: true, force: true });
  });

  it('is registered alongside ubuntu-vps', () => {
    expect(getStrategy('macosx-ngrok')?.id).toBe('macosx-ngrok');
    expect(availablePlatformIds()).toEqual(['ubuntu-vps', 'macosx-ngrok']);
  });

  it('launchdPlist embeds the port, basic-auth and reserved domain', () => {
    const p = launchdPlist(4321, 'ops:hunter2', 'cezar.ngrok.app');
    expect(p).toContain('<string>http</string>');
    expect(p).toContain('<string>4321</string>');
    expect(p).toContain('<string>ops:hunter2</string>');
    expect(p).toContain('<string>cezar.ngrok.app</string>');
    expect(p).toContain('<key>KeepAlive</key>');
  });

  it('cezar launchd plist has one PATH key and carries instance identity', () => {
    const plist = cezarLaunchdPlist('/repo', 4321, ['/usr/bin/node', '/repo/dist/index.js'], 'install-a');
    expect(plist.match(/<key>PATH<\/key>/g)).toHaveLength(1);
    expect(plist).toContain('<key>CEZ_INSTANCE_ID</key>');
    expect(plist).toContain('<string>install-a</string>');
  });

  it('cezarLaunchdPlist embeds the argv, port, workdir and env', () => {
    const p = cezarLaunchdPlist('/repo', 4321, ['/usr/local/bin/node', '/app/dist/index.js']);
    expect(p).toContain('<string>/usr/local/bin/node</string>');
    expect(p).toContain('<string>/app/dist/index.js</string>');
    expect(p).toContain('<string>serve</string>');
    expect(p).toContain('<string>--no-open</string>');
    expect(p).toContain('<string>4321</string>');
    expect(p).toContain('<string>/repo</string>');
    expect(p).toContain('<key>CEZ_REMOTE</key>');
    expect(p).toContain('<string>ai.cezar.cockpit</string>');
  });

  it('identity verification accepts a matching health identity and reports legacy payloads as inconclusive', async () => {
    const messages: string[] = [];
    const ctx = {
      state: { schema: 1, installed: false, primaryPort: 4321, steps: {}, instanceId: 'install-a' },
      instance: 'default', ui: { ...createAutoUi(), success: (m: string) => messages.push(m), warn: (m: string) => messages.push(m) },
      runner: { capture: async (_program: string, args: string[]) => ({
        code: 0,
        stdout: args.some((a) => a.includes('/api/tunnels')) ? '{"public_url":"https://x"}' : '{"instanceId":"install-a"}\n200',
        stderr: '',
      }), interactive: async () => 0 },
      save: async () => {}, dryRun: false, assumeYes: true, reconfigure: new Set<string>(), repoRoot: '/repo', now: '', prefs: {},
    } as never;
    await macosxNgrokIdentityStep.run(ctx);
    expect(messages.some((m) => m.includes('identity matches'))).toBe(true);
  });

  it('identity verification rejects a different local cockpit', async () => {
    const ctx = {
      state: { schema: 1, installed: false, primaryPort: 4321, steps: {}, instanceId: 'install-a' },
      instance: 'default', ui: createAutoUi(), runner: { capture: async (_program: string, args: string[]) => ({
        code: 0,
        stdout: args.some((a) => a.includes('/api/tunnels')) ? '{"public_url":"https://x"}' : '{"instanceId":"other"}\n200',
        stderr: '',
      }), interactive: async () => 0 },
      save: async () => {}, dryRun: false, assumeYes: true, reconfigure: new Set<string>(), repoRoot: '/repo', now: '', prefs: {},
    } as never;
    await expect(macosxNgrokIdentityStep.run(ctx)).rejects.toThrow(/serving another install/);
  });

  it('dry-run install walks every step and server-uninstall reverses it', async () => {
    // Leave the reserved domain blank to exercise the ephemeral-URL path.
    const ui = { ...createAutoUi(), text: async (o: { message: string; placeholder?: string }) => (o.message.includes('Reserved') ? '' : o.placeholder ?? 'ops') };
    const run = {
      dryRun: true,
      assumeYes: true,
      reconfigure: new Set<string>(),
      repoRoot: '/repo',
      now: '2026-07-16T00:00:00.000Z',
      ui,
      runner: okRunner,
    };
    const res = await runInstall(macosxNgrok, run);
    expect(res.status).toBe('complete');
    const state = loadServerState();
    expect(state.platform).toBe('macosx-ngrok');
    expect(state.steps.autostart?.status).toBe('done');
    expect(state.steps.ngrok?.status).toBe('done');
    expect(state.ephemeral).toBe(true); // no domain given → ephemeral URL
    const ngrokArtifacts = state.steps.ngrok?.created?.artifacts ?? [];
    expect(ngrokArtifacts.find((a) => a.type === 'launchd')?.kind).toBe('owned');
    expect(ngrokArtifacts.find((a) => a.type === 'ngrok-config')?.kind).toBe('shared');
    const autostartArtifacts = state.steps.autostart?.created?.artifacts ?? [];
    expect(autostartArtifacts.find((a) => a.type === 'launchd')?.kind).toBe('owned');

    const undone = await runUninstall(macosxNgrok, run);
    expect(undone.status).toBe('complete');
    expect(loadServerState().steps).toEqual({});
  });
});

describe('macosx-ngrok review fixes (PR #423)', () => {
  let home: string;
  const original = process.env.CEZ_HOME;
  const originalUserProfile = process.env.USERPROFILE;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-mac-fix-'));
    process.env.CEZ_HOME = home;
    // These steps write and remove `~/Library/LaunchAgents/*.plist` through `os.homedir()`. The
    // cases below redirect it with HOME, which Windows ignores — it reads USERPROFILE — so there
    // they wrote the plist into, and `undo` deleted it from, the developer's REAL home.
    if (process.platform === 'win32') process.env.USERPROFILE = home;
  });
  afterEach(() => {
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (original === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = original;
    rmSync(home, { recursive: true, force: true });
  });

  function ngrokStepOf() {
    const s = macosxNgrok.steps({} as never).find((x) => x.id === 'ngrok');
    if (!s) throw new Error('no ngrok step');
    return s;
  }

  function ctxFor(runner: Runner, over: Record<string, unknown> = {}) {
    return {
      state: { schema: 1, installed: false, primaryPort: 4321, steps: {} },
      ui: {
        ...createAutoUi(),
        password: async (o: { message: string }) => (o.message.includes('authtoken') ? 'SECRET-TOKEN' : 'longenough'),
        text: async (o: { message: string }) => (o.message.includes('domain') ? '' : 'ops'),
      },
      runner,
      save: async () => {},
      dryRun: false,
      assumeYes: true,
      reconfigure: new Set<string>(),
      repoRoot: '/repo',
      now: '2026-07-16T00:00:00.000Z',
      prefs: {},
      ...over,
    } as never;
  }

  it('never puts the authtoken in argv — it travels via NGROK_AUTHTOKEN env', async () => {
    const interactiveCalls: Array<{ args: string[]; env?: Record<string, string> }> = [];
    const runner: Runner = {
      capture: async (_p, args) => {
        // launchctl print reports loaded; command -v finds ngrok
        if (args[0] === 'print' || args.join(' ').includes('command -v')) return { code: 0, stdout: '/opt/homebrew/bin/ngrok', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
      interactive: async (_p, args, o) => {
        interactiveCalls.push({ args, env: (o as { env?: Record<string, string> } | undefined)?.env });
        return 0;
      },
    };
    await ngrokStepOf().run(ctxFor(runner));
    const tokenCall = interactiveCalls.find((c) => c.args.join(' ').includes('add-authtoken'));
    expect(tokenCall).toBeDefined();
    expect(tokenCall?.args.join(' ')).not.toContain('SECRET-TOKEN');
    expect(tokenCall?.args.join(' ')).toContain('$NGROK_AUTHTOKEN');
    expect(tokenCall?.env?.NGROK_AUTHTOKEN).toBe('SECRET-TOKEN');
  });

  it('writes the credential-bearing plist 0600', async () => {
    const runner: Runner = {
      capture: async (_p, args) => {
        if (args[0] === 'print' || args.join(' ').includes('command -v')) return { code: 0, stdout: '/usr/local/bin/ngrok', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
      interactive: async () => 0,
    };
    // point HOME-based plist path into the temp dir via a fake homedir? plistPath()
    // uses the real homedir — instead assert through the file the step wrote.
    const oldHome = process.env.HOME;
    process.env.HOME = home; // node's os.homedir() honors $HOME on posix
    try {
      await ngrokStepOf().run(ctxFor(runner));
      const p = join(home, 'Library', 'LaunchAgents', 'ai.cezar.ngrok.plist');
      expectOwnerOnlyMode(p);
      expect(readFileSync(p, 'utf8')).toContain('ops:longenough'); // creds live here → hence 0600
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });

  it('a failed launchctl bootstrap fails the step instead of recording done', async () => {
    const runner: Runner = {
      capture: async (_p, args) => {
        if (args.join(' ').includes('command -v')) return { code: 0, stdout: '/usr/local/bin/ngrok', stderr: '' };
        if (args[0] === 'print') return { code: 113, stdout: '', stderr: '' }; // not loaded
        return { code: 0, stdout: '', stderr: '' };
      },
      interactive: async (_p, args) => (args[0] === 'bootstrap' ? 5 : 0),
    };
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      await expect(ngrokStepOf().run(ctxFor(runner))).rejects.toThrow(/launchctl could not load/);
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
      await ngrokStepOf().undo(ctxFor(runner), null);
      expect(commands.some((c) => c[0] === 'bootout' && (c[1] ?? '').includes('ai.cezar.ngrok'))).toBe(true);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });

  it('rejects a scheme-carrying domain (bare hostname only)', async () => {
    let domainValidate: ((v: string) => string | undefined) | undefined;
    const runner: Runner = {
      capture: async (_p, args) => {
        if (args[0] === 'print' || args.join(' ').includes('command -v')) return { code: 0, stdout: '/usr/local/bin/ngrok', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
      interactive: async () => 0,
    };
    const ctx = ctxFor(runner, {
      ui: {
        ...createAutoUi(),
        password: async () => 'longenough',
        text: async (o: { message: string; validate?: (v: string) => string | undefined }) => {
          if (o.message.includes('domain')) {
            domainValidate = o.validate;
            return '';
          }
          return 'ops';
        },
      },
    });
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      await ngrokStepOf().run(ctx);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
    expect(domainValidate).toBeDefined();
    expect(domainValidate?.('https://cezar.ngrok.app')).toBeDefined();
    expect(domainValidate?.('cezar.ngrok.app')).toBeUndefined();
    expect(domainValidate?.('')).toBeUndefined(); // blank = ephemeral, allowed
  });
});

describe('macosx-ngrok redeploy restart verification (#1011)', () => {
  it('fails when the cockpit kickstart exits non-zero', async () => {
    const interactive = async (_program: string, args: string[]) => (args.includes('kickstart') ? 1 : 0);
    const capture = async () => ({ code: 0, stdout: '{"tunnels":[{"public_url":"https://x.ngrok.app"}]}', stderr: '' });

    await expect(macosxNgrok.redeploy!(redeployCtx({ runner: { capture, interactive } }))).rejects.toBeInstanceOf(StepAborted);
  });

  it('fails when the ngrok kickstart exits non-zero', async () => {
    let kickstarts = 0;
    const interactive = async () => {
      kickstarts += 1;
      return kickstarts === 2 ? 1 : 0;
    };
    const capture = async () => ({ code: 0, stdout: '', stderr: '' });

    await expect(macosxNgrok.redeploy!(redeployCtx({ runner: { capture, interactive } }))).rejects.toThrow(/ngrok tunnel/);
  });

  it('fails when launchd reports the same cockpit PID after kickstart', async () => {
    const interactive = async () => 0;
    const capture = async (_program: string, args: string[]) =>
      args.includes('print')
        ? { code: 0, stdout: 'pid = 4242', stderr: '' }
        : { code: 0, stdout: '{"tunnels":[{"public_url":"https://x.ngrok.app"}]}', stderr: '' };

    await expect(macosxNgrok.redeploy!(redeployCtx({ runner: { capture, interactive } }))).rejects.toThrow(/did not actually restart/);
  });
});
