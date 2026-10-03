import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';

// The scripts under test are the REPO's, not this package's: `.ai/` is agent-pipeline tooling
// that spans every workspace, so it stays at the root.
const repoRoot = resolve(import.meta.dirname, '../../../..');
const fixtures: string[] = [];
const launchedPids = new Set<number>();

afterEach(() => {
  for (const pid of launchedPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The down script already stopped the fixture process.
    }
  }
  launchedPids.clear();
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function commandPath(command: string): string {
  return execFileSync('/bin/sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).trim();
}

const hasSetsid = spawnSync('/bin/sh', ['-c', 'command -v setsid'], { stdio: 'ignore' }).status === 0;

function makeFixture(withSetsid: boolean): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'cez-test-env-launcher-'));
  fixtures.push(root);
  mkdirSync(join(root, '.ai/scripts'), { recursive: true });
  mkdirSync(join(root, '.ai/browsers'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  copyFileSync(join(repoRoot, '.ai/scripts/test-env-up.sh'), join(root, '.ai/scripts/test-env-up.sh'));
  copyFileSync(join(repoRoot, '.ai/scripts/test-env-down.sh'), join(root, '.ai/scripts/test-env-down.sh'));
  writeFileSync(join(root, '.ai/browsers/agent-browser.md'), '# test provider\n');
  writeFileSync(join(root, 'package.json'), '{"private":true}\n');
  writeFileSync(join(root, 'package-lock.json'), '{}\n');

  // `ps` earns its place here: the identity guards read the live process's argv through it,
  // and a fixture PATH without it would make every guard fail closed and silently pass.
  const commands = ['cat', 'chmod', 'curl', 'date', 'dirname', 'find', 'grep', 'id', 'kill', 'mkdir', 'mv', 'nohup', 'ps', 'pwd', 'rm', 'sh', 'sleep', 'tail', 'uname'];
  if (withSetsid) commands.push('setsid');
  for (const command of commands) symlinkSync(commandPath(command), join(root, 'bin', command));
  symlinkSync(process.execPath, join(root, 'bin/node'));

  writeFileSync(
    join(root, 'bin/npm'),
    // Writes the same artifacts the real preparation chain produces, at the same paths —
    // the up script asserts on them by name (BUILD_ARTIFACTS), so this stub has to follow
    // the workspace layout rather than invent its own.
    `#!/bin/sh
set -eu
mkdir -p node_modules/zod packages/cezar/dist packages/cezar/web/dist
printf '{"name":"zod"}' > node_modules/zod/package.json
cat > packages/cezar/dist/index.js <<'EOF'
const http = require('node:http');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
// The real server reports the checkout it was booted with on the health route, and the
// launcher's reuse guard compares that against its own root — so the fake has to echo
// --repo back rather than answer with a shape that carries no identity at all.
const repoRoot = process.argv[process.argv.indexOf('--repo') + 1];
http.createServer((req, res) => {
  const health = req.url === '/api/health' || req.url === '/api/v1/health';
  res.writeHead(200, { 'content-type': health ? 'application/json' : 'text/html' });
  res.end(health ? JSON.stringify({ ok: true, repoRoot }) : '<!doctype html>');
}).listen(port, '127.0.0.1');
EOF
printf '<!doctype html>' > packages/cezar/web/dist/index.html
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(root, 'bin/agent-browser'),
    `#!/bin/sh
case "\${1:-}" in
  doctor) printf '{"ok":true}\\n' ;;
  --version) printf 'test-browser 1\\n' ;;
  *) : ;;
