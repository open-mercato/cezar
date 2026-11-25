import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import { LatestVersions } from '../core/agent-cli-versions.ts';
import { agentSetupRoutes } from './agent-setup-routes.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp, type ServerDeps } from './server.ts';
import type { PtyBinding, PtyProcess, PtySpawnOptions } from './terminal/pty-module.ts';
import { TerminalSessions } from './terminal/sessions.ts';

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
    const body = await response.json() as { available: boolean; session: unknown; agents: Array<{ provider: string; installCommand: string | null }> };
    expect(body.available).toBe(true);
    expect(body.session).toBeNull();
    expect(body.agents.map((agent) => agent.provider)).toEqual([...RUNNER_IDS]);
    expect(body.agents.find((agent) => agent.provider === 'codex')?.installCommand).toBe('npm install -g @openai/codex');
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

  it('answers a copy-only agent with its command instead of running it', async () => {
    const junie = await post(build(), { provider: 'junie', action: 'install' });
    expect(junie.status).toBe(409);
    expect(await junie.json()).toMatchObject({ command: 'npm install -g @jetbrains/junie' });
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
    expect(second.status).toBe(200);
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
    // The commands to copy stay, but nothing that names the host's binary path.
    const agents = (state as unknown as { agents: Array<{ provider: string; loginCommand: string | null; install: { command: string | null } }> }).agents;
    expect(agents.find((agent) => agent.provider === 'codex')?.install.command).toBe('npm install -g @openai/codex');
    expect(agents.every((agent) => agent.loginCommand === null)).toBe(true);
    expect((await post(app, { provider: 'codex', action: 'install' })).status).toBe(409);
    expect(spawns).toHaveLength(0);
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
      probeEnv: async () => ({ platform: 'linux', npm: true, npmGlobalWritable: true, curl: true, sudo: true, brew: true }),
      checks: async () => [{ name: 'claude', available: true, version: '2.0.14 (Claude Code)' }],
      locate: (executable) => ({ executable, path: '/opt/homebrew/bin/claude', method: 'brew' }),
      ...over,
    });
    const start = (routes: ReturnType<typeof routesWith>, body: unknown) =>
      routes.request('/providers/setup/sessions', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

    it('updates the copy that is installed, the way it was installed', async () => {
      const response = await start(routesWith(), { provider: 'claude', action: 'update' });
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ action: 'update', command: 'brew upgrade claude-code' });
    });

    it('waits for running tasks unless told to update now', async () => {
      const routes = routesWith({ activeRuns: () => 2 });
      const waiting = await start(routes, { provider: 'claude', action: 'update' });
      expect(waiting.status).toBe(409);
      expect((await waiting.json() as { error: string }).error).toContain('2 tasks are running');
      expect((await start(routes, { provider: 'claude', action: 'update', force: true })).status).toBe(201);
    });

    it('lists the installed version, its method and the newest release only when asked', async () => {
      const fetches: string[] = [];
      const latest = new LatestVersions({ env: {}, fetch: async (url) => { fetches.push(url); return { ok: true, json: async () => ({ version: '2.1.3' }) }; } });
      const routes = routesWith({ latest });
      const plain = await (await routes.request('/providers/setup')).json() as { agents: Array<{ provider: string; latestVersion: string | null }> };
      expect(plain.agents.find((agent) => agent.provider === 'claude')?.latestVersion).toBeNull();
      expect(fetches).toEqual([]);
      const body = await (await routes.request('/providers/setup?latest=1')).json() as { interactive: boolean; agents: Array<Record<string, unknown>> };
      expect(body.interactive).toBe(true);
      expect(body.agents.find((agent) => agent.provider === 'claude')).toMatchObject({
        installed: true,
        version: '2.0.14',
        method: 'brew',
        latestVersion: '2.1.3',
        versionState: 'update-available',
        update: { command: 'brew upgrade claude-code', runnable: true },
      });
      expect(fetches).toEqual(['https://registry.npmjs.org/@anthropic-ai/claude-code/latest']);
    });

    it('on a phone: read-only, no sign-in terminal, nothing that needs a password', async () => {
      const routes = routesWith({
        phone: () => true,
        status: async () => ({ providers: [{ provider: 'codex', status: 'not-installed' }, { provider: 'claude', status: 'connected' }] }),
        locate: (executable) => ({ executable, path: '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js', method: 'npm' }),
        probeEnv: async () => ({ platform: 'linux', npm: true, npmGlobalWritable: false, curl: false, sudo: true, brew: false }),
      });
      const state = await (await routes.request('/providers/setup')).json() as { interactive: boolean };
      expect(state.interactive).toBe(false);
      expect((await start(routes, { provider: 'claude', action: 'login' })).status).toBe(409);
      // codex would need `sudo npm` here: its password goes in at the computer.
      const sudo = await start(routes, { provider: 'codex', action: 'install' });
      expect(sudo.status).toBe(409);
      expect(await sudo.json()).toMatchObject({ command: 'sudo npm install -g @openai/codex' });
      expect(spawns).toHaveLength(0);
    });

    it('on a phone: starts a password-free install, and refuses keystrokes', async () => {
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
    });
  });
});
