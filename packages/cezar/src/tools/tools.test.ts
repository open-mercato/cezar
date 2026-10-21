import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emulatorStart, emulatorStop, parseEmulators } from './android.ts';
import { ANDROID_CMDLINE_SHA256 } from './constants.ts';
import { type FlutterManifest, pickFlutterRelease } from './flutter.ts';
import { iosRuntimes, pickSimulator } from './ios.ts';
import { javaMajor } from './jdk.ts';
import { withToolLock } from './lock.ts';
import { TOOLS_PROMPT, toolsReachable } from './prompt.ts';
import { applyToolsEnv, composeToolsEnv, ensureTools, expandIds, managedToolsEnv, statusAll } from './registry.ts';
import { type ExecResult, type ToolsContext, downloadFile, extractArchive, findOnPath, isOn } from './runtime.ts';
import { formatExports, runToolsCommand } from './tools-cli.ts';

const BYTES = Buffer.from('fake archive bytes');
const BYTES_SHA = createHash('sha256').update(BYTES).digest('hex');
const OK: ExecResult = { code: 0, stdout: '', stderr: '' };

/** A machine in a temp dir: `exec` plays the part of tar/unzip/sdkmanager/avdmanager/adb/flutter. */
function fakeMachine(options: { install?: boolean; arch?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cez-tools-'));
  const calls: string[] = [];
  const urls: string[] = [];
  const state = { emulatorSpawned: false, booted: false };
  const mk = (...parts: string[]): void => {
    mkdirSync(join(...parts.slice(0, -1)), { recursive: true });
    writeFileSync(join(...parts), '');
  };
  const manifest: FlutterManifest = {
    base_url: 'https://dl.example/flutter',
    current_release: { stable: 'abc' },
    releases: [{ hash: 'abc', channel: 'stable', version: '3.99.0', archive: 'stable/linux/flutter_linux_3.99.0-stable.tar.xz', sha256: BYTES_SHA }],
  };
  const ctx: ToolsContext = {
    platform: 'linux',
    arch: options.arch ?? 'x64',
    env: { PATH: '' },
    home: join(root, 'home'),
    toolsDir: join(root, 'tools'),
    install: options.install ?? true,
    fetch: (async (url: string | URL | Request) => {
      urls.push(String(url));
      return String(url).endsWith('.json') ? Response.json(manifest) : new Response(BYTES);
    }) as typeof fetch,
    log: () => undefined,
    sleep: async () => undefined,
    spawnDetached: () => {
      state.emulatorSpawned = true;
    },
    async exec(command, args, opts = {}) {
      const name = basename(command);
      calls.push(`${name} ${args.join(' ')}`);
      const dest = args[Math.max(args.indexOf('-C'), args.indexOf('-d')) + 1];
      if (name === 'tar' || name === 'unzip') {
        const archive = args.find((a) => /\.(zip|tar\.gz|tar\.xz)$/.test(a)) ?? '';
        if (archive.endsWith('jdk.tar.gz')) mk(dest!, 'jdk-17.0.9+9', 'bin', 'java');
        if (archive.endsWith('cmdline-tools.zip')) {
          mk(dest!, 'cmdline-tools', 'bin', 'sdkmanager');
          mk(dest!, 'cmdline-tools', 'bin', 'avdmanager');
        }
        if (archive.endsWith('flutter.tar.xz')) mk(dest!, 'flutter', 'bin', 'flutter');
        return OK;
      }
      if (name === 'java') return { code: 0, stdout: '', stderr: 'openjdk version "17.0.9" 2023-10-17' };
      if (name === 'sdkmanager') {
        const sdk = args.find((a) => a.startsWith('--sdk_root='))!.slice('--sdk_root='.length);
        if (args.includes('--install')) {
          for (const pkg of args) {
            if (pkg === 'platform-tools') mk(sdk, 'platform-tools', 'adb');
            if (pkg.startsWith('platforms;')) mkdirSync(join(sdk, 'platforms', pkg.slice('platforms;'.length)), { recursive: true });
            if (pkg === 'emulator') mk(sdk, 'emulator', 'emulator');
            if (pkg.startsWith('system-images;')) mkdirSync(join(sdk, ...pkg.split(';')), { recursive: true });
          }
        }
        return OK;
      }
      if (name === 'avdmanager') {
        mk(opts.env!.ANDROID_AVD_HOME!, 'cezar.ini');
        return OK;
      }
      if (name === 'adb') {
        if (args[0] === 'devices') return { code: 0, stdout: `List of devices attached\n${state.emulatorSpawned ? 'emulator-5554\tdevice\n' : ''}`, stderr: '' };
        if (args.includes('getprop')) return { code: 0, stdout: state.emulatorSpawned ? '1\n' : '', stderr: '' };
        return OK;
      }
      return OK;
    },
  };
  return { ctx, calls, urls, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('pure helpers', () => {
  it('parses java banners, including legacy 1.8', () => {
    expect(javaMajor('openjdk version "17.0.9" 2023')).toBe(17);
    expect(javaMajor('java version "1.8.0_392"')).toBe(8);
    expect(javaMajor('command not found')).toBeUndefined();
  });

  it('picks the stable Flutter archive for the machine', () => {
    const manifest: FlutterManifest = {
      base_url: 'https://x/releases',
      current_release: { stable: 'h2' },
      releases: [
        { hash: 'h1', channel: 'stable', version: '1.0.0', archive: 'a/old.zip', sha256: 'old' },
        { hash: 'h2', channel: 'beta', version: '2.0.0-b', archive: 'a/beta.zip', sha256: 'b' },
        { hash: 'h2', channel: 'stable', version: '2.0.0', archive: 'a/flutter_macos_2.0.0.zip', sha256: 'x64', dart_sdk_arch: 'x64' },
        { hash: 'h2', channel: 'stable', version: '2.0.0', archive: 'a/flutter_macos_arm64_2.0.0.zip', sha256: 'arm', dart_sdk_arch: 'arm64' },
      ],
    };
    expect(pickFlutterRelease(manifest, 'arm64')).toEqual({ url: 'https://x/releases/a/flutter_macos_arm64_2.0.0.zip', sha256: 'arm', version: '2.0.0' });
    expect(pickFlutterRelease(manifest, 'x64')?.sha256).toBe('x64');
    expect(pickFlutterRelease({ ...manifest, current_release: { stable: 'none' } }, 'x64')).toBeUndefined();
  });

  it('reads online emulators from adb devices', () => {
    expect(parseEmulators('List of devices attached\nemulator-5554\tdevice\nemulator-5556\toffline\nR58M\tdevice\n')).toEqual(['emulator-5554']);
  });

  it('finds the booted or newest iPhone simulator, and iOS runtimes newest first', () => {
    const devices = JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [{ udid: 'OLD', name: 'iPhone 15', state: 'Shutdown', isAvailable: true }],
        'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
          { udid: 'NEW', name: 'iPhone 16', state: 'Shutdown', isAvailable: true },
          { udid: 'PAD', name: 'iPad Air', state: 'Shutdown', isAvailable: true },
        ],
        'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [{ udid: 'W', name: 'iPhone-ish watch', state: 'Booted' }],
      },
    });
    expect(pickSimulator(devices)?.udid).toBe('NEW');
    expect(pickSimulator(devices, 'OLD')?.name).toBe('iPhone 15');
    expect(pickSimulator(devices, 'nope')).toBeUndefined();
    const booted = devices.replace('"state":"Shutdown","isAvailable":true},{"udid":"PAD"', '"state":"Booted","isAvailable":true},{"udid":"PAD"');
    expect(pickSimulator(booted)?.state).toBe('Booted');
    expect(pickSimulator('not json')).toBeUndefined();
    const runtimes = JSON.stringify({
      runtimes: [
        { identifier: 'a', name: 'iOS 17.5', version: '17.5' },
        { identifier: 'b', name: 'iOS 18.2', version: '18.2' },
        { identifier: 'c', name: 'watchOS 11', version: '11.0' },
        { identifier: 'd', name: 'iOS 19.0', version: '19.0', isAvailable: false },
      ],
    });
    expect(iosRuntimes(runtimes).map((r) => r.identifier)).toEqual(['b', 'a']);
  });

  it('treats only explicit truthy values as opting in', () => {
    expect([undefined, '', '0', 'no'].map(isOn)).toEqual([false, false, false, false]);
    expect(['1', 'true', 'ON'].map(isOn)).toEqual([true, true, true]);
  });

  it('expands dependencies first, once', () => {
    expect(expandIds(['android-emulator', 'flutter', 'jdk'])).toEqual(['jdk', 'android-sdk', 'android-emulator', 'flutter']);
  });
});