esac
`,
    { mode: 0o755 },
  );
  return { root, path: join(root, 'bin') };
}

type Descriptor = {
  status: string;
  baseUrl: string;
  startedAt: string;
  startedByThisRepo: boolean;
  environment: { singleProject: boolean };
  browser: { installed: boolean };
  app: { pid: number | null; repoRoot: string };
};

function descriptor(root: string): Descriptor {
  return JSON.parse(readFileSync(join(root, '.ai/qa/test-env.json'), 'utf8')) as Descriptor;
}

function writeDescriptor(root: string, descriptorToWrite: unknown): void {
  writeFileSync(join(root, '.ai/qa/test-env.json'), `${JSON.stringify(descriptorToWrite, null, 2)}\n`);
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolvePort(port));
    });
  });
}

/**
 * `kill -0` is not enough to prove survival here: these processes are children of the test
 * runner, and a killed-but-unreaped child is a zombie that `kill -0` still reports as alive.
 * The child handle is the honest witness — an exit shows up as a code or a signal.
 */
async function assertStillRunning(child: ChildProcess, label: string): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  assert.equal(child.exitCode, null, `${label} exited with code ${child.exitCode}`);
  assert.equal(child.signalCode, null, `${label} was signalled with ${child.signalCode}`);
}

async function waitForHealth(baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/api/v1/health`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  assert.fail(`${baseUrl} never became healthy`);
}

for (const withSetsid of [true, false]) {
  test(
    `generated launcher survives its caller and stops by descriptor PID (${withSetsid ? 'setsid' : 'nohup fallback'})`,
    { skip: withSetsid && !hasSetsid ? 'setsid is not available on this platform' : false },
    async () => {
      const fixture = makeFixture(withSetsid);
      const env = { ...process.env, PATH: fixture.path, TEST_ENV_CACHE_TTL_SECONDS: '600' };
      const up = join(fixture.root, '.ai/scripts/test-env-up.sh');
      const down = join(fixture.root, '.ai/scripts/test-env-down.sh');
      const callerPidFile = join(fixture.root, 'caller.pid');

      const coldCommand = withSetsid ? commandPath('setsid') : '/bin/sh';
      const coldArgs = withSetsid
        ? ['/bin/sh', '-c', 'echo $$ > "$2"; sh "$1"', 'launcher-parent', up, callerPidFile]
        : ['-c', 'echo $$ > "$2"; sh "$1"', 'launcher-parent', up, callerPidFile];
      const cold = spawnSync(coldCommand, coldArgs, {
        cwd: tmpdir(),
        encoding: 'utf8',
        env,
        timeout: 20_000,
      });
      assert.equal(cold.status, 0, cold.stderr);
      assert.match(cold.stdout, /TEST_ENV_REUSED=0/);

      const first = descriptor(fixture.root);
      const firstPid = first.app.pid;
      assert.ok(firstPid, 'a cold boot records the live pid');
      launchedPids.add(firstPid);
      if (withSetsid) {
        const callerPid = Number(readFileSync(callerPidFile, 'utf8').trim());
        try {
          process.kill(-callerPid, 'SIGTERM');
        } catch (error) {
          assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH');
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      }
      assert.equal(process.kill(firstPid, 0), true);
      const health = await fetch(`${first.baseUrl}/api/health`).then((response) => response.json());
      assert.deepEqual(health, { ok: true, repoRoot: first.app.repoRoot });

      const warm = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
      assert.equal(warm.status, 0, warm.stderr);
      assert.match(warm.stdout, /TEST_ENV_REUSED=1/);
      assert.equal(descriptor(fixture.root).app.pid, firstPid);

      const stopped = spawnSync('/bin/sh', [down], { encoding: 'utf8', env, timeout: 20_000 });
      assert.equal(stopped.status, 0, stopped.stderr);
      assert.match(stopped.stdout, /TEST_ENV_STATUS=stopped/);
      assert.throws(() => process.kill(firstPid, 0));
      // A cleanly stopped descriptor nominates no PID at all, so nothing downstream can
      // inherit a number that now belongs to somebody else.
      assert.equal(descriptor(fixture.root).app.pid, null);
      launchedPids.delete(firstPid);
    },
  );
}

// ---- instance identity (#898) ----------------------------------------------
// A PID number and a port prove liveness, never ownership. The descriptor is gitignored
// and only ever rewritten, so it outlives reboots — after which its PID number is
// routinely recycled onto an unrelated process and its port is routinely held by another
// worktree's instance. These cover both halves of that.

test('a descriptor whose PID was recycled onto a foreign process never signals it', async () => {
  const fixture = makeFixture(hasSetsid);
  const env = { ...process.env, PATH: fixture.path, TEST_ENV_CACHE_TTL_SECONDS: '600' };
  const up = join(fixture.root, '.ai/scripts/test-env-up.sh');

  // Stands in for whatever inherited the recorded number after a reboot: a live process
  // that is emphatically not a cezar server.
  const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300_000)'], { stdio: 'ignore' });
  const bystanderPid = bystander.pid;
  assert.ok(bystanderPid, 'the bystander process started');
  launchedPids.add(bystanderPid);

  mkdirSync(join(fixture.root, '.ai/qa'), { recursive: true });
  writeDescriptor(fixture.root, {
    status: 'running',
    // Nothing answers here — the descriptor is stale in every respect except its liveness signal.
    baseUrl: 'http://127.0.0.1:1',
    startedByThisRepo: true,
    startedAt: new Date().toISOString(),
    app: { pid: bystanderPid, port: 1, healthPath: '/api/v1/health', repoRoot: fixture.root },
    environment: { singleProject: false },
    browser: { installed: true },
  });

  const boot = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(boot.status, 0, boot.stderr);
  assert.match(boot.stdout, /TEST_ENV_REUSED=0/);

  await assertStillRunning(bystander, 'the bystander holding the recycled pid');
  const booted = descriptor(fixture.root);
  assert.ok(booted.app.pid, 'a fresh instance booted');
  assert.notEqual(booted.app.pid, bystanderPid);
  launchedPids.add(booted.app.pid);
});

