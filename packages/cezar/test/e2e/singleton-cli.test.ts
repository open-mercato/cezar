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

const waitForHealth = async (origin: string): Promise<Record<string, unknown>> => {
  const deadline = Date.now() + 20_000;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/v1/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return await response.json() as Record<string, unknown>;
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

test('the packaged CLI reuses one cockpit, registers a second CWD, and recovers a crash', { timeout: 90_000 }, async () => {
  // macOS exposes /var as a symlink to /private/var. Runtime ownership deliberately rejects
  // symlink ancestors, so exercise the singleton with the canonical temporary root a real
  // CEZ_HOME installation would use rather than silently taking the degraded fallback path.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cezar-singleton-e2e-')));
  const home = join(root, 'home');
  const repoA = join(root, 'repo-a');
  const repoB = join(root, 'repo-b');
  await Promise.all([mkdir(home), mkdir(repoA), mkdir(repoB)]);
  await Promise.all([
    execFile('git', ['init', '--initial-branch=main'], { cwd: repoA }),
    execFile('git', ['init', '--initial-branch=main'], { cwd: repoB }),
  ]);
  const firstPort = await freePort();
  let secondPort = await freePort();
  while (secondPort === firstPort) secondPort = await freePort();
  let recoveryPort = await freePort();
  while (recoveryPort === firstPort || recoveryPort === secondPort) recoveryPort = await freePort();
  const {
    CEZ_INSTANCE_ID: _instance,
    CEZ_SUPERVISOR_PID: _supervisor,
    ...inherited
  } = process.env;
  const env = {
    ...inherited,
    CEZ_HOME: home,
    CEZ_REMOTE: '0',
    CEZ_DRY_RUN: '1',
    CEZ_NO_BANNER: '1',
  };
  let primary: ChildProcess | undefined;
  let recovery: ChildProcess | undefined;
  try {
    primary = spawn(process.execPath, [cliPath, '--repo', repoA, '--port', String(firstPort), '--no-open'], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const firstOrigin = `http://127.0.0.1:${firstPort}`;
    const firstHealth = await waitForHealth(firstOrigin);
    assert.match(String(firstHealth.runtimeId), /^[0-9a-f-]{36}$/);

    const secondary = await execFile(
      process.execPath,
      [cliPath, '--repo', repoB, '--port', String(secondPort), '--no-open'],
      { cwd: root, env, timeout: 20_000, maxBuffer: 10 * 1024 * 1024 },
    );
    assert.match(secondary.stdout, /cockpit already running/);
    assert.match(secondary.stdout, new RegExp(`127\\.0\\.0\\.1:${firstPort}/p/[^/]+/`));

    const projectsResponse = await fetch(`${firstOrigin}/api/v1/projects`);
    assert.equal(projectsResponse.status, 200);
    const projects = await projectsResponse.json() as { projects: Array<{ root: string }> };
    const realRepoB = await realpath(repoB);
    assert.ok(projects.projects.some((project) => project.root === realRepoB));
    await assert.rejects(
      fetch(`http://127.0.0.1:${secondPort}/api/v1/health`, { signal: AbortSignal.timeout(500) }),
      'the secondary must not leave a second listener behind',
    );

    await stop(primary, 'SIGKILL');
    primary = undefined;
    recovery = spawn(process.execPath, [cliPath, '--repo', repoB, '--port', String(recoveryPort), '--no-open'], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const recoveredHealth = await waitForHealth(`http://127.0.0.1:${recoveryPort}`);
    assert.notEqual(recoveredHealth.runtimeId, firstHealth.runtimeId, 'a replacement process mints a new runtime identity');
  } finally {
    if (primary) await stop(primary);
    if (recovery) await stop(recovery);
    await rm(root, { recursive: true, force: true });
  }
});
