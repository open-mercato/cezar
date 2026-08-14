import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderAuthService,
  type ProviderConnectionState,
  type ProviderId,
  type RunProviderCommand,
} from '../core/provider-auth.ts';
import { RunStore } from '../runs/store.ts';
import { defaultWorkspaceConfig, type WorkspaceConfig } from '../workspace/config.ts';
import { RunManager } from '../workflows/run.ts';
import { ProjectContexts } from './project-context.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { WorkspaceEventBus, createApp } from './server.ts';

const CONNECTED_OUTPUT: Record<ProviderId, string> = {
  claude: '{"loggedIn":true}',
  codex: 'Logged in using ChatGPT',
  opencode: [
    '┌  Credentials ~/.local/share/opencode/auth.json',
    '●  Anthropic oauth',
    '└  1 credential',
  ].join('\n'),
  pi: 'provider  model  context  max-out  thinking  images\nanthropic  claude  200K  64K  yes  yes',
};

const DISCONNECTED_OUTPUT: Record<ProviderId, string> = {
  claude: '{"loggedIn":false}',
  codex: 'Not logged in',
  opencode: [
    '┌  Credentials ~/.local/share/opencode/auth.json',
    '└  0 credentials',
  ].join('\n'),
  pi: 'No models available. Use /login to authenticate.',
};

const providerForExecutable = (executable: string): ProviderId => {
  if (executable === 'claude' || executable === 'codex' || executable === 'opencode' || executable === 'pi') return executable;
  throw new Error(`unexpected executable: ${executable}`);
};

const memoryWorkspaceConfig = (disabledProviders: ProviderId[] = []) => {
  let config: WorkspaceConfig = {
    ...defaultWorkspaceConfig(),
    disabledProviders,
  };
  return {
    load: async () => config,
    mergeWrite: async (mutator: (current: WorkspaceConfig) => WorkspaceConfig | void) => {
      config = mutator(config) ?? config;
      return config;
    },
  };
};

