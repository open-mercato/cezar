import {
  ANDROID_API_LEVEL,
  ANDROID_BUILD_TOOLS,
  ANDROID_CMDLINE_SHA256,
  ANDROID_REPOSITORY_BASE,
  ANDROID_REPOSITORY_MANIFEST,
  ANDROID_SYSIMG_MANIFEST,
  androidCmdlineUrl,
} from './constants.ts';
import type { ToolsContext } from './runtime.ts';

/**
 * Resolve what to install from Google's own repository manifests instead of pins that rot: the
 * newest stable command-line tools (with the checksum Google publishes), and the newest stable API
 * level that has BOTH a platform and a google_apis system image for this CPU. The constants in
 * `constants.ts` stay as the offline / failed-fetch fallback, so a bad network degrades to a
 * known-good older install, never to a failed one.
 */

export interface AndroidPlan {
  /** Where the cmdline-tools zip comes from and how to verify it. */
  cmdline: { url: string; checksum: string; algo: 'sha1' | 'sha256' };
  apiLevel: number;
  buildTools: string;
  /** `manifest` when resolved live, `pinned` when the fallback constants were used. */
  source: 'manifest' | 'pinned';
}

interface Block {
  path: string;
  body: string;
}

/** The stable, non-obsolete `<remotePackage>` blocks (channel-0). A regex pass: no XML dependency. */
function stableBlocks(xml: string): Block[] {
  const blocks: Block[] = [];
  for (const match of xml.matchAll(/<remotePackage\b([^>]*)>([\s\S]*?)<\/remotePackage>/g)) {
    const attrs = match[1]!;
    const body = match[2]!;
    const path = /\bpath="([^"]+)"/.exec(attrs)?.[1];
    if (!path || /\bobsolete="true"/.test(attrs) || !/<channelRef ref="channel-0"\s*\/>/.test(body)) continue;
    blocks.push({ path, body });
  }
  return blocks;
}

export const cmdlineFlavor = (platform: NodeJS.Platform, arch: string): string =>
  platform === 'win32' ? 'win' : platform === 'darwin' ? (arch === 'arm64' ? 'mac_arm64' : 'mac_x86_64') : 'linux';

/** `cmdline-tools;latest` -> the zip for this host. */
export function parseCmdlineTools(xml: string, flavor: string): { url: string; sha1: string } | undefined {
  const block = stableBlocks(xml).find((b) => b.path === 'cmdline-tools;latest');
  if (!block) return undefined;
  for (const archive of block.body.matchAll(/<archive>([\s\S]*?)<\/archive>/g)) {
    const a = archive[1]!;
    const os = /<host-os>(\w+)<\/host-os>/.exec(a)?.[1];
    const arch = /<host-arch>(\w+)<\/host-arch>/.exec(a)?.[1];
    const host = os === 'windows' ? 'win' : os === 'linux' ? 'linux' : os === 'macosx' ? (arch === 'aarch64' ? 'mac_arm64' : 'mac_x86_64') : undefined;
    const sha1 = /<checksum type="sha1">([0-9a-f]+)<\/checksum>/.exec(a)?.[1];
    const file = /<url>([^<]+)<\/url>/.exec(a)?.[1];
    if (host === flavor && sha1 && file) return { url: `${ANDROID_REPOSITORY_BASE}${file}`, sha1 };
  }
  return undefined;
}

/** Plain integer API levels that have a stable `platforms;android-N` package (no `-extN`, no previews). */
export function parsePlatformLevels(xml: string): number[] {
  return stableBlocks(xml)
    .map((b) => /^platforms;android-(\d+)$/.exec(b.path)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
}

/** API levels with a stable google_apis system image for `abi`. */
export function parseSystemImageLevels(xml: string, abi: string): number[] {
  return stableBlocks(xml)
    .map((b) => new RegExp(`^system-images;android-(\\d+);google_apis;${abi}$`).exec(b.path)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
}

const versionParts = (v: string): number[] => v.split('.').map(Number);

/** Newest stable `build-tools;X.Y.Z` whose major is at most `apiLevel`. */
export function parseBuildTools(xml: string, apiLevel: number): string | undefined {
  const versions = stableBlocks(xml)
    .map((b) => /^build-tools;(\d+\.\d+\.\d+)$/.exec(b.path)?.[1])
    .filter((v): v is string => v !== undefined && versionParts(v)[0]! <= apiLevel);
  return versions.sort((a, b) => {
    const [x, y] = [versionParts(a), versionParts(b)];
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i]! - x[i]!;
    return 0;
  })[0];
}

export function planFromManifests(repositoryXml: string, sysImgXml: string, flavor: string, abi: string): AndroidPlan | undefined {
  const cmdline = parseCmdlineTools(repositoryXml, flavor);
  const images = new Set(parseSystemImageLevels(sysImgXml, abi));
  const apiLevel = parsePlatformLevels(repositoryXml)
    .filter((level) => images.has(level))
    .sort((a, b) => b - a)[0];
  const buildTools = apiLevel === undefined ? undefined : parseBuildTools(repositoryXml, apiLevel);
  if (!cmdline || apiLevel === undefined || !buildTools) return undefined;
  return { cmdline: { url: cmdline.url, checksum: cmdline.sha1, algo: 'sha1' }, apiLevel, buildTools, source: 'manifest' };
}

export function pinnedPlan(flavor: string): AndroidPlan {
  return {
    cmdline: { url: androidCmdlineUrl(flavor), checksum: ANDROID_CMDLINE_SHA256[flavor]!, algo: 'sha256' },
    apiLevel: ANDROID_API_LEVEL,
    buildTools: ANDROID_BUILD_TOOLS,
    source: 'pinned',
  };
}

const plans = new WeakMap<ToolsContext, Promise<AndroidPlan>>();

/** Once per context: the SDK and the emulator recipes must agree on the API level. Never throws. */
export function resolveAndroidPlan(ctx: ToolsContext, abi: string): Promise<AndroidPlan> {
  let plan = plans.get(ctx);
  if (!plan) {
    const flavor = cmdlineFlavor(ctx.platform, ctx.arch);
    plan = (async () => {
      try {
        const get = async (url: string): Promise<string> => {
          const response = await ctx.fetch(url, { signal: AbortSignal.timeout(30_000) });
          if (!response.ok) throw new Error(`${response.status}`);
          return response.text();
        };
        const [repository, sysimg] = await Promise.all([get(ANDROID_REPOSITORY_MANIFEST), get(ANDROID_SYSIMG_MANIFEST)]);
        const live = planFromManifests(repository, sysimg, flavor, abi);
        if (live) return live;
        ctx.log('Android repository manifest had no usable entry; using the pinned versions');
      } catch (error) {
        ctx.log(`could not read the Android repository manifest (${error instanceof Error ? error.message : String(error)}); using the pinned versions`);
      }
      return pinnedPlan(flavor);
    })();
    plans.set(ctx, plan);
  }
  return plan;
}
