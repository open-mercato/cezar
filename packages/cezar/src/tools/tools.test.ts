import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emulatorStart, emulatorStop, freeEmulatorPort, parseEmulators, usedEmulatorPorts } from './android.ts';
import { ANDROID_CMDLINE_SHA256, ANDROID_NDK_FALLBACK } from './constants.ts';
import { type FlutterManifest, pickFlutterRelease } from './flutter.ts';
import { iosRuntimes, pickSimulator, simulatorBoot, simulatorShutdown } from './ios.ts';
import { javaMajor, pickJdkPackage } from './jdk.ts';
import { parseBuildTools, parseCmdlineTools, parsePlatformLevels, parseSystemImageLevels, planFromManifests, resolveAndroidPlan } from './android-manifest.ts';
import { flutterNdkVersion, parseNdkVersion } from './flutter-ndk.ts';
import { withToolLock } from './lock.ts';
import { TOOLS_PROMPT, toolsReachable } from './prompt.ts';
import { applyToolsEnv, composeToolsEnv, ensureTools, expandIds, managedToolsEnv, statusAll } from './registry.ts';
import { type ExecResult, type ToolsContext, downloadFile, extractArchive, findOnPath, isOn, quoteForCmd, resolveInstallEnabled, setStoredToolsInstall, toolsInstallEnabled } from './runtime.ts';
import { formatExports, runToolsCommand } from './tools-cli.ts';

const BYTES = Buffer.from('fake archive bytes');
const BYTES_SHA = createHash('sha256').update(BYTES).digest('hex');
const OK: ExecResult = { code: 0, stdout: '', stderr: '' };

