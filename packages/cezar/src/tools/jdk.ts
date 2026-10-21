import { join } from 'node:path';
import { JDK_MAJOR, jdkAssetsUrl } from './constants.ts';
import {
  type ToolEnv,
  type ToolRecipe,
  type ToolsContext,
  downloadFile,
  exeName,
  extractArchive,
  findOnPath,
  isFile,
  moveInto,
  singleRoot,
  withStaging,
} from './runtime.ts';

/** Temurin 17, needed by the Android `sdkmanager`/`avdmanager` (and by Gradle builds Flutter drives). */

const jdkDir = (ctx: ToolsContext): string => join(ctx.toolsDir, 'jdk');

/** macOS archives nest the JDK under `Contents/Home`; the others unpack it flat. */
export function managedJavaHome(ctx: ToolsContext): string | undefined {
  const dir = jdkDir(ctx);
  return [join(dir, 'Contents', 'Home'), dir].find((home) => isFile(join(home, 'bin', exeName(ctx, 'java'))));
}

/** `openjdk version "17.0.9"` / legacy `"1.8.0_392"` -> 17 / 8. */
export function javaMajor(banner: string): number | undefined {
  const match = /version "(\d+)(?:\.(\d+))?/.exec(banner);
  if (!match) return undefined;
  const major = Number(match[1]);
  return major === 1 ? Number(match[2]) : major;
}

/** First JDK package (link + sha256) in an Adoptium `assets/latest` answer. */
export function pickJdkPackage(assets: unknown): { link: string; checksum: string } | undefined {
  for (const asset of Array.isArray(assets) ? assets : []) {
    const pkg = (asset as { binary?: { image_type?: string; package?: { link?: string; checksum?: string } } }).binary;
    if (pkg?.image_type === 'jdk' && pkg.package?.link && pkg.package.checksum) return { link: pkg.package.link, checksum: pkg.package.checksum };
  }
  return undefined;
}

function target(ctx: ToolsContext): { os: 'windows' | 'mac' | 'linux'; arch: 'x64' | 'aarch64' } | undefined {
  const os = ctx.platform === 'win32' ? 'windows' : ctx.platform === 'darwin' ? 'mac' : ctx.platform === 'linux' ? 'linux' : undefined;
  const arch = ctx.arch === 'x64' ? 'x64' : ctx.arch === 'arm64' ? 'aarch64' : undefined;
  return os && arch && !(os === 'windows' && arch === 'aarch64') ? { os, arch } : undefined;
}

export const jdkRecipe: ToolRecipe = {
  id: 'jdk',
  title: `JDK ${JDK_MAJOR} (Temurin)`,
  requires: [],
  unsupported: (ctx) => (target(ctx) ? undefined : `no Temurin ${JDK_MAJOR} build for ${ctx.platform}/${ctx.arch}`),
  async detect(ctx) {
    const managed = managedJavaHome(ctx);
    const java = exeName(ctx, 'java');
    const candidates: Array<[string | undefined, 'cezar' | 'system']> = [
      [managed && join(managed, 'bin', java), 'cezar'],
      [ctx.env.JAVA_HOME ? join(ctx.env.JAVA_HOME, 'bin', java) : undefined, 'system'],
      [findOnPath(ctx, 'java'), 'system'],
    ];
    for (const [path, source] of candidates) {
      if (!path || !isFile(path)) continue;
      const result = await ctx.exec(path, ['-version'], { timeoutMs: 20_000 });
      const banner = `${result.stderr}\n${result.stdout}`;
      const major = result.code === 0 ? javaMajor(banner) : undefined;
      if (major !== undefined && major >= JDK_MAJOR) {
        return { installed: true, version: /version "([^"]+)"/.exec(banner)?.[1], path, source };
      }
    }
    return { installed: false, note: `no JDK ${JDK_MAJOR}+ found` };
  },
  async install(ctx) {
    const t = target(ctx)!;
    const ext = t.os === 'windows' ? 'zip' : 'tar.gz';
    const response = await ctx.fetch(jdkAssetsUrl(t.os, t.arch));
    if (!response.ok) throw new Error(`Adoptium assets API unavailable (${response.status})`);
    const pkg = pickJdkPackage(await response.json());
    if (!pkg) throw new Error(`Adoptium lists no JDK ${JDK_MAJOR} for ${t.os}/${t.arch}`);
    await withStaging(ctx, 'jdk', async (staging) => {
      const archive = join(staging, `jdk.${ext}`);
      await downloadFile(ctx, pkg.link, archive, pkg.checksum);
      const out = join(staging, 'out');
      await extractArchive(ctx, archive, out);
      await moveInto(singleRoot(out), jdkDir(ctx));
    });
  },
  env(ctx): ToolEnv {
    const home = managedJavaHome(ctx);
    return home ? { path: [join(home, 'bin')], vars: { JAVA_HOME: home } } : { path: [], vars: {} };
  },
  hint: (ctx) =>
    ctx.platform === 'darwin'
      ? 'brew install --cask temurin@17'
      : ctx.platform === 'win32'
        ? 'winget install EclipseAdoptium.Temurin.17.JDK'
        : 'install openjdk-17-jdk (apt) or java-17-openjdk (dnf)',
};
