// Isolated native regression harness: use the desktop's actual resolved Rustls,
// without linking the Tauri GUI or changing its dependency graph (#2393).
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const desktop = fileURLToPath(new URL('../', import.meta.url));
const harness = join(desktop, 'test/rustls-security');

/** name → every version a Cargo.lock resolves for it. */
function lockVersions(path) {
  const versions = new Map();
  for (const [, name, version] of readFileSync(path, 'utf8').matchAll(
    /\[\[package\]\]\r?\nname = "([^"]+)"\r?\nversion = "([^"]+)"/g,
  )) {
    versions.set(name, [...(versions.get(name) ?? []), version]);
  }
  return versions;
}

const desktopLock = lockVersions(join(desktop, 'src-tauri/Cargo.lock'));
const harnessLock = lockVersions(join(harness, 'Cargo.lock'));

// Another dependency may pull in a second Rustls line; the advisories cover 0.23.x.
const version = (desktopLock.get('rustls') ?? []).find((v) => v.startsWith('0.23.'));
if (!version) throw new Error('The desktop Cargo.lock resolves no Rustls 0.23.x');

// The harness must test the crates the desktop ships, not whatever its own lock drifted to.
for (const name of ['rustls', 'ring', 'rustls-webpki', 'rustls-pki-types', 'zeroize']) {
  const want = name === 'rustls' ? [version] : (desktopLock.get(name) ?? []);
  const have = harnessLock.get(name) ?? [];
  if (!have.some((v) => want.includes(v))) {
    throw new Error(
      `packages/desktop/test/rustls-security/Cargo.lock resolves ${name} ${have.join(', ') || 'nothing'}, ` +
        `the desktop ${want.join(', ') || 'nothing'}. Run: cargo update --manifest-path ` +
        `packages/desktop/test/rustls-security/Cargo.toml -p ${name} --precise ${want[0]}`,
    );
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'cezar-rustls-security-'));
try {
  cpSync(harness, scratch, { recursive: true, filter: (src) => !src.startsWith(join(harness, 'target')) });
  const manifest = join(scratch, 'Cargo.toml');
  const original = readFileSync(manifest, 'utf8');
  const pinned = original.replace('version = "0.23"', `version = "=${version}"`);
  if (pinned === original) throw new Error('Could not pin rustls in the harness Cargo.toml: no `version = "0.23"`');
  writeFileSync(manifest, pinned);
  console.log(`Testing desktop Rustls ${version} with real TLS 1.2/1.3 sessions`);
  const result = spawnSync(process.env.CARGO || 'cargo', ['test', '--locked', '--manifest-path', manifest], {
    stdio: 'inherit',
    timeout: 300_000,
    killSignal: 'SIGKILL',
    // A stable target dir next to the harness, so CI's rust-cache keeps the build.
    env: { ...process.env, CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR || join(harness, 'target') },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
