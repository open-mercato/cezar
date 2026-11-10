#!/usr/bin/env node
// The mobile release version (RELEASING-MOBILE.md). One name, one integer code, for both stores.
//
//   node scripts/release-version.mjs [mobile-vX.Y.Z | X.Y.Z[-rc.N]]
//
// Without an argument it releases package.json's version. Prints key=value lines for
// $GITHUB_OUTPUT: name, code, marketing (X.Y.Z, what iOS accepts), prerelease (true|false).
// android/app/build.gradle computes the same code; the release check compares them on the APK.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/;

export function releaseVersion(input) {
  const name = String(input).replace(/^mobile-v/, '');
  const m = VERSION.exec(name);
  if (!m) throw new Error(`"${input}" is not X.Y.Z or X.Y.Z-rc.N`);
  const [major, minor, patch] = [m[1], m[2], m[3]].map(Number);
  const rc = m[4] === undefined ? undefined : Number(m[4]);
  if (major > 2099 || minor > 99 || patch > 99 || (rc !== undefined && (rc < 1 || rc > 98))) {
    throw new Error(`"${name}" is outside the versionCode scheme (minor and patch < 100, rc 1 to 98)`);
  }
  // A final release ends in 99, so every rc of a version sorts below it.
  const code = major * 1_000_000 + minor * 10_000 + patch * 100 + (rc ?? 99);
  return { name, code, marketing: `${major}.${minor}.${patch}`, prerelease: rc !== undefined };
}

export function packageVersion() {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const arg = process.argv[2];
    const v = releaseVersion(arg || packageVersion());
    // A tag must name the version package.json is at, apart from an rc suffix.
    if (arg && v.marketing !== releaseVersion(packageVersion()).marketing) {
      throw new Error(`${arg} does not match packages/mobile/package.json version ${packageVersion()}`);
    }
    for (const [k, val] of Object.entries(v)) console.log(`${k}=${val}`);
  } catch (err) {
    console.error(`release-version: ${err.message}`);
    process.exit(1);
  }
}
