import { existsSync, readdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ANDROID_API_LEVEL,
  ANDROID_BUILD_TOOLS,
  ANDROID_CMDLINE_SHA256,
  AVD_NAME,
  EMULATOR_BOOT_TIMEOUT_MS,
  INSTALL_TIMEOUT_MS,
  androidCmdlineUrl,
} from './constants.ts';
import { withToolLock } from './lock.ts';
import {
  type ToolEnv,
  type ToolRecipe,
  type ToolsContext,
  batName,
  downloadFile,
  exeName,
  extractArchive,
  isDir,
  isFile,
  moveInto,
  withStaging,
} from './runtime.ts';

/** Android SDK (cmdline-tools + platform-tools + platform) and a headless `cezar` AVD. */

export const managedSdkRoot = (ctx: ToolsContext): string => join(ctx.toolsDir, 'android-sdk');
/** The AVD lives under cezar's tools dir so creating it never touches the user's own `~/.android/avd`. */
export const avdHome = (ctx: ToolsContext): string => join(ctx.toolsDir, 'android-avd');

const hasAdb = (ctx: ToolsContext, root: string): boolean => isFile(join(root, 'platform-tools', exeName(ctx, 'adb')));

/**
 * The SDK to use: one the user already has (ANDROID_HOME / ANDROID_SDK_ROOT / Android Studio's
 * default location) wins over cezar's own, because it is what they pointed their machine at.
 * `managedOnly` is the agent-launch path, which must not change a run for anyone who never
 * installed anything through cezar.
 */
export function sdkRoot(ctx: ToolsContext, managedOnly = false): string | undefined {
  const system = managedOnly
    ? []
    : [
        ctx.env.ANDROID_HOME,
        ctx.env.ANDROID_SDK_ROOT,
        ctx.platform === 'darwin' ? join(ctx.home, 'Library', 'Android', 'sdk') : undefined,
        ctx.platform === 'linux' ? join(ctx.home, 'Android', 'Sdk') : undefined,
        ctx.platform === 'win32' ? join(ctx.env.LOCALAPPDATA ?? join(ctx.home, 'AppData', 'Local'), 'Android', 'Sdk') : undefined,
      ].filter((p): p is string => Boolean(p));
  return [...system, managedSdkRoot(ctx)].find((root) => hasAdb(ctx, root));
}

/** `cmdline-tools/latest/bin/<tool>`, or any versioned sibling Android Studio installed. */
export function cmdlineTool(ctx: ToolsContext, root: string, tool: 'sdkmanager' | 'avdmanager'): string | undefined {
  const base = join(root, 'cmdline-tools');
  let versions: string[] = [];
  try {
    versions = readdirSync(base).sort((a, b) => (a === 'latest' ? -1 : b === 'latest' ? 1 : b.localeCompare(a)));
  } catch {
    return undefined;
  }
  return versions.map((v) => join(base, v, 'bin', batName(ctx, tool))).find(isFile);
}

export const systemImageAbi = (ctx: ToolsContext): string => (ctx.arch === 'arm64' ? 'arm64-v8a' : 'x86_64');
const imagePackage = (ctx: ToolsContext): string => `system-images;android-${ANDROID_API_LEVEL};google_apis;${systemImageAbi(ctx)}`;

function sdkSource(ctx: ToolsContext, root: string): 'cezar' | 'system' {
  return root === managedSdkRoot(ctx) ? 'cezar' : 'system';
}

async function sdkmanager(ctx: ToolsContext, env: NodeJS.ProcessEnv, root: string, args: string[]): Promise<void> {
  const bin = cmdlineTool(ctx, root, 'sdkmanager');
  if (!bin) throw new Error(`sdkmanager not found under ${root}`);
  // `--licenses` and first installs prompt on stdin; a pile of "y" is the portable `yes |`.
  const result = await ctx.exec(bin, [`--sdk_root=${root}`, ...args], { env, input: 'y\n'.repeat(80), timeoutMs: INSTALL_TIMEOUT_MS });
  if (result.code !== 0) throw new Error(`sdkmanager ${args[0]} failed: ${(result.stderr || result.stdout).trim().split('\n').slice(-3).join(' | ')}`);
}