describe('workspace provider API', () => {
  let root: string;
  let store: RunStore;
  const savedModelsLocked = process.env.CEZ_AGENT_MODELS_LOCKED;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  const savedRemote = process.env.CEZ_REMOTE;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-providers-api-'));
    store = RunStore.open(join(root, '.ai/cezar'));
    delete process.env.CEZ_AGENT_MODELS_LOCKED;
    delete process.env.CEZ_DRY_RUN;
    delete process.env.CEZ_REMOTE;
  });

  afterEach(() => {
    store.flush();
    rmSync(root, { recursive: true, force: true });
    if (savedModelsLocked === undefined) delete process.env.CEZ_AGENT_MODELS_LOCKED;
    else process.env.CEZ_AGENT_MODELS_LOCKED = savedModelsLocked;
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    if (savedRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = savedRemote;
  });

  const service = (
    states: Partial<Record<ProviderId, ProviderConnectionState>> = {},
    onRun?: RunProviderCommand,
    createAuthFailureId?: () => string,
  ) => new ProviderAuthService({
    platform: 'linux',
    createAuthFailureId,
    runCommand: onRun ?? (async (executable) => {
      const provider = providerForExecutable(executable);
      const state = states[provider] ?? 'connected';
      if (state === 'not-installed') {
        return { stdout: 'secret output', stderr: 'secret error', exitCode: null, errorCode: 'ENOENT' };
      }
      if (state === 'unknown') {
        return { stdout: 'secret output', stderr: 'secret error', exitCode: 17 };
      }
      return {
        stdout: state === 'connected' ? CONNECTED_OUTPUT[provider] : DISCONNECTED_OUTPUT[provider],
        stderr: '',
        exitCode: state === 'connected' || provider === 'opencode' ? 0 : 1,
      };
    }),
  });

  const app = (options: {
    providerAuth?: ProviderAuthService;
    openTerminal?: (cwd: string, command: string) => Promise<boolean>;
    bindHost?: string;
    workspaceEvents?: WorkspaceEventBus;
    workspaceConfig?: ReturnType<typeof memoryWorkspaceConfig>;
    contexts?: ProjectContexts;
  } = {}) => createApp({
    repoRoot: root,
    store,
    manager: {} as RunManager,
    version: 'test',
    providerAuth: options.providerAuth ?? service(),
    openTerminal: options.openTerminal,
    bindHost: options.bindHost,
    workspaceEvents: options.workspaceEvents,
    workspaceConfig: options.workspaceConfig,
    contexts: options.contexts,
  });

  const connect = (server: ReturnType<typeof app>, provider: unknown) => apiRequest(
    server,
    '/api/v1/providers/connect',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider }),
    },
  );

  const retry = (server: ReturnType<typeof app>, provider: string, body: unknown) => apiRequest(
    server,
    `/api/v1/providers/${provider}/retry`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );

  it('GET /api/v1/providers/status returns all provider rows with global enablement', async () => {
    const workspaceConfig = memoryWorkspaceConfig(['codex']);
    const response = await apiRequest(app({
      providerAuth: service({ claude: 'connected', codex: 'disconnected', opencode: 'not-installed' }),
      workspaceConfig,
    }), '/api/v1/providers/status');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      providers: [
        { provider: 'claude', status: 'connected', enabled: true },
        { provider: 'codex', status: 'disconnected', enabled: false },
        {
          provider: 'opencode',
          status: 'not-installed',
          hint: 'Install OpenCode, then run `opencode auth login`.',
          enabled: true,
        },
        { provider: 'pi', status: 'connected', enabled: true },
      ],
    });
  });

  it('GET /api/v1/providers/status skips probes and provider preferences under the explicit model lock', async () => {
    process.env.CEZ_AGENT_MODELS_LOCKED = '1';
    const runCommand = vi.fn<RunProviderCommand>();
    const workspaceConfig = memoryWorkspaceConfig(['claude', 'codex', 'opencode', 'pi']);
    const response = await apiRequest(app({
      providerAuth: service({}, runCommand),
      workspaceConfig,
    }), '/api/v1/providers/status?refresh=1');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      providers: [
        { provider: 'claude', status: 'connected', enabled: true },
        { provider: 'codex', status: 'connected', enabled: true },
        { provider: 'opencode', status: 'connected', enabled: true },
        { provider: 'pi', status: 'connected', enabled: true },
      ],
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('PUT /api/v1/providers/:provider/enabled updates the global preference and emits one enriched row', async () => {
    const workspaceConfig = memoryWorkspaceConfig(['codex']);
    const workspaceEvents = new WorkspaceEventBus();
    const seen: unknown[] = [];
    workspaceEvents.on((event, data) => {
      if (event === 'provider-status') seen.push(data);
    });
    const server = app({ workspaceConfig, workspaceEvents });

    const disabled = await apiRequest(server, '/api/v1/providers/claude/enabled', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });

    expect(disabled.status).toBe(200);
    const body = await disabled.json() as { providers: unknown[] };
    expect(body.providers).toContainEqual({
      provider: 'claude',
      status: 'connected',
      enabled: false,
    });
    expect((await workspaceConfig.load()).disabledProviders).toEqual(['claude', 'codex']);
    expect(seen).toEqual([{
      provider: 'claude',
      status: 'connected',
      enabled: false,
    }]);

    const enabled = await apiRequest(server, '/api/v1/providers/claude/enabled', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });

    expect(enabled.status).toBe(200);
    const enabledBody = await enabled.json() as { providers: unknown[] };
    expect(enabledBody.providers).toContainEqual({
      provider: 'claude',
      status: 'connected',
      enabled: true,
    });
    expect((await workspaceConfig.load()).disabledProviders).toEqual(['codex']);
    expect(seen).toEqual([
      { provider: 'claude', status: 'connected', enabled: false },
      { provider: 'claude', status: 'connected', enabled: true },
    ]);
  });

  it.each([
    ['/api/v1/providers/future/enabled', { enabled: false }],
    ['/api/v1/providers/claude/enabled', { enabled: 'no' }],
    ['/api/v1/providers/claude/enabled', undefined],
    ['/api/v1/providers/claude/enabled', { enabled: false, extra: true }],
  ])('PUT /api/v1/providers/:provider/enabled rejects invalid input %#', async (path, body) => {
    const response = await apiRequest(app(), path, {
      method: 'PUT',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'provider and enabled boolean are required' });
  });

  it('PUT /api/v1/providers/:provider/enabled returns a fixed error and emits nothing when preference saving fails', async () => {
    const workspaceConfig = memoryWorkspaceConfig();
    const mergeWrite = vi.spyOn(workspaceConfig, 'mergeWrite').mockRejectedValue(new Error('read-only home'));
    const workspaceEvents = new WorkspaceEventBus();
    const seen: unknown[] = [];
    workspaceEvents.on((event, data) => {
      if (event === 'provider-status') seen.push(data);
    });

    const response = await apiRequest(app({ workspaceConfig, workspaceEvents }), '/api/v1/providers/claude/enabled', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Provider preference could not be saved.' });
    expect(mergeWrite).toHaveBeenCalledOnce();
    expect(seen).toEqual([]);
  });

  it('GET ?refresh=1 bypasses the completed provider cache', async () => {
    const runCommand = vi.fn<RunProviderCommand>(async (executable) => ({
      stdout: CONNECTED_OUTPUT[providerForExecutable(executable)],
      stderr: '',
      exitCode: 0,
    }));
    const server = app({ providerAuth: service({}, runCommand) });

    await apiRequest(server, '/api/v1/providers/status');
    await apiRequest(server, '/api/v1/providers/status?refresh=1');

    expect(runCommand).toHaveBeenCalledTimes(8);
  });

  it('GET without refresh reuses the completed provider cache', async () => {
    const runCommand = vi.fn<RunProviderCommand>(async (executable) => ({
      stdout: CONNECTED_OUTPUT[providerForExecutable(executable)],
      stderr: '',
      exitCode: 0,
    }));
    const server = app({ providerAuth: service({}, runCommand) });

    await apiRequest(server, '/api/v1/providers/status');
    await apiRequest(server, '/api/v1/providers/status');

    expect(runCommand).toHaveBeenCalledTimes(4);
  });

  it('POST /api/v1/providers/:provider/retry clears only the current incident without enabling a disabled provider', async () => {
    const providerAuth = service({}, undefined, () => 'auth-incident-1');
    const incident = providerAuth.reportRuntimeAuthFailure('claude')?.status.authFailureId;
    const workspaceConfig = memoryWorkspaceConfig(['claude']);
    const workspaceEvents = new WorkspaceEventBus();
    const seen: unknown[] = [];
    workspaceEvents.on((event, data) => {
      if (event === 'provider-status') seen.push(data);
    });

    const response = await retry(app({ providerAuth, workspaceConfig, workspaceEvents }), 'claude', {
      authFailureId: incident,
    });
    const raw = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(raw)).toMatchObject({
      providers: expect.arrayContaining([{
        provider: 'claude',
        status: 'connected',
        enabled: false,
      }]),
    });
    expect((await workspaceConfig.load()).disabledProviders).toEqual(['claude']);
    expect(seen).toEqual([{
      provider: 'claude',
      status: 'connected',
      enabled: false,
    }]);
    expect(raw).not.toContain('secret output');
    expect(raw).not.toContain('secret error');
  });

  it('POST /api/v1/providers/:provider/retry rejects a stale incident and retains the latch', async () => {
    const providerAuth = service({}, undefined, () => 'auth-incident-1');
    providerAuth.reportRuntimeAuthFailure('claude');
    const server = app({ providerAuth });

    const response = await retry(server, 'claude', { authFailureId: 'stale-incident' });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Authentication incident changed. Refresh and try again.',
    });
    await expect((await apiRequest(server, '/api/v1/providers/status')).json()).resolves.toMatchObject({
      providers: expect.arrayContaining([
        expect.objectContaining({ provider: 'claude', authFailureId: 'auth-incident-1' }),
      ]),
    });
  });

  it.each([
    ['/api/v1/providers/future/retry', { authFailureId: 'auth-incident-1' }],
    ['/api/v1/providers/claude/retry', {}],
    ['/api/v1/providers/claude/retry', { authFailureId: '' }],
    ['/api/v1/providers/claude/retry', { authFailureId: 'auth-incident-1', extra: true }],
  ])('POST /api/v1/providers/:provider/retry rejects malformed input %#', async (path, body) => {
    const response = await apiRequest(app(), path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'provider and current authFailureId are required',
    });
  });

  it('changes API truth immediately after a runtime auth rejection', async () => {
    const providerAuth = service({}, undefined, () => 'auth-incident-1');
    const bus = new WorkspaceEventBus();
    const seen: unknown[] = [];
    bus.on((event, data) => {
      if (event === 'provider-status') seen.push(data);
    });
    const server = app({ providerAuth, workspaceEvents: bus });
    const run = store.createRun({
      title: 'auth',
      workflow: 'quick-task',
      task: 'work',
      runner: 'claude',
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });
    store.updateStep(run.id, 'work', { backend: 'claude' });

    store.appendEvent(run.id, {
      type: 'error',
      stepId: 'work',
      message: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
    });

    expect(seen).toEqual([{
      provider: 'claude',
      status: 'disconnected',
      hint: 'Authentication was rejected during a run. Reconnect, then try again.',
      authFailureId: 'auth-incident-1',
    }]);
    await expect((await apiRequest(server, '/api/v1/providers/status')).json()).resolves
      .toMatchObject({
        providers: expect.arrayContaining([
          expect.objectContaining({
            provider: 'claude',
            status: 'disconnected',
            authFailureId: 'auth-incident-1',
          }),
        ]),
      });
  });

  it('observes a lazy-project auth failure emitted during recovery', async () => {
    const lazyRoot = mkdtempSync(join(tmpdir(), 'cez-providers-lazy-'));
    const lazyStore = RunStore.open(join(lazyRoot, '.ai/cezar'), { keepLive: true });
    const run = lazyStore.createRun({
      title: 'lazy recovery',
      workflow: 'quick-task',
      task: 'work',
      runner: 'claude',
      steps: [],
    });
    lazyStore.flush();
    lazyStore.removeAllListeners();

    const contexts = new ProjectContexts({
      listProjects: async () => [{ id: 'lazy', root: lazyRoot, status: 'not-git' }],
    });
    const providerAuth = service();
    const recover = vi.spyOn(RunManager.prototype, 'recover').mockImplementationOnce(
      async function recoveryFailure(this: RunManager) {
        const recoveringStore = (
          this as unknown as { store: RunStore }
        ).store;
        recoveringStore.appendEvent(run.id, {
          type: 'error',
          message: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
        });
      },
    );

    try {
      const server = app({ providerAuth, contexts });
      expect((await apiRequest(server, '/api/v1/p/lazy/runs')).status).toBe(200);
      await expect((await apiRequest(server, '/api/v1/providers/status')).json()).resolves
        .toMatchObject({
          providers: expect.arrayContaining([
            expect.objectContaining({ provider: 'claude', status: 'disconnected' }),
          ]),
        });
    } finally {
      recover.mockRestore();
      contexts.disposeAll();
      rmSync(lazyRoot, { recursive: true, force: true });
    }
  });

  it('POST still opens Claude login when a runtime latch overlays a connected probe', async () => {
    const providerAuth = service();
    providerAuth.reportRuntimeAuthFailure('claude');
    const openTerminal = vi.fn(async () => true);

    const response = await connect(app({ providerAuth, openTerminal }), 'claude');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ opened: true, command: "'claude' auth login" });
    expect(openTerminal).toHaveBeenCalledWith(root, "'claude' auth login");
  });

  it('POST opens login when a runtime rejection arrives during its status probe', async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const runCommand = vi.fn<RunProviderCommand>(async (executable) => {
      await waiting;
      return {
        stdout: CONNECTED_OUTPUT[providerForExecutable(executable)],
        stderr: '',
        exitCode: 0,
      };
    });
    const providerAuth = service({}, runCommand);
    const openTerminal = vi.fn(async () => true);
    const pending = connect(app({ providerAuth, openTerminal }), 'claude');

    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledTimes(4));
    providerAuth.reportRuntimeAuthFailure('claude');
    release();

    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ opened: true, command: "'claude' auth login" });
    expect(openTerminal).toHaveBeenCalledWith(root, "'claude' auth login");
  });

  it('GET ?refresh=1 retains a runtime latch after a fresh connected probe', async () => {
    const providerAuth = service();
    const failure = providerAuth.reportRuntimeAuthFailure('claude');
    const server = app({ providerAuth });

    const response = await apiRequest(server, '/api/v1/providers/status?refresh=1');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      providers: expect.arrayContaining([
        {
          provider: 'claude',
          status: 'disconnected',
          enabled: true,
          hint: 'Authentication was rejected during a run. Reconnect, then try again.',
          authFailureId: failure?.status.authFailureId,
        },
      ]),
    });
  });

  it('is workspace-level rather than project-scoped', async () => {
    const server = app();
    const status = await apiRequest(server, '/api/v1/p/default/providers/status');
    const connectResponse = await apiRequest(server, '/api/v1/p/default/providers/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'claude' }),
    });
    const enabledResponse = await apiRequest(server, '/api/v1/p/default/providers/claude/enabled', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    const retryResponse = await apiRequest(server, '/api/v1/p/default/providers/claude/retry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ authFailureId: 'auth-incident-1' }),
    });

    expect(status.status).toBe(404);
    expect(connectResponse.status).toBe(404);
    expect(enabledResponse.status).toBe(404);
    expect(retryResponse.status).toBe(404);
  });

  it('does not add provider fields or calls to /api/v1/health', async () => {
    const runCommand = vi.fn<RunProviderCommand>();
    const response = await apiRequest(app({ providerAuth: service({}, runCommand) }), '/api/v1/health');
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(runCommand).not.toHaveBeenCalled();
    expect(body).not.toHaveProperty('providers');
    expect(body).not.toHaveProperty('providerAuth');
  });

  it('POST opens the fixed login command for a disconnected provider', async () => {
    const openTerminal = vi.fn(async () => true);
    const response = await connect(app({
      providerAuth: service({ codex: 'disconnected' }),
      openTerminal,
    }), 'codex');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ opened: true, command: "'codex' login" });
    expect(openTerminal).toHaveBeenCalledOnce();
    expect(openTerminal).toHaveBeenCalledWith(root, "'codex' login");
  });

  it('POST returns opened false and does not open a terminal when already connected', async () => {
    const openTerminal = vi.fn(async () => true);
    const response = await connect(app({ providerAuth: service(), openTerminal }), 'claude');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      opened: false,
      connected: true,
      command: "'claude' auth login",
    });
    expect(openTerminal).not.toHaveBeenCalled();
  });

  it('POST returns 409 plus install guidance when not installed', async () => {
    const openTerminal = vi.fn(async () => true);
    const response = await connect(app({
      providerAuth: service({ opencode: 'not-installed' }),
      openTerminal,
    }), 'opencode');

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Install OpenCode, then run `opencode auth login`.',
      command: "'opencode' auth login",
    });
    expect(openTerminal).not.toHaveBeenCalled();
  });

  it('POST returns 409 plus retry guidance when status is unknown', async () => {
    const openTerminal = vi.fn(async () => true);
    const response = await connect(app({
      providerAuth: service({ claude: 'unknown' }),
      openTerminal,
    }), 'claude');

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Authentication could not be verified. Try again.',
      command: "'claude' auth login",
    });
    expect(openTerminal).not.toHaveBeenCalled();
  });

  it('POST returns a sanitized JSON error when provider status omits the requested row', async () => {
    const providerAuth = service();
    vi.spyOn(providerAuth, 'status').mockResolvedValue({
      providers: [{
        provider: 'claude',
        status: 'unknown',
        hint: 'private provider probe output',
      }],
    });
    const openTerminal = vi.fn(async () => true);

    const response = await connect(app({ providerAuth, openTerminal }), 'codex');
    const raw = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(JSON.parse(raw)).toEqual({ error: 'Authentication could not be verified. Try again.' });
    expect(raw).not.toContain('private provider probe output');
    expect(openTerminal).not.toHaveBeenCalled();
  });

  it('POST returns 409 plus command when localHandoff is false', async () => {
    const openTerminal = vi.fn(async () => true);
    const response = await connect(app({
      providerAuth: service({ codex: 'disconnected' }),
      openTerminal,
      bindHost: '0.0.0.0',
    }), 'codex');

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Run this command on the machine hosting cezar.',
      command: "'codex' login",
    });
    expect(openTerminal).not.toHaveBeenCalled();
  });

  it('POST returns 409 plus command when the terminal launcher returns false', async () => {
    const openTerminal = vi.fn(async () => false);
    const response = await connect(app({
      providerAuth: service({ codex: 'disconnected' }),
      openTerminal,
    }), 'codex');

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'No terminal emulator could be opened. Run this command manually.',
      command: "'codex' login",
    });
    expect(openTerminal).toHaveBeenCalledOnce();
  });

  it('POST returns the manual command when the terminal launcher rejects', async () => {
    const openTerminal = vi.fn(async () => {
      throw new Error('private launcher failure');
    });
    const response = await connect(app({
      providerAuth: service({ codex: 'disconnected' }),
      openTerminal,
    }), 'codex');

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'No terminal emulator could be opened. Run this command manually.',
      command: "'codex' login",
    });
    expect(openTerminal).toHaveBeenCalledOnce();
  });

  it.each([{}, { provider: 'other' }, { provider: 1 }])('rejects invalid body %# with 400', async (body) => {
    const response = await apiRequest(app(), '/api/v1/providers/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'provider must be claude, codex, opencode, or pi' });
  });

  it('never places request-controlled text in the opened command', async () => {
    const openTerminal = vi.fn(async () => true);
    const injected = 'codex; touch /tmp/request-controlled';
    const response = await connect(app({ openTerminal }), injected);

    expect(response.status).toBe(400);
    expect(openTerminal).not.toHaveBeenCalled();
  });
});
