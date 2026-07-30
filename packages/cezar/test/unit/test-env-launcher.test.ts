import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

  const commands = ['cat', 'chmod', 'curl', 'date', 'dirname', 'find', 'grep', 'id', 'kill', 'mkdir', 'mv', 'nohup', 'pwd', 'rm', 'sh', 'sleep', 'tail', 'uname'];
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
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': req.url === '/api/health' ? 'application/json' : 'text/html' });
  res.end(req.url === '/api/health' ? '{"ok":true}' : '<!doctype html>');
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

function descriptor(root: string): { baseUrl: string; app: { pid: number } } {
  return JSON.parse(readFileSync(join(root, '.ai/qa/test-env.json'), 'utf8')) as {
    baseUrl: string;
    app: { pid: number };
  };
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
      launchedPids.add(first.app.pid);
      if (withSetsid) {
        const callerPid = Number(readFileSync(callerPidFile, 'utf8').trim());
        try {
          process.kill(-callerPid, 'SIGTERM');
        } catch (error) {
          assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH');
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      }
      assert.equal(process.kill(first.app.pid, 0), true);
      const health = await fetch(`${first.baseUrl}/api/health`).then((response) => response.json());
      assert.deepEqual(health, { ok: true });

      const warm = spawnSync('/bin/sh', [up], { encoding: 'utf8', env, timeout: 20_000 });
      assert.equal(warm.status, 0, warm.stderr);
      assert.match(warm.stdout, /TEST_ENV_REUSED=1/);
      assert.equal(descriptor(fixture.root).app.pid, first.app.pid);

      const stopped = spawnSync('/bin/sh', [down], { encoding: 'utf8', env, timeout: 20_000 });
      assert.equal(stopped.status, 0, stopped.stderr);
      assert.match(stopped.stdout, /TEST_ENV_STATUS=stopped/);
      assert.throws(() => process.kill(first.app.pid, 0));
      launchedPids.delete(first.app.pid);
    },
  );
}