export const androidSdkRecipe: ToolRecipe = {
  id: 'android-sdk',
  title: `Android SDK (platform-tools, API ${ANDROID_API_LEVEL})`,
  requires: ['jdk'],
  unsupported: () => undefined,
  async detect(ctx) {
    const root = sdkRoot(ctx);
    if (!root) return { installed: false, note: 'no Android SDK found' };
    const platforms = isDir(join(root, 'platforms')) ? readdirSync(join(root, 'platforms')).filter((n) => n.startsWith('android-')) : [];
    const manager = cmdlineTool(ctx, root, 'sdkmanager');
    const missing = [!manager && 'cmdline-tools', platforms.length === 0 && 'a platform'].filter(Boolean);
    return missing.length
      ? { installed: false, path: root, source: sdkSource(ctx, root), note: `SDK at ${root} lacks ${missing.join(' and ')}` }
      : { installed: true, version: platforms.sort().pop(), path: root, source: sdkSource(ctx, root) };
  },
  async install(ctx, env) {
    const root = sdkRoot(ctx) ?? managedSdkRoot(ctx);
    if (!cmdlineTool(ctx, root, 'sdkmanager')) {
      const flavor = ctx.platform === 'win32' ? 'win' : ctx.platform === 'darwin' ? (ctx.arch === 'arm64' ? 'mac_arm64' : 'mac_x86_64') : 'linux';
      await withStaging(ctx, 'android-cmdline-tools', async (staging) => {
        const archive = join(staging, 'cmdline-tools.zip');
        await downloadFile(ctx, androidCmdlineUrl(flavor), archive, ANDROID_CMDLINE_SHA256[flavor]);
        const out = join(staging, 'out');
        await extractArchive(ctx, archive, out);
        // sdkmanager insists on `cmdline-tools/<version>/`; the zip's own folder is unversioned.
        await moveInto(join(out, 'cmdline-tools'), join(root, 'cmdline-tools', 'latest'));
      });
    }
    await sdkmanager(ctx, env, root, ['--licenses']);
    await sdkmanager(ctx, env, root, ['--install', 'platform-tools', `platforms;android-${ANDROID_API_LEVEL}`, `build-tools;${ANDROID_BUILD_TOOLS}`]);
  },
  env(ctx, managedOnly): ToolEnv {
    const root = sdkRoot(ctx, managedOnly);
    if (!root) return { path: [], vars: {} };
    const dirs = [
      join(root, 'platform-tools'),
      join(root, 'emulator'),
      ...(cmdlineTool(ctx, root, 'sdkmanager') ? [join(root, 'cmdline-tools', 'latest', 'bin')] : []),
    ];
    return { path: dirs.filter(existsSync), vars: { ANDROID_HOME: root, ANDROID_SDK_ROOT: root } };
  },
  hint: () => 'install Android Studio (https://developer.android.com/studio) and set ANDROID_HOME',
};

export const androidEmulatorRecipe: ToolRecipe = {
  id: 'android-emulator',
  title: `Android emulator + AVD "${AVD_NAME}"`,
  requires: ['android-sdk'],
  unsupported: (ctx) => (ctx.platform === 'win32' && ctx.arch === 'arm64' ? 'the Android emulator does not run on Windows for ARM' : undefined),
  async detect(ctx) {
    const root = sdkRoot(ctx);
    if (!root) return { installed: false, note: 'no Android SDK found' };
    const missing = [
      !isFile(join(root, 'emulator', exeName(ctx, 'emulator'))) && 'emulator',
      !isDir(join(root, 'system-images', `android-${ANDROID_API_LEVEL}`, 'google_apis', systemImageAbi(ctx))) && 'system image',
      !isFile(join(avdHome(ctx), `${AVD_NAME}.ini`)) && `AVD "${AVD_NAME}"`,
    ].filter(Boolean);
    return missing.length
      ? { installed: false, path: root, note: `missing ${missing.join(', ')}` }
      : { installed: true, version: `android-${ANDROID_API_LEVEL}`, path: join(avdHome(ctx), `${AVD_NAME}.ini`), source: sdkSource(ctx, root) };
  },
  async install(ctx, env) {
    const root = sdkRoot(ctx) ?? managedSdkRoot(ctx);
    await sdkmanager(ctx, env, root, ['--install', 'emulator', imagePackage(ctx)]);
    if (isFile(join(avdHome(ctx), `${AVD_NAME}.ini`))) return;
    const avdmanager = cmdlineTool(ctx, root, 'avdmanager');
    if (!avdmanager) throw new Error(`avdmanager not found under ${root}`);
    await mkdir(avdHome(ctx), { recursive: true });
    // "Do you wish to create a custom hardware profile?" -> no.
    const result = await ctx.exec(avdmanager, ['create', 'avd', '--force', '-n', AVD_NAME, '-k', imagePackage(ctx), '-d', 'pixel_6'], {
      env: { ...env, ANDROID_AVD_HOME: avdHome(ctx), ANDROID_SDK_ROOT: root },
      input: 'no\n',
      timeoutMs: 5 * 60_000,
    });
    if (result.code !== 0) throw new Error(`avdmanager create avd failed: ${(result.stderr || result.stdout).trim()}`);
  },
  env(ctx): ToolEnv {
    return isFile(join(avdHome(ctx), `${AVD_NAME}.ini`)) ? { path: [], vars: { ANDROID_AVD_HOME: avdHome(ctx) } } : { path: [], vars: {} };
  },
  hint: () => 'create an AVD in Android Studio, or run with CEZ_TOOL_INSTALL=1',
};