describe('exports', () => {
  const env = { path: ['C:\\Users\\me\\.cezar\\tools\\flutter\\bin', "/opt/it's"], vars: { FLUTTER_ROOT: 'C:\\f' } };
  it('writes bash with MSYS paths on Windows and quotes safely', () => {
    expect(formatExports(env, 'bash', 'win32')).toEqual([
      `export PATH='/c/Users/me/.cezar/tools/flutter/bin':'/opt/it'\\''s':"$PATH"`,
      `export FLUTTER_ROOT='C:\\f'`,
    ]);
    expect(formatExports(env, 'bash', 'linux')[0]).toContain(`'C:\\Users\\me\\.cezar\\tools\\flutter\\bin'`);
  });
  it('writes PowerShell', () => {
    expect(formatExports(env, 'powershell', 'win32')).toEqual([
      `$env:PATH = 'C:\\Users\\me\\.cezar\\tools\\flutter\\bin;/opt/it''s;' + $env:PATH`,
      `$env:FLUTTER_ROOT = 'C:\\f'`,
    ]);
  });
  it('prints nothing for an empty environment', () => {
    expect(formatExports({ path: [], vars: {} }, 'bash', 'linux')).toEqual([]);
  });
});

describe('filesystem helpers', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-tools-fs-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('finds a binary on PATH using the platform spelling of the PATH key', () => {
    const name = process.platform === 'win32' ? 'thing.exe' : 'thing';
    writeFileSync(join(dir, name), '');
    const ctx = { platform: process.platform, env: { [process.platform === 'win32' ? 'Path' : 'PATH']: `${dir}${delimiter}/nowhere` } } as unknown as ToolsContext;
    expect(findOnPath(ctx, 'thing')?.toLowerCase()).toBe(join(dir, name).toLowerCase());
    expect(findOnPath(ctx, 'other')).toBeUndefined();
  });

  it('downloads, verifies the checksum, and rejects a mismatch without leaving the file', async () => {
    const { ctx, cleanup } = fakeMachine();
    const dest = join(dir, 'a', 'x.bin');
    await downloadFile(ctx, 'https://e/x', dest, BYTES_SHA);
    expect(existsSync(dest)).toBe(true);
    await expect(downloadFile(ctx, 'https://e/x', dest, 'deadbeef')).rejects.toThrow(/checksum mismatch/);
    expect(existsSync(dest)).toBe(false);
    cleanup();
  });

  it('extracts with tar for tarballs and unzip on Linux zips', async () => {
    const { ctx, calls, cleanup } = fakeMachine();
    await extractArchive(ctx, join(dir, 'a.tar.xz'), join(dir, 'o1'));
    await extractArchive(ctx, join(dir, 'a.zip'), join(dir, 'o2'));
    expect(calls[0]).toMatch(/^tar -xJf /);
    expect(calls[1]).toMatch(/^unzip -q -o /);
    cleanup();
  });

  it('on Windows tries System32 tar.exe, then PowerShell, and names the failure', async () => {
    const { ctx, cleanup } = fakeMachine();
    const seen: string[] = [];
    const win = { ...ctx, platform: 'win32' as const, env: { SystemRoot: 'C:\\Windows' }, exec: async (c: string) => (seen.push(c), { code: 1, stdout: '', stderr: 'nope' }) };
    await expect(extractArchive(win, join(dir, 'a.zip'), join(dir, 'o'))).rejects.toThrow(/could not extract/);
    expect(seen.map((c) => basename(c.replace(/\\/g, '/')))).toEqual(['tar.exe', 'powershell.exe']);
    cleanup();
  });
});

