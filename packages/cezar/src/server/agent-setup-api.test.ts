import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunStore } from '../runs/store.ts';
import { runInRelayScope } from '../relay/scope.ts';
import type { RunManager } from '../workflows/run.ts';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import { LatestVersions } from '../core/agent-cli-versions.ts';
import { agentSetupRoutes, withoutHostPaths } from './agent-setup-routes.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp, type ServerDeps } from './server.ts';
import type { PtyBinding, PtyProcess, PtySpawnOptions } from './terminal/pty-module.ts';
import { TerminalSessions } from './terminal/sessions.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';

/** `/api/v1/providers/setup` (spec 2026-10-26-first-run-onboarding, "Set up an agent here"), over
 *  a fake PTY and a fake status: what is pinned is which command runs, where, and who may ask. */

class FakePty implements PtyProcess {
  readonly pid = 777;
  written: string[] = [];
  private exit?: (event: { exitCode: number }) => void;
  private data?: (chunk: string) => void;
  onData(listener: (chunk: string) => void) { this.data = listener; return { dispose: () => {} }; }
  onExit(listener: (event: { exitCode: number }) => void) { this.exit = listener; return { dispose: () => {} }; }
  write(data: string) { this.written.push(data); }
  resize() {}
  kill() {}
  emit(chunk: string) { this.data?.(chunk); }
  finish(exitCode: number) { this.exit?.({ exitCode }); }
}

