import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FLUTTER_MANIFEST_BASE, INSTALL_TIMEOUT_MS } from './constants.ts';
import { ensureFlutterNdk } from './flutter-ndk.ts';
import {
  type ToolEnv,
  type ToolRecipe,
  type ToolsContext,
  batName,
  downloadFile,
  extractArchive,
  findOnPath,
  isFile,
  moveInto,
  singleRoot,
  withStaging,
} from './runtime.ts';

/**
 * Flutter, stable channel, from the official release archive (not a git clone: a shallow clone
 * has no tags, so `flutter --version` reports `0.0.0-unknown`). The manifest's `current_release`
 * names the stable hash; the archive carries its own sha256.
 */

interface FlutterRelease {
  hash: string;
  channel: string;
  version: string;
  archive: string;
  sha256: string;
  dart_sdk_arch?: string;
}
export interface FlutterManifest {
  base_url: string;
  current_release: { stable: string };
  releases: FlutterRelease[];
}

const flutterDir = (ctx: ToolsContext): string => join(ctx.toolsDir, 'flutter');
const flutterBin = (ctx: ToolsContext): string => join(flutterDir(ctx), 'bin', batName(ctx, 'flutter'));

const manifestName = (ctx: ToolsContext): string => (ctx.platform === 'win32' ? 'windows' : ctx.platform === 'darwin' ? 'macos' : 'linux');

/** The stable release for this machine. macOS ships separate arm64/x64 archives; the others one. */
export function pickFlutterRelease(manifest: FlutterManifest, arch: string): { url: string; sha256: string; version: string } | undefined {
  const wantArm = arch === 'arm64';
  const candidates = manifest.releases.filter((r) => r.hash === manifest.current_release.stable && r.channel === 'stable');
  const release =
    candidates.find((r) => (r.dart_sdk_arch ? r.dart_sdk_arch === (wantArm ? 'arm64' : 'x64') : r.archive.includes('arm64') === wantArm)) ??
    (candidates.length === 1 ? candidates[0] : undefined);
  return release ? { url: `${manifest.base_url}/${release.archive}`, sha256: release.sha256, version: release.version } : undefined;
}

export const flutterRecipe: ToolRecipe = {
  id: 'flutter',
  title: 'Flutter SDK (stable)',
  requires: [],
  unsupported: (ctx) => (['win32', 'darwin', 'linux'].includes(ctx.platform) ? undefined : `no Flutter SDK for ${ctx.platform}`),
  async detect(ctx) {
    const managed = flutterBin(ctx);
    if (isFile(managed)) {
      let version: string | undefined;
      try {
        version = (JSON.parse(readFileSync(join(flutterDir(ctx), 'bin', 'cache', 'flutter.version.json'), 'utf8')) as { flutterVersion?: string }).flutterVersion;
      } catch {
        // not yet run once; the version is cosmetic
      }
      return { installed: true, version, path: managed, source: 'cezar' };
    }
    const system = findOnPath(ctx, 'flutter');
    if (!system) return { installed: false, note: 'flutter is not on PATH' };
    const result = await ctx.exec(system, ['--version'], { timeoutMs: 60_000 });
    return { installed: true, version: /Flutter (\S+)/.exec(result.stdout)?.[1], path: system, source: 'system' };
  },
  async install(ctx, env) {
    const response = await ctx.fetch(`${FLUTTER_MANIFEST_BASE}/releases_${manifestName(ctx)}.json`);
    if (!response.ok) throw new Error(`Flutter release manifest unavailable (${response.status})`);
    const release = pickFlutterRelease((await response.json()) as FlutterManifest, ctx.arch);
    if (!release) throw new Error(`no stable Flutter archive for ${ctx.platform}/${ctx.arch}`);
    ctx.log(`installing Flutter ${release.version}`);
    await withStaging(ctx, 'flutter', async (staging) => {
      const archive = join(staging, release.url.endsWith('.zip') ? 'flutter.zip' : 'flutter.tar.xz');
      await downloadFile(ctx, release.url, archive, release.sha256);
      const out = join(staging, 'out');
      await extractArchive(ctx, archive, out);
      await moveInto(singleRoot(out), flutterDir(ctx));
    });
    // First run fetches Dart and the engine; do it now so tests do not pay for it. A failure here
    // (offline mid-way) only defers the download to the first real `flutter` call.
    const precache = await ctx.exec(flutterBin(ctx), ['precache', '--android', ...(ctx.platform === 'darwin' ? ['--ios'] : [])], {
      env,
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    if (precache.code !== 0) ctx.log(`flutter precache did not finish (${precache.stderr.trim().split('\n').pop() ?? precache.code}); it will retry on first use`);
    const doctor = await ctx.exec(flutterBin(ctx), ['doctor'], { env, timeoutMs: 5 * 60_000 });
    if (doctor.stdout.trim()) ctx.log(`flutter doctor:\n${doctor.stdout.trim()}`);
  },
  async finish(ctx, env) {
    await ensureFlutterNdk(ctx, env);
  },
  env(ctx): ToolEnv {
    return isFile(flutterBin(ctx))
      ? { path: [join(flutterDir(ctx), 'bin')], vars: { FLUTTER_ROOT: flutterDir(ctx) } }
      : { path: [], vars: {} };
  },
  hint: (ctx) => (ctx.platform === 'darwin' ? 'brew install --cask flutter' : 'see https://docs.flutter.dev/get-started/install'),
};