describe('lock', () => {
  it('serializes holders of the same name and releases on failure', async () => {
    const { ctx, cleanup } = fakeMachine();
    const order: string[] = [];
    const real = { ...ctx, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5))) };
    const a = withToolLock(real, 'x', async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 40));
      order.push('a-end');
    }, { pollMs: 5 });
    const b = withToolLock(real, 'x', async () => void order.push('b'), { pollMs: 5 });
    await Promise.all([a, b]);
    expect(order).toEqual(['a-start', 'a-end', 'b']);
    await expect(withToolLock(real, 'x', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await withToolLock(real, 'x', async () => undefined); // free again
    cleanup();
  });

  it('replaces a lock whose owner is gone, and times out on a live one', async () => {
    const { ctx, root, cleanup } = fakeMachine();
    mkdirSync(join(ctx.toolsDir, '.locks'), { recursive: true });
    writeFileSync(join(ctx.toolsDir, '.locks', 'dead.lock'), `2147483646\n${Date.now()}\n`);
    await expect(withToolLock(ctx, 'dead', async () => 'ok')).resolves.toBe('ok');
    writeFileSync(join(ctx.toolsDir, '.locks', 'live.lock'), `${process.pid}\n${Date.now()}\n`);
    await expect(withToolLock({ ...ctx, sleep: async () => undefined }, 'live', async () => 'no', { waitMs: 0 })).rejects.toThrow(/timed out/);
    expect(root).toBeTruthy();
    cleanup();
  });
});