describe('/api/v1/providers/setup', () => {
  let repoRoot: string;
  let store: RunStore;
  let sessions: TerminalSessions;
  let ptys: FakePty[];
  let spawns: Array<{ shell: string; args: string[]; options: PtySpawnOptions }>;
  const saved = { ...process.env };

  const build = (overrides: Partial<ServerDeps> = {}) => createApp({
    repoRoot,
    store,
    manager: {} as RunManager,
    version: '0.0.0-test',
    terminalSessions: sessions,
    agentSetupProbeEnv: async () => ({ platform: 'linux', npm: true, npmGlobalWritable: true, curl: true, sudo: false, brew: false }),
    latestAgentVersions: new LatestVersions({ fetch: async () => { throw new Error('no network in tests'); } }),
    ...overrides,
  });
  const post = (app: ReturnType<typeof build>, body: unknown) =>
    apiRequest(app, '/api/v1/providers/setup/sessions', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-agent-setup-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    ptys = [];
    spawns = [];
    const binding: PtyBinding = {
      available: true,
      module: {
        spawn: (shell: string, args: string[], options: PtySpawnOptions) => {
          spawns.push({ shell, args, options });
          const pty = new FakePty();
          ptys.push(pty);
          return pty;
        },
      },
    };
    sessions = new TerminalSessions(async () => binding, undefined, () => null);
    delete process.env.CEZ_REMOTE;
    delete process.env.CEZ_TERMINAL;
    delete process.env.CEZ_SINGLE_PROJECT;
    delete process.env.CEZ_DRY_RUN;
    // Every provider reads as missing, so `install` is allowed and `login` is refused.
    process.env.PATH = join(repoRoot, 'empty');
    process.env.CEZ_CLAUDE_BIN = join(repoRoot, 'no-claude');
  });

  afterEach(() => {
    sessions.dispose();
    store.flush();
    process.env = { ...saved };
    rmSync(repoRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('lists what it can install, with no session yet', async () => {
    const response = await apiRequest(build(), '/api/v1/providers/setup');
    expect(response.status).toBe(200);
    const body = await response.json() as { available: boolean; session: unknown; agents: Array<{ provider: string; install: { command: string | null; runnable: boolean } }> };
    expect(body.available).toBe(true);
    expect(body.session).toBeNull();
    expect(body.agents.map((agent) => agent.provider)).toEqual([...RUNNER_IDS]);
    expect(body.agents.find((agent) => agent.provider === 'codex')?.install).toMatchObject({ command: 'npm install -g @openai/codex', runnable: true });
  });

  it('runs the catalog command in the home folder, never the project', async () => {
    const response = await post(build(), { provider: 'codex', action: 'install', cols: 100, rows: 30 });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ provider: 'codex', action: 'install', command: 'npm install -g @openai/codex', cols: 100, rows: 30 });
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.args.at(-1)).toBe('npm install -g @openai/codex');
    expect(spawns[0]!.options.cwd).toBe(homedir());
  });

  it('takes no command from the request', async () => {
    const response = await post(build(), { provider: 'codex', action: 'install', command: 'rm -rf /' });
    expect(response.status).toBe(201);
    expect(spawns[0]!.args.join(' ')).not.toContain('rm -rf');
  });

  it('refuses an unknown provider and an unknown action', async () => {
    expect((await post(build(), { provider: 'nope', action: 'install' })).status).toBe(400);
    expect((await post(build(), { provider: 'codex', action: 'exec' })).status).toBe(400);
    expect(spawns).toHaveLength(0);
  });

  it('refuses to run a copy-only agent; its command to copy is in the listing', async () => {
    const app = build();
    const junie = await post(app, { provider: 'junie', action: 'install' });
    expect(junie.status).toBe(409);
    const listing = await (await apiRequest(app, '/api/v1/providers/setup')).json() as { agents: Array<{ provider: string; install: { command: string | null; runnable: boolean } }> };
    expect(listing.agents.find((agent) => agent.provider === 'junie')?.install).toMatchObject({ command: 'npm install -g @jetbrains/junie', runnable: false });
    const omp = await post(build(), { provider: 'omp', action: 'install' });
    expect(omp.status).toBe(409);
    expect((await omp.json() as { error: string }).error).toContain('third-party');
    expect(spawns).toHaveLength(0);
  });

  it('refuses a login for an agent that is not installed', async () => {
    const response = await post(build(), { provider: 'codex', action: 'login' });
    expect(response.status).toBe(409);
    expect(spawns).toHaveLength(0);
  });

  it('joins the running session instead of starting a second install', async () => {
    const app = build();
    const first = await (await post(app, { provider: 'codex', action: 'install' })).json() as { id: string };
    const second = await post(app, { provider: 'codex', action: 'install' });
    // The same 201 as a fresh start: one success shape keeps the typed API under its size limit.
    expect(second.status).toBe(201);
    expect((await second.json() as { id: string }).id).toBe(first.id);
    expect(spawns).toHaveLength(1);
  });

  it('refuses another agent while one is running, and allows it after the exit', async () => {
    const app = build();
    await post(app, { provider: 'codex', action: 'install' });
    expect((await post(app, { provider: 'copilot', action: 'install' })).status).toBe(409);
    ptys[0]!.finish(0);
    expect((await post(app, { provider: 'copilot', action: 'install' })).status).toBe(201);
    expect(spawns).toHaveLength(2);
  });

  it('a running install blocks "restart when idle" until it exits', async () => {
    const semaphore = new WorkspaceSemaphore();
    const app = build({ semaphore });
    expect(semaphore.restartGate.idle()).toBe(true);
    await post(app, { provider: 'codex', action: 'install' });
    expect(semaphore.restartGate.blockers()).toEqual([{ kind: 'setup', count: 1, names: ['codex install'] }]);
    ptys[0]!.finish(0);
    expect(semaphore.restartGate.idle()).toBe(true);
  });

  it('reattaches after a reload: the state names the session and its exit code', async () => {
    const app = build();
    const { id } = await (await post(app, { provider: 'codex', action: 'install' })).json() as { id: string };
    ptys[0]!.finish(1);
    const state = await (await apiRequest(app, '/api/v1/providers/setup')).json() as { session: { id: string; exitCode: number; provider: string } };
    expect(state.session).toMatchObject({ id, exitCode: 1, provider: 'codex' });
  });

  it('carries output, keystrokes and a cancel', async () => {
    const app = build();
    const { id } = await (await post(app, { provider: 'codex', action: 'install' })).json() as { id: string };
    ptys[0]!.emit('added 1 package');
    const output = await apiRequest(app, `/api/v1/providers/setup/sessions/${id}/output`);
    expect(await output.json()).toMatchObject({ data: 'added 1 package', exitCode: null });
    await apiRequest(app, `/api/v1/providers/setup/sessions/${id}/input`, { method: 'POST', body: JSON.stringify({ data: 'y\n' }), headers: { 'content-type': 'application/json' } });
    expect(ptys[0]!.written).toEqual(['y\n']);
    expect((await apiRequest(app, `/api/v1/providers/setup/sessions/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect(sessions.get(id)).toBeNull();
    const state = await (await apiRequest(app, '/api/v1/providers/setup')).json() as { session: unknown };
    expect(state.session).toBeNull();
  });

  it("cannot reach a task's terminal", async () => {
    const app = build();
    const created = await sessions.create({ runId: 'some-run', cwd: repoRoot });
    if (!created.ok) throw new Error(created.reason);
    expect((await apiRequest(app, `/api/v1/providers/setup/sessions/${created.session.id}/output`)).status).toBe(404);
    expect((await apiRequest(app, `/api/v1/providers/setup/sessions/${created.session.id}`, { method: 'DELETE' })).status).toBe(404);
    expect(sessions.get(created.session.id)).not.toBeNull();
  });

  it.each([
    ['hosted', { CEZ_REMOTE: '1' }],
    ['hosted with a terminal opted in', { CEZ_REMOTE: '1', CEZ_TERMINAL: '1' }],
    ['terminal off', { CEZ_TERMINAL: '0' }],
    ['single project', { CEZ_SINGLE_PROJECT: '1' }],
  ])('is unavailable and starts nothing: %s', async (_name, env) => {
    Object.assign(process.env, env);
    const app = build();
    const state = await (await apiRequest(app, '/api/v1/providers/setup')).json() as { available: boolean; reason: string };
    expect(state.available).toBe(false);
    expect(state.reason).toBeTruthy();
    // The commands to copy stay, but nothing is runnable here and nothing names a host binary path.
    const agents = (state as unknown as { agents: Array<{ provider: string; loginCommand: string | null; install: { command: string | null; runnable: boolean } }> }).agents;
    expect(agents.find((agent) => agent.provider === 'codex')?.install).toMatchObject({ command: 'npm install -g @openai/codex', runnable: false });
    expect(agents.every((agent) => agent.install.runnable === false)).toBe(true);
    expect(agents.every((agent) => agent.loginCommand === null)).toBe(true);
    expect((await post(app, { provider: 'codex', action: 'install' })).status).toBe(409);
    expect(spawns).toHaveLength(0);
  });

  describe('createApp relay scope and activeRuns wiring (#2474)', () => {
    it('lets a paired phone list and start a password-free install on a local host, read-only and redacted', async () => {
      const app = build();
      const listed = await runInRelayScope({ deviceId: 'phone-1' }, () => apiRequest(app, '/api/v1/providers/setup'));
      expect(listed.status).toBe(200);
      const state = await listed.json() as { available: boolean; interactive: boolean; agents: Array<{ provider: string; install: { runnable: boolean } }> };
      expect(state).toMatchObject({ available: true, interactive: false });
      expect(state.agents.find((agent) => agent.provider === 'codex')?.install.runnable).toBe(true);

      const started = await runInRelayScope({ deviceId: 'phone-1' }, () => post(app, { provider: 'codex', action: 'install' }));
      expect(started.status).toBe(201);
      const session = await started.json() as { id: string; cwd: string; shell: string; command: string };
      expect(session.cwd).toBe('~');
      expect(session.shell).not.toMatch(/[\\/]/);
      expect(JSON.stringify(session)).not.toContain(homedir());

      const typed = await runInRelayScope({ deviceId: 'phone-1' }, () =>
        apiRequest(app, `/api/v1/providers/setup/sessions/${session.id}/input`, { method: 'POST', body: JSON.stringify({ data: 'y\n' }), headers: { 'content-type': 'application/json' } }),
      );
      expect(typed.status).toBe(409);
      const resized = await runInRelayScope({ deviceId: 'phone-1' }, () =>
        apiRequest(app, `/api/v1/providers/setup/sessions/${session.id}/resize`, { method: 'POST', body: JSON.stringify({ cols: 40, rows: 10 }), headers: { 'content-type': 'application/json' } }),
      );
      expect(resized.status).toBe(409);
    });

    it.each([
      ['hosted (CEZ_REMOTE=1)', { CEZ_REMOTE: '1' }, {}],
      ['non-loopback bindHost', {}, { bindHost: '0.0.0.0' }],
      ['terminal off (CEZ_TERMINAL=0)', { CEZ_TERMINAL: '0' }, {}],
      ['single project (CEZ_SINGLE_PROJECT=1)', { CEZ_SINGLE_PROJECT: '1' }, {}],
    ] as const)('still refuses a paired phone when %s', async (_name, env, overrides) => {
      Object.assign(process.env, env);
      const app = build(overrides);
      const state = await (await runInRelayScope({ deviceId: 'phone-1' }, () => apiRequest(app, '/api/v1/providers/setup'))).json() as {
        available: boolean;
        reason: string | null;
        interactive: boolean;
        agents: Array<{ install: { runnable: boolean } }>;
      };
      expect(state.available).toBe(false);
      expect(state.interactive).toBe(false);
      expect(state.reason).toBeTruthy();
      expect(state.agents.every((agent) => agent.install.runnable === false)).toBe(true);
      const started = await runInRelayScope({ deviceId: 'phone-1' }, () => post(app, { provider: 'codex', action: 'install' }));
      expect(started.status).toBe(409);
    });

    it('wires activeRuns through createApp from the project store', async () => {
      const active = store.createRun({ title: 'active', workflow: 'quick-task', task: 'x', steps: [], runner: 'codex' });
      store.updateRun(active.id, { status: 'running' });
      const done = store.createRun({ title: 'done', workflow: 'quick-task', task: 'y', steps: [], runner: 'claude' });
      store.updateRun(done.id, { status: 'done' });

      const state = await (await apiRequest(build(), '/api/v1/providers/setup')).json() as {
        agents: Array<{ provider: string; activeRuns: number }>;
      };
      expect(state.agents.find((agent) => agent.provider === 'codex')?.activeRuns).toBe(1);
      expect(state.agents.find((agent) => agent.provider === 'claude')?.activeRuns).toBe(0);
    });
  });

  it('is unavailable without a PTY', async () => {
    const routes = agentSetupRoutes({
      sessions,
      loadPty: async () => ({ available: false, reason: 'no pty here' }),
      refusal: () => null,
      status: async () => ({ providers: [] }),
      loginCommand: () => null,
      installHint: () => '',
      registerTopic: () => {},
      topic: (id) => id,
      onLoginOpened: () => {},
      deviceSid: () => undefined,
    });
    expect(await (await routes.request('/providers/setup')).json()).toMatchObject({ available: false, reason: 'no pty here' });
    const started = await routes.request('/providers/setup/sessions', { method: 'POST', body: JSON.stringify({ provider: 'codex', action: 'install' }), headers: { 'content-type': 'application/json' } });
    expect(started.status).toBe(409);
    expect(spawns).toHaveLength(0);
  });

  it('dry-run shows the real command but runs none of it', async () => {
    process.env.CEZ_DRY_RUN = '1';
    const response = await post(build(), { provider: 'claude', action: 'login' });
    expect(response.status).toBe(201);
    expect((await response.json() as { command: string }).command).toContain('auth login');
    expect(spawns[0]!.args.join(' ')).toContain('dry run');
    expect(spawns[0]!.args.join(' ')).not.toContain('auth login');
  });

  describe('update, phone and versions (spec 2026-11-25-agent-cli-install-and-update)', () => {
    const installedClaude = { providers: [{ provider: 'claude' as const, status: 'connected' as const }] };
    const routesWith = (over: Partial<Parameters<typeof agentSetupRoutes>[0]> = {}) => agentSetupRoutes({
      sessions,
      loadPty: async () => ({ available: true, module: { spawn: () => { throw new Error('unused'); } } }) as unknown as PtyBinding,
      refusal: () => null,
      status: async () => installedClaude,
      loginCommand: (provider) => `${provider} login`,
      installHint: () => 'install it',
      registerTopic: () => {},
      topic: (id) => id,
      onLoginOpened: () => {},
      deviceSid: () => undefined,
      // A Mac with Claude Code from its Homebrew cask, the one place that cask exists.
      probeEnv: async () => ({ platform: 'darwin', npm: true, npmGlobalWritable: true, curl: true, sudo: true, brew: true }),
      checks: async () => [{ name: 'claude', available: true, version: '2.0.14 (Claude Code)' }],
      locate: (executable) => ({ executable, path: '/opt/homebrew/bin/claude', method: 'brew', brewKind: 'cask' }),
      ...over,
    });
    const start = (routes: ReturnType<typeof routesWith>, body: unknown) =>
      routes.request('/providers/setup/sessions', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

    it('updates the copy that is installed, the way it was installed', async () => {
      const response = await start(routesWith(), { provider: 'claude', action: 'update' });
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ action: 'update', command: 'brew upgrade claude-code' });
    });

    it('reads the new version as soon as an update exits, not a check cached while it ran', async () => {
      let version = '2.0.14 (Claude Code)';
      const routes = routesWith({ checks: async () => [{ name: 'claude', available: true, version }] });
      const listed = async () =>
        ((await (await routes.request('/providers/setup')).json()) as { agents: Array<{ provider: string; version: string | null }> })
          .agents.find((agent) => agent.provider === 'claude')?.version;
      expect((await start(routes, { provider: 'claude', action: 'update' })).status).toBe(201);
      // The sheet polls while the update runs: this read caches the old binary's answer.
      expect(await listed()).toBe('2.0.14');
      version = '2.1.3 (Claude Code)';
      ptys[0]!.finish(0);
      expect(await listed()).toBe('2.1.3');
    });

    it("on Linux, a Homebrew Claude Code updates itself: the cask's upgrade is macOS-only", async () => {
      const routes = routesWith({
        probeEnv: async () => ({ platform: 'linux', npm: true, npmGlobalWritable: true, curl: true, sudo: true, brew: true }),
        locate: (executable) => ({ executable, path: '/home/linuxbrew/.linuxbrew/bin/claude', method: 'brew', brewKind: 'formula' }),
      });
      const response = await start(routes, { provider: 'claude', action: 'update' });
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ action: 'update', command: "'claude' update" });
    });

    it('waits for running tasks unless told to update now', async () => {
      const routes = routesWith({ activeRuns: () => 2 });
      const waiting = await start(routes, { provider: 'claude', action: 'update' });
      expect(waiting.status).toBe(409);
      expect((await waiting.json() as { error: string }).error).toContain('2 tasks are running');
      const forced = await routes.request('/providers/setup/sessions', { method: 'POST', body: JSON.stringify({ provider: 'claude', action: 'update' }), headers: { 'content-type': 'application/json', 'x-cezar-force': '1' } });
      expect(forced.status).toBe(201);
    });

    it('lists the installed version, its method and the newest release only when asked', async () => {
      const fetches: string[] = [];
      const latest = new LatestVersions({ env: {}, fetch: async (url) => { fetches.push(url); return { ok: true, json: async () => ({ version: '2.1.3' }) }; } });
      const routes = routesWith({ latest });
      const plain = await (await routes.request('/providers/setup')).json() as { agents: Array<{ provider: string; latestVersion: string | null }> };
      expect(plain.agents.find((agent) => agent.provider === 'claude')?.latestVersion).toBeNull();
      expect(fetches).toEqual([]);
      const body = await (await routes.request('/providers/setup', { headers: { 'x-cezar-latest': '1' } })).json() as { interactive: boolean; agents: Array<Record<string, unknown>> };
      expect(body.interactive).toBe(true);
      expect(body.agents.find((agent) => agent.provider === 'claude')).toMatchObject({
        installed: true,
        version: '2.0.14',
        method: 'brew',
        latestVersion: '2.1.3',
        update: { command: 'brew upgrade claude-code', runnable: true },
      });
      expect(fetches).toEqual(['https://registry.npmjs.org/@anthropic-ai/claude-code/latest']);
    });

    it('on a phone: read-only, no sign-in terminal, nothing that needs a password', async () => {
      const routes = routesWith({
        phone: () => true,
        // Signed out: a computer would be allowed this sign-in, so only the phone check can refuse it.
        status: async () => ({ providers: [{ provider: 'codex', status: 'not-installed' }, { provider: 'claude', status: 'disconnected' }] }),
        locate: (executable) => ({ executable, path: '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js', method: 'npm' }),
        probeEnv: async () => ({ platform: 'linux', npm: true, npmGlobalWritable: false, curl: false, sudo: true, brew: false }),
      });
      const state = await (await routes.request('/providers/setup')).json() as { interactive: boolean };
      expect(state.interactive).toBe(false);
      const login = await start(routes, { provider: 'claude', action: 'login' });
      expect(login.status).toBe(409);
      expect((await login.json() as { error: string }).error).toContain('sign-in card');
      // codex would need `sudo npm` here: its password goes in at the computer.
      const sudo = await start(routes, { provider: 'codex', action: 'install' });
      expect(sudo.status).toBe(409);
      expect((await sudo.json() as { error: string }).error).toContain('computer password');
      expect(spawns).toHaveLength(0);
    });

    it("on a phone: cannot list, read or resize a sign-in started at the computer", async () => {
      let onPhone = false;
      const routes = routesWith({
        phone: () => onPhone,
        status: async () => ({ providers: [{ provider: 'claude', status: 'disconnected' }] }),
      });
      const created = await start(routes, { provider: 'claude', action: 'login' });
      expect(created.status).toBe(201);
      const { id } = await created.json() as { id: string };
      ptys[0]!.emit('Open https://claude.ai/oauth?code=SECRET and paste the code');

      onPhone = true;
      const listed = await (await routes.request('/providers/setup')).json() as { session: unknown };
      expect(listed.session).toBeNull();
      expect((await routes.request(`/providers/setup/sessions/${id}/output`)).status).toBe(409);
      const resized = await routes.request(`/providers/setup/sessions/${id}/resize`, { method: 'POST', body: JSON.stringify({ cols: 40, rows: 10 }), headers: { 'content-type': 'application/json' } });
      expect(resized.status).toBe(409);
      // A second start from the phone does not join it either.
      expect((await start(routes, { provider: 'claude', action: 'login' })).status).toBe(409);

      onPhone = false;
      const output = await routes.request(`/providers/setup/sessions/${id}/output`);
      expect(output.status).toBe(200);
      expect((await output.json() as { data: string }).data).toContain('SECRET');
    });

    it('on a phone: reads an install log', async () => {
      let onPhone = false;
      const routes = routesWith({
        phone: () => onPhone,
        status: async () => ({ providers: [{ provider: 'codex', status: 'not-installed' }] }),
        probeEnv: async () => ({ platform: 'linux', npm: true, npmGlobalWritable: true, curl: true, sudo: false, brew: false }),
      });
      const { id } = await (await start(routes, { provider: 'codex', action: 'install' })).json() as { id: string };
      ptys[0]!.emit('added 1 package');
      onPhone = true;
      const listed = await (await routes.request('/providers/setup')).json() as { session: { id: string } | null };
      expect(listed.session?.id).toBe(id);
      const output = await routes.request(`/providers/setup/sessions/${id}/output`);
      expect(await output.json()).toMatchObject({ data: 'added 1 package' });
    });

    it('clears the versions at the exit itself, even when no listing sees the session end', async () => {
      let probes = 0;
      let version = '2.0.14 (Claude Code)';
      const routes = routesWith({
        status: async () => ({ providers: [{ provider: 'claude', status: 'connected' }, { provider: 'codex', status: 'not-installed' }] }),
        checks: async () => { probes += 1; return [{ name: 'claude', available: true, version }]; },
      });
      const read = async () => ((await (await routes.request('/providers/setup')).json()) as { agents: Array<{ provider: string; version: string | null }> })
        .agents.find((agent) => agent.provider === 'claude')?.version;
      expect(await read()).toBe('2.0.14');
      await start(routes, { provider: 'claude', action: 'update' });
      version = '2.1.3 (Claude Code)';
      ptys[0]!.finish(0);
      // Another session starts before any listing: the update's end is never seen by a GET.
      expect((await start(routes, { provider: 'codex', action: 'install' })).status).toBe(201);
      expect(await read()).toBe('2.1.3');
      expect(probes).toBe(2);
    });

    it('sends a phone no host paths: program names only, and no sign-in line', async () => {
      const routes = routesWith({
        phone: () => true,
        executable: () => '/Users/someone/.local/bin/claude',
        locate: (executable) => ({ executable, path: executable, method: 'native' }),
      });
      const body = await (await routes.request('/providers/setup')).json() as { agents: Array<{ provider: string; loginCommand: string | null; update: { command: string | null } | null }> };
      const claude = body.agents.find((agent) => agent.provider === 'claude')!;
      expect(claude.update?.command).toBe("'claude' update");
      expect(JSON.stringify(body)).not.toContain('/Users/someone');
      expect(body.agents.every((agent) => agent.loginCommand === null)).toBe(true);
    });

    it("sends a phone no host path in any session body: a fresh start, a join, or the listing's session", async () => {
      const routes = routesWith({
        phone: () => true,
        executable: () => '/Users/someone/.local/bin/claude',
        locate: (executable) => ({ executable, path: executable, method: 'native' }),
      });
      const fresh = await start(routes, { provider: 'claude', action: 'update' });
      expect(fresh.status).toBe(201);
      const freshBody = await fresh.json() as { command: string; cwd: string; shell: string };
      expect(freshBody).toMatchObject({ command: "'claude' update", cwd: '~' });
      expect(freshBody.shell).not.toMatch(/[\\/]/);
      expect(JSON.stringify(freshBody)).not.toContain(homedir());
      expect(JSON.stringify(freshBody)).not.toContain('/Users/someone');

      const joined = await start(routes, { provider: 'claude', action: 'update' });
      expect(joined.status).toBe(201);
      const joinedBody = await joined.json() as { command: string; cwd: string; shell: string };
      expect(joinedBody).toMatchObject({ command: "'claude' update", cwd: '~' });
      expect(joinedBody.shell).not.toMatch(/[\\/]/);
      expect(JSON.stringify(joinedBody)).not.toContain(homedir());
      expect(JSON.stringify(joinedBody)).not.toContain('/Users/someone');

      const listed = await (await routes.request('/providers/setup')).json() as { session: { command: string; cwd: string; shell: string } | null };
      expect(listed.session).toMatchObject({ command: "'claude' update", cwd: '~' });
      expect(listed.session?.shell).not.toMatch(/[\\/]/);
      expect(JSON.stringify(listed)).not.toContain(homedir());
      expect(JSON.stringify(listed)).not.toContain('/Users/someone');
      // The host still runs the real binary.
      expect(spawns).toHaveLength(1);
      expect(spawns[0]!.args.at(-1)).toContain('/Users/someone/.local/bin/claude');
    });

    it('a refused listing blanks the update line and marks installs non-runnable', async () => {
      const routes = routesWith({
        refusal: () => 'Set up agents on the machine hosting cezar.',
        executable: () => '/Users/someone/.local/bin/claude',
        locate: (executable) => ({ executable, path: executable, method: 'native' }),
      });
      const body = await (await routes.request('/providers/setup')).json() as {
        available: boolean;
        agents: Array<{ provider: string; installed: boolean; install: { command: string | null; runnable: boolean }; update: { command: string | null; runnable: boolean } | null }>;
      };
      expect(body.available).toBe(false);
      const claude = body.agents.find((agent) => agent.provider === 'claude')!;
      expect(claude.installed).toBe(true);
      expect(claude.update).toMatchObject({ command: null, runnable: false });
      expect(body.agents.every((agent) => agent.install.runnable === false)).toBe(true);
      expect(body.agents.find((agent) => agent.provider === 'codex')?.install.command).toBe('npm install -g @openai/codex');
      expect(JSON.stringify(body)).not.toContain('/Users/someone');
    });

    it('after an install exits, awaits a fresh provider status instead of serving a stale not-installed cache', async () => {
      let cached: { providers: Array<{ provider: 'codex'; status: 'not-installed' | 'disconnected' }> } = {
        providers: [{ provider: 'codex', status: 'not-installed' }],
      };
      let resolveRefresh!: () => void;
      const refreshGate = new Promise<void>((resolve) => { resolveRefresh = resolve; });
      let installedOnDisk = false;
      const routes = routesWith({
        currentStatus: async () => cached,
        status: async () => {
          if (!installedOnDisk) return cached;
          await refreshGate;
          cached = { providers: [{ provider: 'codex' as const, status: 'disconnected' as const }] };
          return cached;
        },
        checks: async () => (installedOnDisk ? [{ name: 'codex', available: true, version: '0.170.0' }] : []),
        locate: (executable) => ({ executable, path: '/usr/local/lib/node_modules/@openai/codex/bin/codex.js', method: 'npm' }),
        latest: new LatestVersions({
          fetch: async () => ({ ok: true, json: async () => ({ version: '0.180.0' }) }),
        }),
      });
      expect((await start(routes, { provider: 'codex', action: 'install' })).status).toBe(201);
      installedOnDisk = true;
      ptys[0]!.finish(0);

      // A listing arriving while the refresh is still in flight awaits it rather than reading stale cache.
      const pendingListing = routes.request('/providers/setup', { headers: { 'x-cezar-latest': '1' } });
      resolveRefresh();
      const body = await (await pendingListing).json() as {
        agents: Array<{ provider: string; installed: boolean; method: string | null; update: { command: string | null; runnable: boolean } | null; latestVersion: string | null }>;
      };
      expect(body.agents.find((agent) => agent.provider === 'codex')).toMatchObject({
        installed: true,
        method: 'npm',
        update: { command: 'npm install -g @openai/codex@latest', runnable: true },
        latestVersion: '0.180.0',
      });
    });

    it('probes the versions again once an update ends, not while it runs', async () => {
      let probes = 0;
      let version = '2.0.14 (Claude Code)';
      const routes = routesWith({ checks: async () => { probes += 1; return [{ name: 'claude', available: true, version }]; } });
      const read = async () => ((await (await routes.request('/providers/setup')).json()) as { agents: Array<{ provider: string; version: string | null }> })
        .agents.find((agent) => agent.provider === 'claude')?.version;
      expect(await read()).toBe('2.0.14');
      await start(routes, { provider: 'claude', action: 'update' });
      expect(await read()).toBe('2.0.14');
      expect(probes).toBe(1);
      version = '2.1.3 (Claude Code)';
      ptys[0]!.finish(0);
      expect(await read()).toBe('2.1.3');
      expect(probes).toBe(2);
      // Once per ended session: the next read is the cache again.
      await read();
      expect(probes).toBe(2);
    });

    it('on a phone: starts a password-free install, and refuses keystrokes and resizes', async () => {
      const routes = routesWith({
        phone: () => true,
        status: async () => ({ providers: [{ provider: 'codex', status: 'not-installed' }] }),
        probeEnv: async () => ({ platform: 'linux', npm: true, npmGlobalWritable: true, curl: true, sudo: false, brew: false }),
      });
      const created = await start(routes, { provider: 'codex', action: 'install' });
      expect(created.status).toBe(201);
      const { id } = await created.json() as { id: string };
      const typed = await routes.request(`/providers/setup/sessions/${id}/input`, { method: 'POST', body: JSON.stringify({ data: 'y\n' }), headers: { 'content-type': 'application/json' } });
      expect(typed.status).toBe(409);
      expect(ptys[0]!.written).toEqual([]);
      const resized = await routes.request(`/providers/setup/sessions/${id}/resize`, { method: 'POST', body: JSON.stringify({ cols: 40, rows: 10 }), headers: { 'content-type': 'application/json' } });
      expect(resized.status).toBe(409);
    });
  });

  describe('withoutHostPaths', () => {
    it('cuts quoted and bare absolute paths to the program name, and leaves URLs and names alone', () => {
      expect(withoutHostPaths("'/Users/me/.local/bin/claude' update")).toBe("'claude' update");
      expect(withoutHostPaths("'/Users/o'\\''neil/.local/bin/claude' update")).toBe("'claude' update");
      expect(withoutHostPaths('"C:\\Users\\me\\AppData\\agy.exe" update')).toBe('"agy.exe" update');
      expect(withoutHostPaths('"C:/Users/alice/claude.exe" update')).toBe('"claude.exe" update');
      expect(withoutHostPaths('"\\\\server\\share\\claude.exe" update')).toBe('"claude.exe" update');
      expect(withoutHostPaths('"//server/share/bin/claude.exe" update')).toBe('"claude.exe" update');
      expect(withoutHostPaths('C:/Users/alice/npm.cmd install -g @openai/codex@latest')).toBe('npm.cmd install -g @openai/codex@latest');
      expect(withoutHostPaths('sudo /usr/local/bin/npm install -g @openai/codex@latest')).toBe('sudo npm install -g @openai/codex@latest');
      expect(withoutHostPaths('curl -fsSL https://antigravity.google/cli/install.sh | bash')).toBe('curl -fsSL https://antigravity.google/cli/install.sh | bash');
      expect(withoutHostPaths("'opencode' upgrade")).toBe("'opencode' upgrade");
      expect(withoutHostPaths(null)).toBeNull();
    });
  });
});
