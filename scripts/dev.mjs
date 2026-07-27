#!/usr/bin/env node
// One-command dev (`npm run dev`): boots the cockpit server (API) and the Vite
// dev server together, then lets Vite open the browser once it's serving —
// same "run one thing, get a working cockpit in the browser" flow the pre-Vite
// UI had, now with HMR.
//
// The API port is probed here and pinned into BOTH processes (server via -p,
// Vite proxy via CEZ_API_PORT — see packages/web/vite.config.ts). Without that,
// a cockpit already sitting on 4321 (another repo, an older npm install) would
// silently answer the proxy with stale endpoints — 404s all over the UI.
//
// This stays at the repo root rather than inside a package: it is the one script
// that spans two workspaces. Both halves are reached through the root's
// `dev:server`/`dev:web` scripts, which forward into the workspaces, so the
// package that owns each process also owns how it starts.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const canListen = (port) =>
  new Promise((done) => {
    const probe = createServer();
    probe.once('error', () => done(false));
    probe.once('listening', () => probe.close(() => done(true)));
    probe.listen(port, '127.0.0.1');
  });

let apiPort = 4321;
while (!(await canListen(apiPort))) apiPort++;
if (apiPort !== 4321) console.log(`dev: port 4321 is taken (another cockpit?) — using ${apiPort}`);

// Under `npm run`, npm_execpath is npm's own cli.js — running it through
// process.execPath works on every platform (no .cmd shim needed on Windows).
const npmExecpath = process.env.npm_execpath;
const npmCli = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (script, extraArgs) => {
  const args = ['run', script, '--', ...extraArgs];
  const env = { ...process.env, CEZ_API_PORT: String(apiPort) };
  return npmExecpath
    ? spawn(process.execPath, [npmExecpath, ...args], { cwd: repoRoot, stdio: 'inherit', env })
    : spawn(npmCli, args, { cwd: repoRoot, stdio: 'inherit', env, shell: process.platform === 'win32' });
};

const server = run('dev:server', ['--port', String(apiPort), '--no-open']);

// Give the API a moment to answer before Vite opens the browser, so the first
// paint has live data instead of proxy errors. Best-effort: on timeout Vite
// starts anyway and the proxy recovers on reload.
const deadline = Date.now() + 15_000;
while (Date.now() < deadline) {
  if (server.exitCode !== null) break; // server died — the exit handler below reports it
  try {
    const res = await fetch(`http://127.0.0.1:${apiPort}/api/health`);
    if (res.ok) break;
  } catch {
    // not listening yet
  }
  await new Promise((r) => setTimeout(r, 250));
}

const web = server.exitCode === null ? run('dev:web', ['--open']) : null;

// Either process dying takes the whole dev session down — a half-running
// cockpit (UI without API, or API without UI) just looks broken.
const children = [server, web].filter(Boolean);
let shuttingDown = false;
const shutdown = (code) => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  process.exitCode = code;
};
for (const child of children) child.on('exit', (code) => shutdown(code ?? 0));
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