describe('ensure (offline, fake machine)', () => {
  it('only reports when installs are off, with the enable hint, and runs nothing', async () => {
    const { ctx, calls, urls, cleanup } = fakeMachine({ install: false });
    const reports = await ensureTools(ctx, ['flutter']);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ id: 'flutter', status: 'missing' });
    expect(reports[0]!.message).toContain('CEZ_TOOL_INSTALL=1');
    expect(urls).toEqual([]);
    expect(calls).toEqual([]);
    expect(existsSync(ctx.toolsDir)).toBe(false);
    cleanup();
  });

  it('installs the chain jdk -> android-sdk -> android-emulator into the tools dir, in order', async () => {
    const { ctx, calls, urls, cleanup } = fakeMachine();
    ANDROID_CMDLINE_SHA256.linux = BYTES_SHA;
    const reports = await ensureTools(ctx, ['android-emulator']);
    expect(reports.map((r) => [r.id, r.status])).toEqual([
      ['jdk', 'installed'],
      ['android-sdk', 'installed'],
      ['android-emulator', 'installed'],
    ]);
    expect(urls[0]).toContain('api.adoptium.net/v3/binary/latest/17/ga/linux/x64');
    expect(urls[1]).toContain('commandlinetools-linux-');
    const sdkCalls = calls.filter((c) => c.startsWith('sdkmanager'));
    expect(sdkCalls[0]).toContain('--licenses');
    expect(sdkCalls[1]).toContain('platform-tools platforms;android-35');
    expect(sdkCalls[2]).toContain('emulator system-images;android-35;google_apis;x86_64');
    expect(calls.some((c) => c.startsWith('avdmanager create avd'))).toBe(true);
    // idempotent: a second ensure installs nothing
    calls.length = 0;
    urls.length = 0;
    expect((await ensureTools(ctx, ['android-emulator'])).map((r) => r.status)).toEqual(['ready', 'ready', 'ready']);
    expect(urls).toEqual([]);
    expect(calls.filter((c) => /^(tar|unzip|sdkmanager|avdmanager)/.test(c))).toEqual([]);
    // the env now carries them
    const env = composeToolsEnv(ctx);
    expect(env.vars.JAVA_HOME).toBe(join(ctx.toolsDir, 'jdk'));
    expect(env.vars.ANDROID_HOME).toBe(join(ctx.toolsDir, 'android-sdk'));
    expect(env.vars.ANDROID_AVD_HOME).toBe(join(ctx.toolsDir, 'android-avd'));
    cleanup();
  });

  it('uses arm64-v8a images on arm64', async () => {
    const { ctx, calls, cleanup } = fakeMachine({ arch: 'arm64' });
    ANDROID_CMDLINE_SHA256.linux = BYTES_SHA;
    await ensureTools(ctx, ['android-emulator']);
    expect(calls.find((c) => c.includes('system-images'))).toContain('google_apis;arm64-v8a');
    cleanup();
  });

  it('installs Flutter from the stable manifest and verifies the pinned sha', async () => {
    const { ctx, urls, cleanup } = fakeMachine();
    const [report] = await ensureTools(ctx, ['flutter']);
    expect(report!.status).toBe('installed');
    expect(urls).toEqual([
      'https://storage.googleapis.com/flutter_infra_release/releases/releases_linux.json',
      'https://dl.example/flutter/stable/linux/flutter_linux_3.99.0-stable.tar.xz',
    ]);
    expect(composeToolsEnv(ctx).vars.FLUTTER_ROOT).toBe(join(ctx.toolsDir, 'flutter'));
    cleanup();
  });

  it('two parallel ensures of one tool install it once', async () => {
    const { ctx, urls, cleanup } = fakeMachine();
    const real = { ...ctx, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5))) };
    const [a, b] = await Promise.all([ensureTools(real, ['flutter']), ensureTools(real, ['flutter'])]);
    expect([a[0]!.status, b[0]!.status].sort()).toEqual(['installed', 'ready']);
    expect(urls.filter((u) => u.endsWith('.tar.xz'))).toHaveLength(1);
    cleanup();
  });

  it('reports a failed install and blocks dependents, leaving no half-installed tool', async () => {
    const { ctx, cleanup } = fakeMachine();
    const broken = { ...ctx, fetch: (async () => new Response('no', { status: 503 })) as typeof fetch };
    const reports = await ensureTools(broken, ['android-sdk']);
    expect(reports.map((r) => r.status)).toEqual(['failed', 'blocked']);
    expect(reports[0]!.message).toContain('503');
    expect(existsSync(join(ctx.toolsDir, 'jdk'))).toBe(false);
    expect(existsSync(join(ctx.toolsDir, '.locks', 'jdk.lock'))).toBe(false);
    cleanup();
  });

  it('marks the iOS simulator unsupported off macOS without trying anything', async () => {
    const { ctx, calls, cleanup } = fakeMachine();
    expect((await ensureTools(ctx, ['ios-simulator']))[0]).toMatchObject({ status: 'unsupported' });
    expect((await statusAll(ctx)).find((r) => r.id === 'ios-simulator')!.status).toBe('unsupported');
    expect(calls).toEqual([]);
    cleanup();
  });
});