/** `adb devices` -> serials of emulators that are online. */
export function parseEmulators(adbDevices: string): string[] {
  return [...adbDevices.matchAll(/^(emulator-\d+)\s+device\b/gm)].map((m) => m[1]!);
}

function adbPath(ctx: ToolsContext): string {
  const root = sdkRoot(ctx);
  const adb = root && join(root, 'platform-tools', exeName(ctx, 'adb'));
  if (!adb || !isFile(adb)) throw new Error('adb not found: run "cezar tools ensure android-sdk"');
  return adb;
}

async function bootCompleted(ctx: ToolsContext, adb: string, env: NodeJS.ProcessEnv, serial: string): Promise<boolean> {
  const result = await ctx.exec(adb, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], { env, timeoutMs: 15_000 });
  return result.stdout.trim() === '1';
}

/**
 * Boot the `cezar` AVD headless and wait until Android finished booting. Idempotent: a booted
 * emulator that is already running (this agent's or a sibling's) is reused, and the run-lock
 * keeps two parallel agents from starting two. `env` is the composed tools env.
 */
export async function emulatorStart(
  ctx: ToolsContext,
  env: NodeJS.ProcessEnv,
  options: { port?: number; timeoutMs?: number } = {},
): Promise<{ serial: string; reused: boolean }> {
  const adb = adbPath(ctx);
  const root = sdkRoot(ctx)!;
  const timeoutMs = options.timeoutMs ?? EMULATOR_BOOT_TIMEOUT_MS;
  return withToolLock(ctx, 'android-emulator-run', async () => {
    await ctx.exec(adb, ['start-server'], { env, timeoutMs: 30_000 });
    const list = await ctx.exec(adb, ['devices'], { env, timeoutMs: 15_000 });
    for (const serial of parseEmulators(list.stdout)) {
      if (await bootCompleted(ctx, adb, env, serial)) return { serial, reused: true };
    }
    const port = options.port ?? 5554;
    const serial = `emulator-${port}`;
    if (ctx.platform === 'linux' && ctx.arch === 'x64' && !existsSync('/dev/kvm')) {
      ctx.log('warning: /dev/kvm is not available; the emulator will be extremely slow or refuse to start');
    }
    const logFile = join(ctx.toolsDir, 'logs', 'android-emulator.log');
    ctx.log(`starting emulator ${AVD_NAME} on port ${port} (log: ${logFile})`);
    ctx.spawnDetached(
      join(root, 'emulator', exeName(ctx, 'emulator')),
      ['-avd', AVD_NAME, '-port', String(port), '-no-window', '-no-audio', '-no-snapshot-save', '-no-boot-anim', '-gpu', 'swiftshader_indirect'],
      { env, logFile },
    );
    const started = Date.now();
    const wait = await ctx.exec(adb, ['-s', serial, 'wait-for-device'], { env, timeoutMs });
    if (wait.code !== 0) throw new Error(`emulator never connected to adb within ${Math.round(timeoutMs / 1000)}s (see ${logFile})`);
    while (!(await bootCompleted(ctx, adb, env, serial))) {
      if (Date.now() - started > timeoutMs) throw new Error(`emulator did not finish booting within ${Math.round(timeoutMs / 1000)}s (see ${logFile})`);
      await ctx.sleep(2_000);
    }
    return { serial, reused: false };
  });
}

export async function emulatorStop(ctx: ToolsContext, env: NodeJS.ProcessEnv): Promise<string[]> {
  const adb = adbPath(ctx);
  const serials = parseEmulators((await ctx.exec(adb, ['devices'], { env, timeoutMs: 15_000 })).stdout);
  for (const serial of serials) await ctx.exec(adb, ['-s', serial, 'emu', 'kill'], { env, timeoutMs: 30_000 });
  return serials;
}
