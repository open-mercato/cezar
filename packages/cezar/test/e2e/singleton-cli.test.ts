import assert from 'node:assert/strict';
import { agentProvidersResponseSchema } from '@open-mercato/cezar-contract';
import { execFile as execFileCallback, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
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
  // A cold Windows runner can take well over 20s to boot the packaged CLI.
  const deadline = Date.now() + 60_000;
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

test('the packaged CLI reuses one cockpit, registers a second CWD, and recovers a crash', { timeout: 240_000 }, async () => {
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
    HOME: home,
    USERPROFILE: home,
    CEZ_HOME: home,
    CEZ_REMOTE: '0',
    CEZ_DRY_RUN: '1',
    CEZ_SECRETS_KEYCHAIN: '0',
    PROVIDER_TEST_VALUE: 'fixture-only-9876',
    GEMINI_API_KEY: 'second-fixture-1234',
    GOOGLE_API_KEY: '',
    CEZ_NO_BANNER: '1',
  };
  // Git is the first child on startup and runs again after the cockpit takes its lease.
  const trace = join(root, 'git-trace.jsonl');
  const importEnv = {
    ...env,
    GIT_TRACE2_EVENT: trace,
    GIT_TRACE2_ENV_VARS: 'PROVIDER_TEST_VALUE,GEMINI_API_KEY,PROVIDER_TEST_SENTINEL',
    PROVIDER_TEST_SENTINEL: 'ordinary-inherited-value',
  };
  let primary: ChildProcess | undefined;
  let recovery: ChildProcess | undefined;
  const agents = {
    claude: { active: 'openrouter', methods: { openrouter: { apiKeyEnv: 'PROVIDER_TEST_VALUE' } } },
    codex: { active: 'custom', methods: { custom: { baseUrl: 'https://gateway.invalid', apiKeyEnv: 'GEMINI_API_KEY' } } },
  };
  const document = JSON.stringify({ version: 1, agents });
  const assertGitEnv = async () => {
    const inheritedByGit = await readFile(trace, 'utf8');
    assert.ok(inheritedByGit.includes('ordinary-inherited-value'), 'Git must see the unrelated sentinel');
    assert.ok(!inheritedByGit.includes('fixture-only-9876') && !inheritedByGit.includes('second-fixture-1234'),
      'Git must never inherit either declared key source');
  };
  try {
    const malformed = document.slice(0, -1) + ',}';
    primary = spawn(process.execPath, [cliPath, '--providers', malformed, '--repo', repoA, '--port', String(firstPort), '--no-open'], {
      cwd: root,
      env: importEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let errors = '';
    primary.stderr?.on('data', chunk => { errors += String(chunk); });
    const firstOrigin = `http://127.0.0.1:${firstPort}`;
    const firstHealth = await waitForHealth(firstOrigin);
    assert.match(String(firstHealth.runtimeId), /^[0-9a-f-]{36}$/);

    assert.equal(errors.split('[cez] providers:').length - 1, 1);
    const initial = await (await fetch(firstOrigin + '/api/v1/agent-providers')).json() as { agents: { configured?: boolean }[] };
    assert.ok(initial.agents.every(agent => !agent.configured));
    await assertGitEnv();

    const secondary = await execFile(
      process.execPath,
      [cliPath, '--providers', document, '--repo', repoB, '--port', String(secondPort), '--no-open'],
      { cwd: root, env: importEnv, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
    );
    assert.match(secondary.stdout, /cockpit already running/);
    assert.match(secondary.stdout, new RegExp(`127\\.0\\.0\\.1:${firstPort}/p/[^/]+/`));

    const methods = await (await fetch(firstOrigin + '/api/v1/agent-providers')).text();
    assert.doesNotMatch(methods, /fixture-only-9876/);
    const configured = JSON.parse(methods).agents.find((agent: { runner: string }) => agent.runner === 'claude');
    assert.equal(configured.active, 'openrouter');
    assert.equal(configured.methods.find((method: { id: string }) => method.id === 'openrouter').modelCount, 2);

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
    // Select Gemini's host method and import that same key for Codex again on the new owner.
    const sharedKeyDocument = JSON.stringify({ version: 1, agents: { ...agents, gemini: { active: 'apiKey' } } });
    recovery = spawn(process.execPath, [cliPath, '--providers', sharedKeyDocument, '--repo', repoB, '--port', String(recoveryPort), '--no-open'], {
      cwd: root,
      env: importEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const recoveryOrigin = `http://127.0.0.1:${recoveryPort}`;
    const recoveredHealth = await waitForHealth(recoveryOrigin);
    assert.notEqual(recoveredHealth.runtimeId, firstHealth.runtimeId, 'a replacement process mints a new runtime identity');
    const assertSharedMethods = async () => {
      const response = await fetch(recoveryOrigin + '/api/v1/agent-providers');
      const { agents } = agentProvidersResponseSchema.parse(await response.json());
      const gemini = agents.find(agent => agent.runner === 'gemini');
      const host = gemini?.methods.find(method => method.id === 'apiKey');
      assert.deepEqual([gemini?.active, host?.state, host?.origin], ['apiKey', 'connected', 'host']);
      const codex = agents.find(agent => agent.runner === 'codex');
      const gateway = codex?.methods.find(method => method.id === 'custom');
      assert.deepEqual([codex?.active, gateway?.state, gateway?.origin], ['custom', 'connected', 'file']);
    };
    await assertSharedMethods();
    await execFile(process.execPath, [cliPath, 'providers', 'apply', sharedKeyDocument, '--no-fetch'], {
      cwd: repoB, env: importEnv, timeout: 60_000,
    });
    await assertSharedMethods();
    await assertGitEnv();
  } finally {
    if (primary) await stop(primary);
    if (recovery) await stop(recovery);
    // Windows holds a just-exited child's handles briefly; retry instead of failing on EBUSY.
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