describe('android emulator lifecycle', () => {
  it('boots once, then reuses the running emulator, and stops it', async () => {
    const { ctx, calls, cleanup } = fakeMachine();
    ANDROID_CMDLINE_SHA256.linux = BYTES_SHA;
    await ensureTools(ctx, ['android-emulator']);
    const env = applyToolsEnv(ctx.env, composeToolsEnv(ctx), ctx.platform);
    const first = await emulatorStart(ctx, env);
    expect(first).toEqual({ serial: 'emulator-5554', reused: false });
    expect(await emulatorStart(ctx, env)).toEqual({ serial: 'emulator-5554', reused: true });
    expect(await emulatorStop(ctx, env)).toEqual(['emulator-5554']);
    expect(calls.some((c) => c === 'adb -s emulator-5554 emu kill')).toBe(true);
    cleanup();
  });
});

describe('environment for agents', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-tools-env-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('adds nothing until something was provisioned', () => {
    expect(managedToolsEnv({ CEZ_HOME: home, PATH: '/usr/bin' })).toEqual({});
  });

  it('prepends installed tool dirs and sets their variables, ignoring system SDKs', () => {
    const bin = process.platform === 'win32' ? 'flutter.bat' : 'flutter';
    mkdirSync(join(home, 'tools', 'flutter', 'bin'), { recursive: true });
    writeFileSync(join(home, 'tools', 'flutter', 'bin', bin), '');
    const key = process.platform === 'win32' ? 'Path' : 'PATH';
    const out = managedToolsEnv({ CEZ_HOME: home, [key]: 'orig', ANDROID_HOME: join(home, 'elsewhere') });
    expect(out[key]).toBe(`${join(home, 'tools', 'flutter', 'bin')}${process.platform === 'win32' ? ';' : ':'}orig`);
    expect(out.FLUTTER_ROOT).toBe(join(home, 'tools', 'flutter'));
    expect(out.ANDROID_HOME).toBeUndefined();
  });
});

