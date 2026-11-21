// Isolated native regression harness: use the desktop's actual resolved Rustls,
// without linking the Tauri GUI or changing its dependency graph (#2393).
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const desktop = fileURLToPath(new URL('../', import.meta.url));
const lock = readFileSync(join(desktop, 'src-tauri/Cargo.lock'), 'utf8');
const versions = [...lock.matchAll(/\[\[package\]\]\r?\nname = "rustls"\r?\nversion = "(\d+\.\d+\.\d+)"/g)];
if (versions.length !== 1) throw new Error('Expected exactly one desktop Rustls resolution');
const version = versions[0][1];
const scratch = mkdtempSync(join(tmpdir(), 'cezar-rustls-security-'));
try {
  cpSync(join(desktop, 'test/rustls-security'), scratch, { recursive: true });
  const manifest = join(scratch, 'Cargo.toml');
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('version = "0.23"', `version = "=${version}"`));
  console.log(`Testing desktop Rustls ${version} with real TLS 1.2/1.3 sessions`);
  const result = spawnSync(process.env.CARGO || 'cargo', ['test', '--manifest-path', manifest], {
    stdio: 'inherit', timeout: 300_000, killSignal: 'SIGKILL',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
