/**
 * Every pinned download in one place (spec `.ai/specs/2026-10-21-tool-provisioning.md`).
 * Bumping a tool is an edit to this file only; the SHA-256s come from the vendor's download page.
 */

/** Android SDK command-line tools, build 15859902 (developer.android.com/studio#command-tools). */
export const ANDROID_CMDLINE_BUILD = '15859902';
export const ANDROID_CMDLINE_SHA256: Record<string, string> = {
  win: '90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a',
  mac_x86_64: 'c5a6378ab5cf7e0d5701921405115befff13e9ff7417fb588389338f8bd050f3',
  mac_arm64: '835b62a26162b229b441d1f6d4680383815a270809eb33522c0d480fa5002c4e',
  linux: '4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583',
};
export const androidCmdlineUrl = (flavor: string): string =>
  `https://dl.google.com/android/repository/commandlinetools-${flavor}-${ANDROID_CMDLINE_BUILD}_latest.zip`;

/**
 * Google's official repository manifests. The live install resolves the newest stable
 * command-line tools and API level from these (`android-manifest.ts`); the pins around here are
 * only the fallback when they cannot be fetched or parsed.
 */
export const ANDROID_REPOSITORY_BASE = 'https://dl.google.com/android/repository/';
export const ANDROID_REPOSITORY_MANIFEST = `${ANDROID_REPOSITORY_BASE}repository2-3.xml`;
export const ANDROID_SYSIMG_MANIFEST = `${ANDROID_REPOSITORY_BASE}sys-img/google_apis/sys-img2-3.xml`;

/** Fallback API level / build-tools when the manifest is unavailable. */
export const ANDROID_API_LEVEL = 35;
export const ANDROID_BUILD_TOOLS = '35.0.0';
/** The one AVD cezar creates and boots. */
export const AVD_NAME = 'cezar';

/**
 * Temurin 17 (sdkmanager needs >= 17). The Adoptium assets API names the newest 17 GA build with
 * its package link and SHA-256, so the download can be verified.
 */
export const JDK_MAJOR = 17;
export const jdkAssetsUrl = (os: 'windows' | 'mac' | 'linux', arch: 'x64' | 'aarch64'): string =>
  `https://api.adoptium.net/v3/assets/latest/${JDK_MAJOR}/hotspot?architecture=${arch}&image_type=jdk&os=${os}&vendor=eclipse`;

/** Flutter's official release manifests; the stable hash in `current_release` names the archive. */
export const FLUTTER_MANIFEST_BASE = 'https://storage.googleapis.com/flutter_infra_release/releases';

/** Generous caps: these are multi-hundred-MB downloads and image installs on slow links. */
export const INSTALL_TIMEOUT_MS = 45 * 60_000;
export const LOCK_STALE_MS = 60 * 60_000;
export const LOCK_WAIT_MS = 60 * 60_000;
export const EMULATOR_BOOT_TIMEOUT_MS = 6 * 60_000;