describe('agent prompt gate', () => {
  it('needs both the opt-in and the cockpit entrypoint', () => {
    expect(toolsReachable({ CEZ_TOOL_INSTALL: '1' })).toBe(false);
    expect(toolsReachable({ CEZ_BIN: '/x/cezar' })).toBe(false);
    expect(toolsReachable({ CEZ_TOOL_INSTALL: '1', CEZ_BIN: '/x/cezar' })).toBe(true);
    expect(TOOLS_PROMPT).toContain('tools ensure');
  });
});

describe('cezar tools CLI', () => {
  let out: string[];
  let err: string[];
  const io = { log: (l: string) => out.push(l), error: (l: string) => err.push(l) };
  beforeEach(() => {
    out = [];
    err = [];
  });

  it('shows usage without a command and rejects unknown flags, commands and ids with exit 2', async () => {
    const { ctx, cleanup } = fakeMachine({ install: false });
    expect(await runToolsCommand([], ctx, io)).toBe(2);
    expect(await runToolsCommand(['list', '--bogus'], ctx, io)).toBe(2);
    expect(await runToolsCommand(['nope'], ctx, io)).toBe(2);
    expect(await runToolsCommand(['ensure'], ctx, io)).toBe(2);
    expect(await runToolsCommand(['ensure', 'cobol'], ctx, io)).toBe(2);
    expect(await runToolsCommand(['env', '--shell', 'fish'], ctx, io)).toBe(2);
    expect(await runToolsCommand(['emulator'], ctx, io)).toBe(2);
    expect(await runToolsCommand(['simulator', 'x'], ctx, io)).toBe(2);
    cleanup();
  });

  it('lists as JSON with the install flag', async () => {
    const { ctx, cleanup } = fakeMachine({ install: false });
    expect(await runToolsCommand(['status', '--json'], ctx, io)).toBe(0);
    const json = JSON.parse(out.join('\n')) as { install: boolean; tools: Array<{ id: string; status: string }> };
    expect(json.install).toBe(false);
    expect(json.tools.map((t) => t.id)).toEqual(['jdk', 'android-sdk', 'android-emulator', 'ios-simulator', 'flutter']);
    cleanup();
  });

  it('ensure without installs exits 1 and says how to enable them', async () => {
    const { ctx, cleanup } = fakeMachine({ install: false });
    expect(await runToolsCommand(['ensure', 'flutter'], ctx, io)).toBe(1);
    expect(out.join('\n')).toContain('CEZ_TOOL_INSTALL=1');
    cleanup();
  });

  it('--install enables it for one call and prints exports for the result', async () => {
    const { ctx, cleanup } = fakeMachine({ install: false });
    expect(await runToolsCommand(['ensure', 'flutter', '--install', '--shell', 'bash'], ctx, io)).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('installed');
    expect(text).toContain('export FLUTTER_ROOT=');
    out.length = 0;
    expect(await runToolsCommand(['env', '--shell', 'powershell'], ctx, io)).toBe(0);
    expect(out.join('\n')).toContain('$env:FLUTTER_ROOT');
    cleanup();
  });

  it('refuses to start the emulator when it is not ready, without spawning', async () => {
    const { ctx, cleanup } = fakeMachine({ install: false });
    const spawn = vi.fn();
    expect(await runToolsCommand(['emulator', 'start'], { ...ctx, spawnDetached: spawn }, io)).toBe(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(err.join('\n')).toContain('not ready');
    cleanup();
  });

  it('starts the emulator end to end and prints the serial', async () => {
    const { ctx, cleanup } = fakeMachine();
    ANDROID_CMDLINE_SHA256.linux = BYTES_SHA;
    expect(await runToolsCommand(['emulator', 'start', '--json'], ctx, io)).toBe(0);
    expect(JSON.parse(out.join('\n'))).toEqual({ serial: 'emulator-5554', reused: false });
    cleanup();
  });
});