/** A machine in a temp dir: `exec` plays the part of tar/unzip/sdkmanager/avdmanager/adb/flutter. */
function fakeMachine(options: { install?: boolean; arch?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cez-tools-'));
  const calls: string[] = [];
  const urls: string[] = [];
  const logs: string[] = [];
  /** `foreign` is somebody else's emulator (BlueStacks) on 5554; `emulatorExit` simulates a process that died. */
  const state = { emulatorSpawned: false, foreign: false, emulatorExit: null as number | null, sdkFailures: 0 };
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
      if (String(url).includes('/v3/assets/')) {
        return Response.json([{ binary: { image_type: 'jdk', package: { link: 'https://dl.example/jdk.tar.gz', checksum: BYTES_SHA } } }]);
      }
      return String(url).endsWith('.json') ? Response.json(manifest) : new Response(BYTES);
    }) as typeof fetch,
    log: (line) => logs.push(line),
    sleep: async () => undefined,
    spawnDetached: () => {
      state.emulatorSpawned = true;
      return { exitCode: () => state.emulatorExit };
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
        if (archive.endsWith('flutter.tar.xz')) {
          mk(dest!, 'flutter', 'bin', 'flutter');
          // The line a real Flutter release carries (packages/flutter_tools/gradle/.../FlutterExtension.kt).
          const kt = join(dest!, 'flutter', 'packages', 'flutter_tools', 'gradle', 'src', 'main', 'kotlin');
          mkdirSync(kt, { recursive: true });
          writeFileSync(join(kt, 'FlutterExtension.kt'), '    val ndkVersion: String = "27.1.12297006"\n');
        }
        return OK;
      }
      if (name === 'java') return { code: 0, stdout: '', stderr: 'openjdk version "17.0.9" 2023-10-17' };
      if (name === 'sdkmanager') {
        const sdk = args.find((a) => a.startsWith('--sdk_root='))!.slice('--sdk_root='.length);
        if (args.includes('--install') && state.sdkFailures > 0) {
          state.sdkFailures--;
          return { code: 1, stdout: '', stderr: 'java.net.SocketException: Connection reset' };
        }
        if (args.includes('--install')) {
          for (const pkg of args) {
            if (pkg === 'platform-tools') mk(sdk, 'platform-tools', 'adb');
            if (pkg.startsWith('platforms;')) mkdirSync(join(sdk, 'platforms', pkg.slice('platforms;'.length)), { recursive: true });
            if (pkg === 'emulator') mk(sdk, 'emulator', 'emulator');
            if (pkg.startsWith('system-images;')) mkdirSync(join(sdk, ...pkg.split(';')), { recursive: true });
            if (pkg.startsWith('ndk;')) mk(sdk, 'ndk', pkg.slice('ndk;'.length), 'source.properties');
          }
        }
        return OK;
      }
      if (name === 'avdmanager') {
        mk(opts.env!.ANDROID_AVD_HOME!, 'cezar.ini');
        return OK;
      }
      if (name === 'adb') {
        // Ours takes 5556 when a foreign emulator holds 5554, else 5554.
        const ours = state.emulatorSpawned && !state.emulatorExit ? (state.foreign ? 'emulator-5556' : 'emulator-5554') : undefined;
        const lines = [state.foreign && 'emulator-5554\tdevice', ours && `${ours}\tdevice`].filter(Boolean);
        if (args[0] === 'devices') return { code: 0, stdout: `List of devices attached\n${lines.join('\n')}\n`, stderr: '' };
        const serial = args[args.indexOf('-s') + 1];
        if (args.includes('avd')) return { code: 0, stdout: `${serial === ours ? 'cezar' : 'BlueStacks'}\r\nOK\r\n`, stderr: '' };
        if (args.includes('getprop')) return { code: 0, stdout: lines.some((l) => String(l).startsWith(`${serial}\t`)) ? '1\n' : '', stderr: '' };
        return OK;
      }
      return OK;
    },
  };
  return { ctx, calls, urls, logs, state, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
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

describe('cmd.exe quoting for .bat launchers', () => {
  it('quotes the batch delimiters that would split a package id', () => {
    expect(quoteForCmd('platforms;android-36')).toBe('"platforms;android-36"');
    expect(quoteForCmd('--sdk_root=C:\\Users\\me\\sdk')).toBe('"--sdk_root=C:\\Users\\me\\sdk"');
    expect(quoteForCmd('--install')).toBe('--install');
    expect(quoteForCmd('a b')).toBe('"a b"');
    expect(quoteForCmd('say "hi"')).toBe('"say ""hi"""');
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
    const real = { ...ctx, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5))) };
    // Who wins is up to the filesystem; what must hold is that never two are inside at once.
    let active = 0;
    let maxActive = 0;
    let ran = 0;
    const contender = (): Promise<void> =>
      withToolLock(real, 'x', async () => {
        maxActive = Math.max(maxActive, ++active);
        await new Promise((r) => setTimeout(r, 15));
        active--;
        ran++;
      }, { pollMs: 3 });
    await Promise.all([contender(), contender(), contender(), contender()]);
    expect(maxActive).toBe(1);
    expect(ran).toBe(4);
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
    expect(urls[0]).toContain('api.adoptium.net/v3/assets/latest/17/hotspot?architecture=x64&image_type=jdk&os=linux');
    expect(urls[1]).toBe('https://dl.example/jdk.tar.gz');
    expect(urls.some((u) => u.includes('commandlinetools-linux-'))).toBe(true); // pinned: the fake serves no manifest
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
    expect(err.join('\n')).toContain('CEZ_TOOL_INSTALL=1');
    expect(out).toEqual([]);
    cleanup();
  });

  it('with installs on, ensure prints exports on stdout and the result on stderr', async () => {
    const { ctx, cleanup } = fakeMachine();
    expect(await runToolsCommand(['ensure', 'flutter', '--shell', 'bash'], ctx, io)).toBe(0);
    expect(err.join('\n')).toContain('installed');
    expect(out.join('\n')).toContain('export FLUTTER_ROOT=');
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

const REPO_XML = readFileSync(new URL('./fixtures/repository2-3.excerpt.xml', import.meta.url), 'utf8');
const SYSIMG_XML = readFileSync(new URL('./fixtures/sys-img2-3.excerpt.xml', import.meta.url), 'utf8');

describe('Android versions from the repository manifest', () => {
  it('picks the newest stable cmdline-tools, API level and build-tools, with the published sha1', () => {
    const plan = planFromManifests(REPO_XML, SYSIMG_XML, 'linux', 'x86_64')!;
    expect(plan).toMatchObject({ apiLevel: 36, buildTools: '36.1.0', source: 'manifest' });
    expect(plan.cmdline).toEqual({
      url: 'https://dl.google.com/android/repository/commandlinetools-linux-16111833_latest.zip',
      checksum: 'e025545c62a8e64c7559119566a569fb1dec5f60',
      algo: 'sha1',
    });
    expect(planFromManifests(REPO_XML, SYSIMG_XML, 'win', 'x86_64')!.cmdline.url).toContain('commandlinetools-win-16111833');
    expect(planFromManifests(REPO_XML, SYSIMG_XML, 'mac_arm64', 'arm64-v8a')!.cmdline.url).toContain('mac_arm64-16111833');
    expect(planFromManifests(REPO_XML, SYSIMG_XML, 'mac_x86_64', 'x86_64')!.cmdline.url).toContain('mac_x86_64-16111833');
  });

  it('ignores obsolete and preview entries, extension levels, and levels with no image for this CPU', () => {
    expect(parsePlatformLevels(REPO_XML).sort()).toEqual([34, 35, 36]); // no -ext19, no obsolete duplicate
    expect(parseBuildTools(REPO_XML, 36)).toBe('36.1.0'); // not the 37.0.0 or the 34.0.0-rc1 preview
    expect(parseBuildTools(REPO_XML, 35)).toBe('35.0.0');
    expect(parseSystemImageLevels(SYSIMG_XML, 'x86_64').sort()).toEqual([35, 36]); // 36.1 / 37.0 are not plain levels
    // an image for a level whose platform package is absent is not selectable
    const only37 = SYSIMG_XML.replaceAll('android-36;google_apis', 'android-37;google_apis');
    expect(planFromManifests(REPO_XML, only37, 'linux', 'x86_64')!.apiLevel).toBe(35);
    expect(parseCmdlineTools(REPO_XML, 'linux')!.sha1).not.toBe('');
  });

  it('answers undefined when the manifests have nothing usable', () => {
    expect(planFromManifests('<nothing/>', SYSIMG_XML, 'linux', 'x86_64')).toBeUndefined();
    expect(planFromManifests(REPO_XML, '<nothing/>', 'linux', 'x86_64')).toBeUndefined();
  });

  it('falls back to the pinned versions when the manifest cannot be fetched or parsed, and resolves once per context', async () => {
    const down = fakeMachine();
    let calls = 0;
    const offline = { ...down.ctx, fetch: (async () => (calls++, Promise.reject(new Error('offline')))) as typeof fetch };
    const plan = await resolveAndroidPlan(offline, 'x86_64');
    expect(plan).toMatchObject({ source: 'pinned', apiLevel: 35, buildTools: '35.0.0' });
    expect(plan.cmdline.algo).toBe('sha256');
    expect(plan.cmdline.url).toContain('commandlinetools-linux-15859902');
    expect(down.logs.some((l) => l.includes('using the pinned versions'))).toBe(true);
    await resolveAndroidPlan(offline, 'x86_64');
    expect(calls).toBe(2); // the two manifests, once
    const garbled = { ...down.ctx, fetch: (async () => new Response('<html>nope</html>')) as typeof fetch };
    expect((await resolveAndroidPlan(garbled, 'x86_64')).source).toBe('pinned');
    down.cleanup();
  });

  it('installs the manifest versions end to end, verifying the sha1 it published', async () => {
    const { ctx, calls, urls, cleanup } = fakeMachine();
    const sha1 = createHash('sha1').update(BYTES).digest('hex');
    const repo = REPO_XML.replace('e025545c62a8e64c7559119566a569fb1dec5f60', sha1);
    const live = {
      ...ctx,
      fetch: (async (url: string | URL | Request) => {
        const u = String(url);
        urls.push(u);
        if (u.endsWith('repository2-3.xml')) return new Response(repo);
        if (u.endsWith('sys-img2-3.xml')) return new Response(SYSIMG_XML);
        if (u.includes('/v3/assets/')) return Response.json([{ binary: { image_type: 'jdk', package: { link: 'https://dl.example/jdk.tar.gz', checksum: BYTES_SHA } } }]);
        return new Response(BYTES);
      }) as typeof fetch,
    };
    const reports = await ensureTools(live, ['android-emulator']);
    expect(reports.map((r) => r.status)).toEqual(['installed', 'installed', 'installed']);
    expect(urls.some((u) => u.includes('commandlinetools-linux-16111833_latest.zip'))).toBe(true);
    const sdk = calls.filter((c) => c.startsWith('sdkmanager'));
    expect(sdk.some((c) => c.includes('platforms;android-36') && c.includes('build-tools;36.1.0'))).toBe(true);
    expect(sdk.some((c) => c.includes('system-images;android-36;google_apis;x86_64'))).toBe(true);
    expect(calls.find((c) => c.startsWith('avdmanager'))).toContain('system-images;android-36;google_apis;x86_64');
    // a later run keeps the installed image instead of churning the AVD
    expect((await ensureTools(live, ['android-emulator'])).map((r) => r.status)).toEqual(['ready', 'ready', 'ready']);
    cleanup();
  });

  it('rejects a cmdline-tools zip whose sha1 does not match the manifest', async () => {
    const { ctx, cleanup } = fakeMachine();
    const live = {
      ...ctx,
      fetch: (async (url: string | URL | Request) => {
        const u = String(url);
        if (u.endsWith('repository2-3.xml')) return new Response(REPO_XML); // the real sha1: BYTES will not match
        if (u.endsWith('sys-img2-3.xml')) return new Response(SYSIMG_XML);
        if (u.includes('/v3/assets/')) return Response.json([{ binary: { image_type: 'jdk', package: { link: 'https://dl.example/jdk.tar.gz', checksum: BYTES_SHA } } }]);
        return new Response(BYTES);
      }) as typeof fetch,
    };
    const reports = await ensureTools(live, ['android-sdk']);
    expect(reports[1]).toMatchObject({ id: 'android-sdk', status: 'failed' });
    expect(reports[1]!.message).toContain('checksum mismatch');
    cleanup();
  });
});

describe('the NDK Flutter builds with', () => {
  const NDK = '27.1.12297006';
  const ndkCalls = (calls: string[]): string[] => calls.filter((c) => c.startsWith('sdkmanager') && c.includes('ndk;'));

  it('reads the version from the Flutter release (Kotlin and Groovy layouts), else the fallback', () => {
    expect(parseNdkVersion('  val ndkVersion: String = "28.2.13676358"')).toBe('28.2.13676358');
    expect(parseNdkVersion('    String ndkVersion = "26.1.10909125"')).toBe('26.1.10909125');
    expect(parseNdkVersion('var ndkVersion: String // from AGP')).toBeUndefined();
    const dir = mkdtempSync(join(tmpdir(), 'cez-flutter-'));
    try {
      expect(flutterNdkVersion(dir)).toBe(ANDROID_NDK_FALLBACK);
      const kt = join(dir, 'packages', 'flutter_tools', 'gradle', 'src', 'main', 'kotlin');
      mkdirSync(kt, { recursive: true });
      writeFileSync(join(kt, 'FlutterExtension.kt'), 'val ndkVersion: String = "29.0.1"\n');
      expect(flutterNdkVersion(dir)).toBe('29.0.1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('installs it when ensure brings Flutter and the SDK together, once, and not when installs are off', async () => {
    const { ctx, calls, cleanup } = fakeMachine();
    ANDROID_CMDLINE_SHA256.linux = BYTES_SHA;
    const reports = await ensureTools(ctx, ['flutter', 'android-sdk']);
    expect(reports.map((r) => r.status)).toEqual(['installed', 'installed', 'installed']);
    expect(ndkCalls(calls)).toEqual([expect.stringContaining(`--install ndk;${NDK}`)]);
    expect(existsSync(join(ctx.toolsDir, 'android-sdk', 'ndk', NDK, 'source.properties'))).toBe(true);
    calls.length = 0;
    await ensureTools(ctx, ['flutter', 'android-sdk']);
    expect(ndkCalls(calls)).toEqual([]); // already there
    cleanup();
    const off = fakeMachine({ install: false });
    await ensureTools({ ...off.ctx, install: true }, ['jdk']); // something installed, so the dirs exist
    expect(ndkCalls(off.calls)).toEqual([]);
    off.cleanup();
  });

  it('installs it for a Flutter that was there first when the SDK arrives later', async () => {
    const { ctx, calls, cleanup } = fakeMachine();
    ANDROID_CMDLINE_SHA256.linux = BYTES_SHA;
    await ensureTools(ctx, ['flutter']); // no SDK yet: nothing to put an NDK in
    expect(ndkCalls(calls)).toEqual([]);
    await ensureTools(ctx, ['android-sdk']);
    expect(ndkCalls(calls)).toHaveLength(1);
    cleanup();
  });

  it('reports the tool failed, with the reason, when the NDK install fails', async () => {
    const { ctx, cleanup } = fakeMachine();
    ANDROID_CMDLINE_SHA256.linux = BYTES_SHA;
    await ensureTools(ctx, ['flutter', 'android-sdk']);
    rmSync(join(ctx.toolsDir, 'android-sdk', 'ndk'), { recursive: true });
    const flaky = { ...ctx, exec: async (c: string, a: string[], o?: Parameters<ToolsContext['exec']>[2]) => (a.some((x) => x.startsWith('ndk;')) ? { code: 1, stdout: '', stderr: 'disk full' } : ctx.exec(c, a, o)) };
    const reports = await ensureTools(flaky, ['flutter']);
    expect(reports[0]).toMatchObject({ id: 'flutter', status: 'failed' });
    expect(reports[0]!.message).toContain('disk full');
    cleanup();
  });
});

describe('install policy (Settings switch and CEZ_TOOL_INSTALL)', () => {
  afterEach(() => setStoredToolsInstall(undefined));

  it('lets the operator env win both ways, else the stored Settings switch, default off', () => {
    expect(resolveInstallEnabled({}, undefined)).toBe(false);
    expect(resolveInstallEnabled({}, false)).toBe(false);
    expect(resolveInstallEnabled({}, true)).toBe(true);
    expect(resolveInstallEnabled({ CEZ_TOOL_INSTALL: '1' }, false)).toBe(true);
    expect(resolveInstallEnabled({ CEZ_TOOL_INSTALL: '0' }, true)).toBe(false);
    expect(resolveInstallEnabled({ CEZ_TOOL_INSTALL: 'false' }, true)).toBe(false);
    expect(resolveInstallEnabled({ CEZ_TOOL_INSTALL: 'garbage' }, true)).toBe(true);
  });

  it('makes the agent prompt follow the effective value', () => {
    const env = { CEZ_BIN: '/x/cezar' };
    expect(toolsReachable(env)).toBe(false);
    setStoredToolsInstall(true);
    expect(toolsInstallEnabled(env)).toBe(true);
    expect(toolsReachable(env)).toBe(true);
    expect(toolsReachable({ ...env, CEZ_TOOL_INSTALL: '0' })).toBe(false);
    expect(toolsReachable({ CEZ_TOOL_INSTALL: '1' })).toBe(false); // still needs the cockpit entrypoint
  });
});

describe('review fixes', () => {
  const asDarwin = (ctx: ToolsContext, exec: ToolsContext['exec']): ToolsContext => ({ ...ctx, platform: 'darwin', exec });

  it('never reuses or stops an emulator that is not cezar AVD, and takes the next free port', async () => {
    const { ctx, calls, state, cleanup } = fakeMachine();
    ANDROID_CMDLINE_SHA256.linux = BYTES_SHA;
    await ensureTools(ctx, ['android-emulator']);
    state.foreign = true; // BlueStacks holds emulator-5554
    const env = applyToolsEnv(ctx.env, composeToolsEnv(ctx), ctx.platform);
    expect(await emulatorStart(ctx, env)).toEqual({ serial: 'emulator-5556', reused: false });
    expect(await emulatorStop(ctx, env)).toEqual(['emulator-5556']);
    expect(calls.filter((c) => c.includes('emu kill'))).toEqual(['adb -s emulator-5556 emu kill']);
    cleanup();
  });

  it('fails fast with the reason when the emulator process dies, instead of waiting out the timeout', async () => {
    const { ctx, state, cleanup } = fakeMachine();
    ANDROID_CMDLINE_SHA256.linux = BYTES_SHA;
    await ensureTools(ctx, ['android-emulator']);
    state.emulatorExit = 1;
    const env = applyToolsEnv(ctx.env, composeToolsEnv(ctx), ctx.platform);
    await expect(emulatorStart(ctx, env, { timeoutMs: 60_000 })).rejects.toThrow(/exited with code 1 before booting/);
    cleanup();
  });

  it('picks even console ports around the ones in use', () => {
    const devices = 'List of devices attached\nemulator-5554\tdevice\nemulator-5556\toffline\n';
    expect(usedEmulatorPorts(devices)).toEqual([5554, 5556]);
    expect(freeEmulatorPort([5554, 5556])).toBe(5558);
    expect(freeEmulatorPort([])).toBe(5554);
    expect(freeEmulatorPort(Array.from({ length: 16 }, (_, i) => 5554 + i * 2))).toBeUndefined();
  });

  it('retries sdkmanager once on a network error, and gives up on the second', async () => {
    const a = fakeMachine();
    ANDROID_CMDLINE_SHA256.linux = BYTES_SHA;
    a.state.sdkFailures = 1;
    expect((await ensureTools(a.ctx, ['android-sdk'])).map((r) => r.status)).toEqual(['installed', 'installed']);
    expect(a.logs.some((l) => l.includes('retrying once'))).toBe(true);
    a.cleanup();
    const b = fakeMachine();
    b.state.sdkFailures = 2;
    const reports = await ensureTools(b.ctx, ['android-sdk']);
    expect(reports[1]).toMatchObject({ status: 'failed' });
    expect(reports[1]!.message).toContain('Connection reset');
    b.cleanup();
  });

  it('verifies the JDK against the checksum Adoptium publishes', async () => {
    const { ctx, cleanup } = fakeMachine();
    const bad = {
      ...ctx,
      fetch: (async (url: string | URL | Request) =>
        String(url).includes('/v3/assets/')
          ? Response.json([{ binary: { image_type: 'jdk', package: { link: 'https://dl.example/jdk.tar.gz', checksum: 'deadbeef' } } }])
          : new Response(BYTES)) as typeof fetch,
    };
    const [report] = await ensureTools(bad, ['jdk']);
    expect(report).toMatchObject({ status: 'failed' });
    expect(report!.message).toContain('checksum mismatch');
    expect(existsSync(join(ctx.toolsDir, 'jdk'))).toBe(false);
    expect(pickJdkPackage([])).toBeUndefined();
    expect(pickJdkPackage([{ binary: { image_type: 'jre', package: { link: 'x', checksum: 'y' } } }])).toBeUndefined();
    cleanup();
  });

  it('sweeps staging dirs of dead processes (under the lock) and leaves other tools alone', async () => {
    const { ctx, cleanup } = fakeMachine();
    const dead = join(ctx.toolsDir, '.staging-jdk-2147483646');
    const other = join(ctx.toolsDir, '.staging-flutter-2147483646');
    for (const d of [dead, other]) mkdirSync(d, { recursive: true });
    await ensureTools(ctx, ['jdk']);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(other)).toBe(true);
    cleanup();
  });

  it('releases only its own lock: a lock another owner took over is left in place', async () => {
    const { ctx, cleanup } = fakeMachine();
    const lock = join(ctx.toolsDir, '.locks', 'y.lock');
    await withToolLock(ctx, 'y', async () => {
      expect(readFileSync(lock, 'utf8').trim().split('\n')).toHaveLength(3); // pid, time, owner token
    });
    expect(existsSync(lock)).toBe(false); // our own release removes it
    const stolen = `${process.pid}\n${Date.now()}\nsomeone-elses-token\n`;
    await withToolLock(ctx, 'y', async () => {
      writeFileSync(lock, stolen); // we were judged hung and replaced mid-work
    });
    expect(readFileSync(lock, 'utf8')).toBe(stolen);
    expect(existsSync(`${lock}.release-${process.pid}`)).toBe(false);
    cleanup();
  });

  it('keeps mutual exclusion when many waiters find the same dead lock', async () => {
    const { ctx, cleanup } = fakeMachine();
    mkdirSync(join(ctx.toolsDir, '.locks'), { recursive: true });
    writeFileSync(join(ctx.toolsDir, '.locks', 'x.lock'), `2147483646\n${Date.now()}\n`);
    let active = 0;
    let maxActive = 0;
    const real = { ...ctx, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 3))) };
    const one = (): Promise<void> =>
      withToolLock(real, 'x', async () => {
        maxActive = Math.max(maxActive, ++active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
      }, { pollMs: 2 });
    await Promise.all(Array.from({ length: 6 }, one));
    expect(maxActive).toBe(1);
    cleanup();
  });

  it('shuts down only the simulator cezar booted', async () => {
    const { ctx, calls, cleanup } = fakeMachine();
    const devices = JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
          { udid: 'U1', name: 'iPhone 16', state: 'Shutdown', isAvailable: true },
          { udid: 'U2', name: 'iPhone 16 Pro', state: 'Booted', isAvailable: true },
        ],
      },
    });
    const mac = asDarwin(ctx, async (command, args) => {
      calls.push(`${command} ${args.join(' ')}`);
      return { code: 0, stdout: args.includes('devices') ? devices : '', stderr: '' };
    });
    expect(await simulatorShutdown(mac, {})).toBeUndefined(); // nothing booted by us
    expect(calls).toEqual([]);
    // U2 is already booted by someone else: reused, so not recorded and not ours to stop
    expect((await simulatorBoot(mac, {})).reused).toBe(true);
    expect(await simulatorShutdown(mac, {})).toBeUndefined();
    // a device cezar boots itself is recorded and is the only one shut down
    const shut = devices.replace('"state":"Booted"', '"state":"Shutdown"');
    const mac2 = asDarwin(ctx, async (command, args) => {
      calls.push(`${command} ${args.join(' ')}`);
      return { code: 0, stdout: args.includes('devices') ? shut : '', stderr: '' };
    });
    expect((await simulatorBoot(mac2, {})).udid).toBe('U1');
    expect(await simulatorShutdown(mac2, {})).toBe('U1');
    expect(calls.filter((c) => c.includes('simctl shutdown'))).toEqual(['xcrun simctl shutdown U1']);
    cleanup();
  });

  it('prints only shell exports on stdout from ensure, so eval is safe, and status on stderr', async () => {
    const { ctx, cleanup } = fakeMachine();
    const out: string[] = [];
    const err: string[] = [];
    const code = await runToolsCommand(['ensure', 'flutter', '--shell', 'bash'], ctx, { log: (l) => out.push(l), error: (l) => err.push(l) });
    expect(code).toBe(0);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((l) => l.startsWith('export '))).toBe(true);
    expect(err.join('\n')).toContain('flutter');
    cleanup();
  });

  it('has no --install escape hatch: only the operator-controlled env var enables installs', async () => {
    const { ctx, urls, cleanup } = fakeMachine({ install: false });
    expect(await runToolsCommand(['ensure', 'flutter', '--install'], ctx, { log: () => undefined, error: () => undefined })).toBe(2);
    expect(urls).toEqual([]);
    cleanup();
  });
});
