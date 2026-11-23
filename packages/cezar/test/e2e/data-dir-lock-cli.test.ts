import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// PR #2430: a second server with ANOTHER cezar home (the dry-run test env) used to adopt a live
// cockpit's tasks, because the single-cockpit slot lives in CEZ_HOME. The data-dir lock refuses it.
const execFile = promisify(execFileCallback);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cliPath = join(packageRoot, 'dist', 'index.js');

const freePort = (): Promise<number> => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      reject(new Error('could not allocate test port'));
      return;
    }
    server.close((error) => error ? reject(error) : resolvePort(address.port));
  });
});

const waitForHealth = async (origin: string): Promise<void> => {
  const deadline = Date.now() + 60_000;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${origin}/api/v1/health`, { signal: AbortSignal.timeout(1_000) })).ok) return;
    } catch (error) {
      last = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`cockpit did not become healthy: ${String(last)}`);
};

const stop = async (child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill(signal);
  await closed;
};

test('a second server with another cezar home refuses a live project, and takes over after a crash', { timeout: 240_000 }, async () => {
  // Canonical path: the lock, like the cockpit slot, refuses symlinked ancestors (macOS /var).
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cezar-data-lock-e2e-')));
  const repo = join(root, 'repo');
  const liveHome = join(root, 'live-home');
  const testHome = join(root, 'test-home');
  await Promise.all([mkdir(repo), mkdir(liveHome), mkdir(testHome)]);
  await execFile('git', ['init', '--initial-branch=main'], { cwd: repo });
  const { CEZ_INSTANCE_ID: _instance, CEZ_SUPERVISOR_PID: _supervisor, ...inherited } = process.env;
  const env = (home: string) => ({ ...inherited, CEZ_HOME: home, CEZ_REMOTE: '0', CEZ_DRY_RUN: '1', CEZ_NO_BANNER: '1' });
  const livePort = await freePort();
  let testPort = await freePort();
  while (testPort === livePort) testPort = await freePort();

  let live: ChildProcess | undefined;
  let takeover: ChildProcess | undefined;
  try {
    live = spawn(process.execPath, [cliPath, '--repo', repo, '--port', String(livePort), '--no-open'], {
      cwd: root, env: env(liveHome), stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForHealth(`http://127.0.0.1:${livePort}`);

    const refused = await execFile(
      process.execPath,
      [cliPath, '--repo', repo, '--port', String(testPort), '--no-open'],
      { cwd: root, env: env(testHome), timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
    ).then(() => undefined, (error: { code?: number; stderr?: string }) => error);
    assert.ok(refused, 'the second server must not start');
    assert.equal(refused.code, 1);
    assert.match(String(refused.stderr), new RegExp(`another cezar \\(pid ${live.pid}\\) already serves the tasks in`));
    await assert.rejects(
      fetch(`http://127.0.0.1:${testPort}/api/v1/health`, { signal: AbortSignal.timeout(500) }),
      'the refused server must not leave a listener behind',
    );

    // A crashed owner never releases; its lock is reclaimed by liveness, not by a timeout.
    await stop(live, 'SIGKILL');
    live = undefined;
    takeover = spawn(process.execPath, [cliPath, '--repo', repo, '--port', String(testPort), '--no-open'], {
      cwd: root, env: env(testHome), stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForHealth(`http://127.0.0.1:${testPort}`);
  } finally {
    if (live) await stop(live);
    if (takeover) await stop(takeover);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