test('an instance from another checkout on the recorded port is not reused as this one', async () => {
  const fixture = makeFixture(hasSetsid);
  const env = { ...process.env, PATH: fixture.path, TEST_ENV_CACHE_TTL_SECONDS: '600' };
  const up = join(fixture.root, '.ai/scripts/test-env-up.sh');

  const cold = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(cold.status, 0, cold.stderr);
  assert.match(cold.stdout, /TEST_ENV_REUSED=0/);
  const ours = descriptor(fixture.root);
  const oursPid = ours.app.pid;
  assert.ok(oursPid, 'a cold boot records the live pid');
  launchedPids.add(oursPid);

  // The guards must not defeat the build cache: an instance this fixture booted is
  // still recognised as its own and reused.
  const warm = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(warm.status, 0, warm.stderr);
  assert.match(warm.stdout, /TEST_ENV_REUSED=1/);

  // The realistic collision: the recorded PID is still alive and still genuinely ours,
  // but the recorded port has meanwhile been taken by a different checkout's instance.
  // Liveness says "reuse"; only identity says otherwise.
  const foreignRoot = `${fixture.root}-other-worktree`;
  const foreignPort = await freePort();
  const foreign = spawn(
    process.execPath,
    [join(fixture.root, 'packages/cezar/dist/index.js'), '--port', String(foreignPort), '--no-open', '--repo', foreignRoot],
    { stdio: 'ignore' },
  );
  const foreignPid = foreign.pid;
  assert.ok(foreignPid, 'the foreign instance started');
  launchedPids.add(foreignPid);
  const foreignUrl = `http://127.0.0.1:${foreignPort}`;
  await waitForHealth(foreignUrl);

  writeDescriptor(fixture.root, { ...ours, baseUrl: foreignUrl, startedAt: new Date().toISOString() });

  const collided = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(collided.status, 0, collided.stderr);
  assert.match(collided.stdout, /TEST_ENV_REUSED=0/);
  await assertStillRunning(foreign, "the other checkout's instance");

  const rebooted = descriptor(fixture.root);
  assert.ok(rebooted.app.pid, 'a fresh instance booted');
  assert.notEqual(rebooted.baseUrl, foreignUrl);
  assert.equal(rebooted.app.repoRoot, ours.app.repoRoot);
  launchedPids.add(rebooted.app.pid);
});
