import { INSTALL_TIMEOUT_MS } from './constants.ts';
import { withToolLock } from './lock.ts';
import { type ToolRecipe, type ToolsContext, findOnPath } from './runtime.ts';

/**
 * iOS Simulator (macOS only). Xcode itself cannot be installed unattended — it needs an Apple
 * ID and the App Store — so this recipe detects it, and with installs on only adds the missing
 * iOS simulator runtime (`xcodebuild -downloadPlatform iOS`, Xcode 14+).
 */

const NEEDS_XCODE =
  'Xcode is required and cezar cannot install it (App Store / developer.apple.com, Apple ID). ' +
  'Install it, then run: sudo xcode-select -s /Applications/Xcode.app && sudo xcodebuild -runFirstLaunch';

interface SimRuntime {
  identifier: string;
  name: string;
  version: string;
  isAvailable?: boolean;
}
export interface SimDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable?: boolean;
}

const versionKey = (v: string): number[] => v.split('.').map((n) => Number(n) || 0);
function compareVersions(a: string, b: string): number {
  const [x, y] = [versionKey(a), versionKey(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

export function iosRuntimes(listRuntimesJson: string): SimRuntime[] {
  try {
    const { runtimes } = JSON.parse(listRuntimesJson) as { runtimes?: SimRuntime[] };
    return (runtimes ?? [])
      .filter((r) => r.isAvailable !== false && /iOS/i.test(r.name))
      .sort((a, b) => compareVersions(b.version, a.version));
  } catch {
    return [];
  }
}

/** The booted iPhone if there is one, else the newest-runtime iPhone, else undefined (caller creates one). */
export function pickSimulator(listDevicesJson: string, wanted?: string): SimDevice | undefined {
  let devices: Record<string, SimDevice[]> = {};
  try {
    devices = (JSON.parse(listDevicesJson) as { devices?: Record<string, SimDevice[]> }).devices ?? {};
  } catch {
    return undefined;
  }
  const ios = Object.entries(devices)
    .filter(([runtime]) => /iOS/i.test(runtime))
    .sort(([a], [b]) => compareVersions(b.replace(/.*iOS-/, '').replace(/-/g, '.'), a.replace(/.*iOS-/, '').replace(/-/g, '.')))
    .flatMap(([, list]) => list.filter((d) => d.isAvailable !== false));
  if (wanted) return ios.find((d) => d.udid === wanted || d.name === wanted);
  const phones = ios.filter((d) => /iPhone/.test(d.name));
  return phones.find((d) => d.state === 'Booted') ?? phones[0];
}

const xcrun = (ctx: ToolsContext): string | undefined => findOnPath(ctx, 'xcrun');

export const iosSimulatorRecipe: ToolRecipe = {
  id: 'ios-simulator',
  title: 'iOS Simulator (Xcode)',
  requires: [],
  unsupported: (ctx) => (ctx.platform === 'darwin' ? undefined : 'the iOS Simulator only exists on macOS (with Xcode)'),
  async detect(ctx) {
    const bin = xcrun(ctx);
    if (!bin) return { installed: false, note: 'xcrun not found' };
    const result = await ctx.exec(bin, ['simctl', 'list', 'runtimes', '-j'], { timeoutMs: 60_000 });
    if (result.code !== 0) return { installed: false, note: 'Xcode is not installed or not selected (xcode-select)' };
    const runtime = iosRuntimes(result.stdout)[0];
    return runtime
      ? { installed: true, version: runtime.name, path: bin, source: 'system' }
      : { installed: false, path: bin, note: 'Xcode found but no iOS simulator runtime is installed' };
  },
  async install(ctx, env) {
    const bin = xcrun(ctx);
    const probe = bin ? await ctx.exec(bin, ['simctl', 'help'], { timeoutMs: 30_000 }) : undefined;
    if (!bin || probe?.code !== 0) throw new Error(NEEDS_XCODE);
    const download = await ctx.exec('xcodebuild', ['-downloadPlatform', 'iOS'], { env, timeoutMs: INSTALL_TIMEOUT_MS });
    if (download.code !== 0) throw new Error(`xcodebuild -downloadPlatform iOS failed: ${(download.stderr || download.stdout).trim().split('\n').pop()}`);
  },
  env: () => ({ path: [], vars: {} }),
  hint: () => NEEDS_XCODE,
};

async function simctl(ctx: ToolsContext, env: NodeJS.ProcessEnv, args: string[], timeoutMs = 120_000) {
  return ctx.exec('xcrun', ['simctl', ...args], { env, timeoutMs });
}

/** Boot an iPhone simulator (creating `cezar` from the newest runtime if none exists) and wait for it. */
export async function simulatorBoot(
  ctx: ToolsContext,
  env: NodeJS.ProcessEnv,
  options: { device?: string; timeoutMs?: number } = {},
): Promise<{ udid: string; name: string; reused: boolean }> {
  return withToolLock(ctx, 'ios-simulator-run', async () => {
    const listed = await simctl(ctx, env, ['list', 'devices', 'available', '-j']);
    if (listed.code !== 0) throw new Error(`simctl list failed: ${listed.stderr.trim()}`);
    let device = pickSimulator(listed.stdout, options.device);
    if (!device) {
      if (options.device) throw new Error(`no simulator named or identified ${options.device}`);
      const runtime = iosRuntimes((await simctl(ctx, env, ['list', 'runtimes', '-j'])).stdout)[0];
      if (!runtime) throw new Error('no iOS simulator runtime installed: run "cezar tools ensure ios-simulator" with CEZ_TOOL_INSTALL=1');
      const types = JSON.parse((await simctl(ctx, env, ['list', 'devicetypes', '-j'])).stdout) as { devicetypes: Array<{ identifier: string; name: string }> };
      const type = types.devicetypes.filter((t) => /^iPhone/.test(t.name)).pop();
      if (!type) throw new Error('no iPhone device type available');
      const created = await simctl(ctx, env, ['create', 'cezar', type.identifier, runtime.identifier]);
      if (created.code !== 0) throw new Error(`simctl create failed: ${created.stderr.trim()}`);
      device = { udid: created.stdout.trim(), name: 'cezar', state: 'Shutdown' };
    }
    const reused = device.state === 'Booted';
    if (!reused) {
      const boot = await simctl(ctx, env, ['boot', device.udid]);
      if (boot.code !== 0 && !/current state: Booted/i.test(boot.stderr)) throw new Error(`simctl boot failed: ${boot.stderr.trim()}`);
    }
    // `-b` boots if needed and blocks until the device is fully ready.
    const status = await simctl(ctx, env, ['bootstatus', device.udid, '-b'], options.timeoutMs ?? 5 * 60_000);
    if (status.code !== 0) throw new Error(`simulator did not finish booting: ${(status.stderr || status.stdout).trim()}`);
    return { udid: device.udid, name: device.name, reused };
  });
}

export async function simulatorShutdown(ctx: ToolsContext, env: NodeJS.ProcessEnv): Promise<void> {
  const result = await simctl(ctx, env, ['shutdown', 'all']);
  if (result.code !== 0 && !/current state: Shutdown/i.test(result.stderr)) throw new Error(`simctl shutdown failed: ${result.stderr.trim()}`);
}
