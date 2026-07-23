import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderAuthService,
  type ProviderConnectionState,
  type ProviderId,
  type RunProviderCommand,
} from '../core/provider-auth.js';
import { RunStore } from '../runs/store.js';
import { RunManager } from '../workflows/run.js';
import { ProjectContexts } from './project-context.js';
import { apiRequest } from './loopback-request.testkit.js';
import { WorkspaceEventBus, createApp } from './server.js';

const CONNECTED_OUTPUT: Record<ProviderId, string> = {
  claude: '{"loggedIn":true}',
  codex: 'Logged in using ChatGPT',
  opencode: [
    '┌  Credentials ~/.local/share/opencode/auth.json',
    '●  Anthropic oauth',
    '└  1 credential',
  ].join('\n'),
};

const DISCONNECTED_OUTPUT: Record<ProviderId, string> = {
  claude: '{"loggedIn":false}',
  codex: 'Not logged in',
  opencode: [
    '┌  Credentials ~/.local/share/opencode/auth.json',
    '└  0 credentials',
  ].join('\n'),
};

const providerForExecutable = (executable: string): ProviderId => {
  if (executable === 'claude' || executable === 'codex' || executable === 'opencode') return executable;
  throw new Error(`unexpected executable: ${executable}`);
};

describe('workspace provider API', () => {
  let root: string;
  let store: RunStore;
  const savedDryRun = process.env.CEZ_DRY_RUN;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-providers-api-'));
    store = RunStore.open(join(root, '.ai/cezar'));
    delete process.env.CEZ_DRY_RUN;
  });

  afterEach(() => {
    store.flush();
    rmSync(root, { recursive: true, force: true });
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
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
    contexts: options.contexts,
  });

  const connect = (server: ReturnType<typeof app>, provider: unknown) => apiRequest(
    server,
    '/api/providers/connect',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider }),
    },
  );

  it('GET /api/providers/status returns all provider rows', async () => {
    const response = await apiRequest(app({
      providerAuth: service({ claude: 'connected', codex: 'disconnected', opencode: 'not-installed' }),
    }), '/api/providers/status');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      providers: [
        { provider: 'claude', status: 'connected' },
        { provider: 'codex', status: 'disconnected' },
        {
          provider: 'opencode',
          status: 'not-installed',
          hint: 'Install OpenCode, then run `opencode auth login`.',
        },
      ],
    });
  });

  it('GET ?refresh=1 bypasses the completed provider cache', async () => {
    const runCommand = vi.fn<RunProviderCommand>(async (executable) => ({
      stdout: CONNECTED_OUTPUT[providerForExecutable(executable)],
      stderr: '',
      exitCode: 0,
    }));
    const server = app({ providerAuth: service({}, runCommand) });

    await apiRequest(server, '/api/providers/status');
    await apiRequest(server, '/api/providers/status?refresh=1');

    expect(runCommand).toHaveBeenCalledTimes(6);
  });

  it('GET without refresh reuses the completed provider cache', async () => {
    const runCommand = vi.fn<RunProviderCommand>(async (executable) => ({
      stdout: CONNECTED_OUTPUT[providerForExecutable(executable)],
      stderr: '',
      exitCode: 0,
    }));
    const server = app({ providerAuth: service({}, runCommand) });

    await apiRequest(server, '/api/providers/status');
    await apiRequest(server, '/api/providers/status');

    expect(runCommand).toHaveBeenCalledTimes(3);
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
      hint: 'Authentication was rejected during a run. Reconnect, then check again.',
      authFailureId: 'auth-incident-1',
    }]);
    await expect((await apiRequest(server, '/api/providers/status')).json()).resolves
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
      expect((await apiRequest(server, '/api/p/lazy/runs')).status).toBe(200);
      await expect((await apiRequest(server, '/api/providers/status')).json()).resolves
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

    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledTimes(3));
    providerAuth.reportRuntimeAuthFailure('claude');
    release();

    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ opened: true, command: "'claude' auth login" });
    expect(openTerminal).toHaveBeenCalledWith(root, "'claude' auth login");
  });

  it('GET ?refresh=1 clears a runtime latch after a fresh connected probe', async () => {
    const providerAuth = service();
    providerAuth.reportRuntimeAuthFailure('claude');
    const server = app({ providerAuth });

    const response = await apiRequest(server, '/api/providers/status?refresh=1');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      providers: expect.arrayContaining([
        { provider: 'claude', status: 'connected' },
      ]),
    });
  });

  it('is workspace-level rather than project-scoped', async () => {
    const server = app();
    const status = await apiRequest(server, '/api/p/default/providers/status');
    const connectResponse = await apiRequest(server, '/api/p/default/providers/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'claude' }),
    });

    expect(status.status).toBe(404);
    expect(connectResponse.status).toBe(404);
  });

  it('does not add provider fields or calls to /api/health', async () => {
    const runCommand = vi.fn<RunProviderCommand>();
    const response = await apiRequest(app({ providerAuth: service({}, runCommand) }), '/api/health');
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
    const response = await apiRequest(app(), '/api/providers/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'provider must be claude, codex, or opencode' });
  });

  it('never places request-controlled text in the opened command', async () => {
    const openTerminal = vi.fn(async () => true);
    const injected = 'codex; touch /tmp/request-controlled';
    const response = await connect(app({ openTerminal }), injected);

    expect(response.status).toBe(400);
    expect(openTerminal).not.toHaveBeenCalled();
  });
});
