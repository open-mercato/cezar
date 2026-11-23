import * as nodePath from 'node:path';

/** Platform facts the restricted Codex profile depends on, injectable so every OS can test every branch (#2368). */
export interface RestrictedPlatform {
  readonly os: NodeJS.Platform;
  readonly path: typeof nodePath.posix;
}

export function currentRestrictedPlatform(): RestrictedPlatform {
  return { os: process.platform, path: process.platform === 'win32' ? nodePath.win32 : nodePath.posix };
}

export const WINDOWS_PLATFORM: RestrictedPlatform = { os: 'win32', path: nodePath.win32 };
export const LINUX_PLATFORM: RestrictedPlatform = { os: 'linux', path: nodePath.posix };

export function restrictedPlatformSupported(platform: RestrictedPlatform): boolean {
  return platform.os === 'darwin' || platform.os === 'linux' || platform.os === 'win32';
}

/** The `platformOs` Codex must report for this host; undefined = unsupported. */
export function expectedCodexPlatformOs(platform: RestrictedPlatform): 'macos' | 'linux' | 'windows' | undefined {
  return platform.os === 'darwin' ? 'macos' : platform.os === 'linux' ? 'linux' : platform.os === 'win32' ? 'windows' : undefined;
}

/** Same-location test: win32 paths are case-insensitive, separator-agnostic and may carry a `\\?\` prefix. */
export function samePath(platform: RestrictedPlatform, a: string, b: string): boolean {
  if (platform.os !== 'win32') return platform.path.resolve(a) === platform.path.resolve(b);
  const norm = (p: string): string => platform.path.resolve(p.replace(/^\\\\\?\\(?=[A-Za-z]:)/, '')).toLowerCase();
  return norm(a) === norm(b);
}
