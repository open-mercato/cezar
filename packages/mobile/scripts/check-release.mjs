#!/usr/bin/env node
// Checks a built Android release before it leaves the machine (RELEASING-MOBILE.md):
//
//   node scripts/check-release.mjs --name 0.1.0 [--signed] [--apk P] [--aab P]
//
// The version is the one scripts/release-version.mjs gives; R8 ran (mapping.txt); the manifest is not
// debuggable and allows no cleartext; the network config keeps no debug-overrides and allows cleartext
// only to loopback; with --signed, both files verify. Needs ANDROID_HOME (aapt2, apksigner) and a JDK.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { packageVersion, releaseVersion } from './release-version.mjs';

// The only host a release may reach over cleartext: the relay's loopback proxy (#1901).
const CLEARTEXT_ALLOWED = new Set(['127.0.0.1']);

/** From `aapt2 dump xmltree` of a network security config: is cleartext on by default, and for which hosts. */
export function cleartextRules(xmltree) {
  const on = (block) => /^\s*A: (?:\S+:)?cleartextTrafficPermitted(?:\(0x[0-9a-f]+\))?=(?:true|\(type 0x12\)0xffffffff)\s*$/m.test(block.split(/\n(?=\s*E: )/).slice(0, 1).join(''));
  const blocks = xmltree.split(/\n(?=\s*E: (?:base-config|domain-config))/);
  const base = blocks.some((b) => /^\s*E: base-config/.test(b) && on(b));
  const hosts = blocks.filter((b) => /^\s*E: domain-config/.test(b) && on(b)).flatMap((b) => [...b.matchAll(/T: '([^']+)'/g)].map((m) => m[1]));
  return { base, hosts };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

function main() {
  const OUT = new URL('../android/app/build/outputs/', import.meta.url).pathname;
  const { values: opts } = parseArgs({
    options: {
      name: { type: 'string' },
      signed: { type: 'boolean', default: false },
      // Gradle names the APK app-release-unsigned.apk when no upload key was given.
      apk: { type: 'string', default: ['app-release.apk', 'app-release-unsigned.apk'].map((f) => join(OUT, 'apk/release', f)).find((p) => existsSync(p)) ?? join(OUT, 'apk/release/app-release.apk') },
      aab: { type: 'string', default: join(OUT, 'bundle/release/app-release.aab') },
      mapping: { type: 'string', default: join(OUT, 'mapping/release/mapping.txt') },
    },
  });

  const failures = [];
  const check = (ok, what) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok) failures.push(what);
  };

  function buildTool(name) {
    const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
    if (!sdk) throw new Error('ANDROID_HOME is not set');
    const dir = join(sdk, 'build-tools');
    const latest = readdirSync(dir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
    return join(dir, latest, name);
  }
  const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20 });
  const aapt2 = (...args) => run(buildTool('aapt2'), args);

  const expected = releaseVersion(opts.name ?? packageVersion());
  check(existsSync(opts.apk), `APK exists: ${opts.apk}`);
  check(existsSync(opts.aab), `AAB exists: ${opts.aab}`);
  check(existsSync(opts.mapping), 'R8 ran: mapping.txt exists');
  if (failures.length) finish();

  const badging = aapt2('dump', 'badging', opts.apk);
  check(badging.includes(`versionCode='${expected.code}'`), `versionCode is ${expected.code}`);
  check(badging.includes(`versionName='${expected.name}'`), `versionName is ${expected.name}`);
  check(!/application-debuggable/.test(badging), 'not debuggable');
  check(!/testOnly/.test(badging), 'not testOnly');

  const manifest = aapt2('dump', 'xmltree', '--file', 'AndroidManifest.xml', opts.apk);
  check(!/:debuggable\(0x[0-9a-f]+\)=(true|\(type 0x12\)0xffffffff)/.test(manifest), 'manifest sets no debuggable=true');
  check(!/:usesCleartextTraffic\(0x[0-9a-f]+\)=(true|\(type 0x12\)0xffffffff)/.test(manifest), 'manifest sets no usesCleartextTraffic=true');

  // Debug-only code (src/debug) must reach neither the manifest nor the dex: R8's mapping lists every class kept.
  const debugDir = new URL('../android/app/src/debug/java/', import.meta.url).pathname;
  const debugClasses = existsSync(debugDir)
    ? readdirSync(debugDir, { recursive: true }).filter((f) => f.endsWith('.java')).map((f) => f.replace(/\.java$/, '').replaceAll('/', '.'))
    : [];
  const mapping = readFileSync(opts.mapping, 'utf8');
  const leaked = debugClasses.filter((c) => manifest.includes(c) || mapping.includes(`\n${c} -> `) || mapping.startsWith(`${c} -> `));
  check(leaked.length === 0, `no debug-only class in the release (${debugClasses.length} checked${leaked.length ? `; leaked: ${leaked.join(', ')}` : ''})`);

  const nscId = /networkSecurityConfig\(0x[0-9a-f]+\)=@(0x[0-9a-f]+)/.exec(manifest)?.[1];
  check(Boolean(nscId), 'manifest names a network security config');
  if (nscId) {
    // Release resources are renamed by R8, so find the file through the resource table.
    const table = aapt2('dump', 'resources', opts.apk);
    const entry = table.split('\n').findIndex((l) => l.includes(`resource ${nscId} `));
    const file = /\(\)\s+\(file\)\s+(\S+)/.exec(table.split('\n').slice(entry, entry + 3).join('\n'))?.[1];
    check(Boolean(file), `network security config file found (${file})`);
    if (file) {
      const nsc = aapt2('dump', 'xmltree', '--file', file, opts.apk);
      check(!nsc.includes('debug-overrides'), 'network config has no debug-overrides');
      check(!/certificates[\s\S]*?src[^\n]*"user"/.test(nsc), 'network config trusts no user CAs');
      const { base, hosts } = cleartextRules(nsc);
      check(!base && hosts.every((h) => CLEARTEXT_ALLOWED.has(h)), `cleartext only to loopback (found: ${base ? 'base-config' : hosts.join(', ') || 'none'})`);
    }
  }

  if (opts.signed) {
    let apkOk = true;
    try { run(buildTool('apksigner'), ['verify', opts.apk]); } catch { apkOk = false; }
    check(apkOk, 'APK signature verifies');
    const jarsigner = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', 'jarsigner') : 'jarsigner';
    let aab = '';
    try { aab = run(jarsigner, ['-verify', opts.aab]); } catch (err) { aab = String(err.stdout ?? ''); }
    check(/jar verified/.test(aab), 'AAB signature verifies');
  }
  finish();

  function finish() {
    if (failures.length) {
      console.error(`\ncheck-release: ${failures.length} check(s) failed`);
      process.exit(1);
    }
    console.log('\ncheck-release: release build is clean');
    process.exit(0);
  }
}

