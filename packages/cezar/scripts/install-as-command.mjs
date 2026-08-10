#!/usr/bin/env node
// `npm run install-as-command` (+ `:global` and the `uninstall-as-command`
// counterpart): build this checkout and put a global `cezar`/`cez`/`cezar-cli`
// command on PATH pointing at THIS working tree — the local-dev equivalent of
// `npx cezar-cli`, with no publish and no `npx` download. Spec 013.
//
//   --mode link       build → `npm link`             (live; `npm run build` refreshes it)
//   --mode global     build → `npm install --global .` (self-contained snapshot)
//   --mode uninstall                  `npm rm --global @open-mercato/cezar`
//   --no-build        skip the build (relink an already-built dist)
//
// The install decisions live in the unit-tested src/install-as-command.ts
// (compiled to dist by the build); this script owns spawning + exit codes.
// npm is invoked through process.execPath + npm_execpath — same cross-platform
// pattern as scripts/dev.mjs / scripts/check-pack.mjs (no .cmd shim assumptions).

import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

const modeIdx = argv.indexOf('--mode');
const mode = modeIdx >= 0 ? argv[modeIdx + 1] : 'link';
const noBuild = argv.includes('--no-build');
if (!['link', 'global', 'uninstall'].includes(mode)) {
  console.error(`install-as-command: unknown --mode "${mode}" (expected link | global | uninstall)`);
  process.exit(1);
}

// npm invocation shim (identical to dev.mjs / check-pack.mjs).
const npmExecpath = process.env.npm_execpath;
const npmCli = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function npm(args, { capture = false } = {}) {
  const viaNode = Boolean(npmExecpath);
  const file = viaNode ? process.execPath : npmCli;
  const full = viaNode ? [npmExecpath, ...args] : args;
  const shell = !viaNode && process.platform === 'win32';
  if (capture) {
    return execFileSync(file, full, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, shell });
  }
  const res = spawnSync(file, full, { cwd: repoRoot, stdio: 'inherit', shell });
  return res.status ?? 1;
}

const distDir = path.join(repoRoot, 'dist');
const build = mode !== 'uninstall' && !noBuild;

if (mode !== 'uninstall' && noBuild && !existsSync(path.join(distDir, 'index.js'))) {
  console.error('install-as-command: --no-build was set but dist/ is missing — run once without --no-build first.');
  process.exit(1);
}

if (build) {
  console.log('install-as-command: building (npm run build)…');
  const code = npm(['run', 'build']);
  if (code !== 0) {
    console.error('install-as-command: build failed — nothing installed.');
    process.exit(code);
  }
}

// Load the tested planner from dist. Present after any build; for uninstall on a
// never-built checkout it may be absent, so fall back to the known command.
let planner = null;
const plannerPath = path.join(distDir, 'install-as-command.js');
if (existsSync(plannerPath)) {
  planner = await import(pathToFileURL(plannerPath).href);
}
const PACKAGE_NAME = planner?.PACKAGE_NAME ?? '@open-mercato/cezar';
const steps = planner
  ? planner.planInstall({ mode, build }).steps
  : [{ args: ['rm', '--global', PACKAGE_NAME], label: `remove global ${PACKAGE_NAME}` }];

for (const step of steps) {
  console.log(`install-as-command: npm ${step.args.join(' ')} (${step.label})`);
  const code = npm(step.args);
  if (code !== 0) {
    if (mode === 'uninstall') {
      // Idempotent: `npm rm -g` of an absent package is a no-op success.
      console.log('install-as-command: nothing to uninstall (already absent).');
      break;
    }
    console.error(`install-as-command: \`npm ${step.args.join(' ')}\` failed (see npm output above).`);
    console.error(
      '  If this is an EACCES on a root-owned global prefix, set a user-writable one\n' +
        '  (e.g. `npm config set prefix ~/.npm-global`) and retry — do NOT use sudo.',
    );
    process.exit(code);
  }
}

if (mode === 'uninstall') {
  console.log('install-as-command: global cezar / cez / cezar-cli removed.');
  process.exit(0);
}

// Verify the shims and print a PATH hint.
let prefix = '';
try {
  prefix = npm(['prefix', '--global'], { capture: true }).trim();
} catch {
  // best-effort — the install already succeeded above
}
if (planner && prefix) {
  const binDir = planner.globalBinDir(prefix, process.platform);
  const present = planner.globalShimPaths(prefix, process.platform).filter((p) => existsSync(p));
  const names = planner.BIN_NAMES.join(', ');
  if (present.length === planner.BIN_NAMES.length) {
    console.log(`\ninstall-as-command: installed ${names} → ${binDir}`);
  } else {
    console.log(`\ninstall-as-command: done, but only ${present.length}/${planner.BIN_NAMES.length} shims found in ${binDir}`);
  }
  console.log(`  Ensure this is on your PATH:\n    ${binDir}`);
  console.log('  Then, from any repo:  cezar --help');
} else {
  console.log('\ninstall-as-command: done. Ensure your npm global bin dir is on PATH, then run `cezar --help`.');
}
