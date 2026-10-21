import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cmdlineTool, sdkRoot, sdkmanager } from './android.ts';
import { ANDROID_NDK_FALLBACK } from './constants.ts';
import { withToolLock } from './lock.ts';
import { type ToolsContext, findOnPath, isFile } from './runtime.ts';

/**
 * Flutter's Gradle plugin builds with one specific NDK and tries to fetch it itself, which fails
 * on a fresh SDK (observed on Windows: "sdkmanager did not install NDK"). So once a Flutter SDK
 * and an Android SDK both exist, install the NDK that Flutter release asks for — read from the
 * installed Flutter, so it follows the release instead of a pin that rots — with sdkmanager, which
 * verifies the package checksum.
 */

/** Where a Flutter release declares its default NDK: Kotlin plugin first, the older Groovy one after. */
const NDK_SOURCES = [
  join('packages', 'flutter_tools', 'gradle', 'src', 'main', 'kotlin', 'FlutterExtension.kt'),
  join('packages', 'flutter_tools', 'gradle', 'src', 'main', 'groovy', 'flutter.groovy'),
];

/** `val ndkVersion: String = "28.2.13676358"` (Kotlin) or `String ndkVersion = "…"` (Groovy). */
export function parseNdkVersion(source: string): string | undefined {
  return /\bndkVersion\b[^=\n]*=\s*"(\d+\.\d+\.\d+)"/.exec(source)?.[1];
}

/** The Flutter SDK root: cezar's own, else the one on PATH (`<root>/bin/flutter`). */
export function flutterRoot(ctx: ToolsContext): string | undefined {
  const managed = join(ctx.toolsDir, 'flutter');
  if (isFile(join(managed, 'bin', ctx.platform === 'win32' ? 'flutter.bat' : 'flutter'))) return managed;
  const onPath = findOnPath(ctx, 'flutter');
  return onPath ? dirname(dirname(onPath)) : undefined;
}

export function flutterNdkVersion(root: string): string {
  for (const file of NDK_SOURCES) {
    try {
      const version = parseNdkVersion(readFileSync(join(root, file), 'utf8'));
      if (version) return version;
    } catch {
      // not in this Flutter release; try the next layout
    }
  }
  return ANDROID_NDK_FALLBACK;
}

/**
 * Install Flutter's NDK into the Android SDK if both exist and it is missing. A no-op (and cheap:
 * two stats) otherwise, so every `ensure` can call it. Returns the version it installed, if any.
 */
export async function ensureFlutterNdk(ctx: ToolsContext, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const flutter = flutterRoot(ctx);
  const sdk = sdkRoot(ctx);
  if (!flutter || !sdk || !cmdlineTool(ctx, sdk, 'sdkmanager')) return undefined;
  const version = flutterNdkVersion(flutter);
  const present = (): boolean => isFile(join(sdk, 'ndk', version, 'source.properties'));
  if (present()) return undefined;
  // Both recipes' `finish` land here, in this or a sibling process: one install, the rest re-check.
  return withToolLock(ctx, 'flutter-ndk', async () => {
    if (present()) return undefined;
    ctx.log(`installing the Android NDK ${version} that Flutter builds with`);
    await sdkmanager(ctx, env, sdk, ['--install', `ndk;${version}`]);
    return version;
  });
}
