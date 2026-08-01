import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderAuthService, type ProviderId } from '../core/provider-auth.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { defaultWorkspaceConfig, type WorkspaceConfig } from '../workspace/config.ts';
import { RunManager, type StartRunInput } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

const DISABLED_MESSAGE = 'Codex is disabled. Enable it in Settings → Agents → Providers.';

const memoryWorkspaceConfig = (disabledProviders: ProviderId[] = ['codex']) => {
  let config: WorkspaceConfig = { ...defaultWorkspaceConfig(), disabledProviders };
  return {
    load: async () => config,
    mergeWrite: async (mutator: (current: WorkspaceConfig) => WorkspaceConfig | void) => {
      config = mutator(config) ?? config;
      return config;
    },
  };
};

const providerAuth = () => new ProviderAuthService({
  platform: 'linux',
  runCommand: async (executable) => {
    if (executable === 'claude') return { stdout: '{"loggedIn":true}', stderr: '', exitCode: 0 };
    if (executable === 'codex') return { stdout: 'Logged in using ChatGPT', stderr: '', exitCode: 0 };
    return {
      stdout: '┌  Credentials ~/.local/share/opencode/auth.json\n└  1 credential',
      stderr: '',
      exitCode: 0,
    };
  },
});

describe('provider action gating', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let app: Hono;
  let startRun: ReturnType<typeof vi.fn>;
  let sendMessage: ReturnType<typeof vi.fn>;
  let continueRun: ReturnType<typeof vi.fn>;
  const savedModelsLocked = process.env.CEZ_AGENT_MODELS_LOCKED;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  const savedFollowups = process.env.CEZ_FOLLOWUPS;

  const makeRun = (input: StartRunInput): RunRecord => store.createRun({
    title: 'Task',
    workflow: 'quick-task',
    task: input.task,
    runner: input.runner,
    steps: [],
  });

  const createExistingRun = (backend?: ProviderId): RunRecord => {
    const run = store.createRun({
      title: 'Existing',
      workflow: 'quick-task',
      task: 'Existing task',
      runner: 'claude',
      steps: [{ id: 'task', name: 'Task', kind: 'agent' }],
    });
    if (backend) {
      // A persisted active backend belongs to a live run. Keeping the record queued would
      // model the prompt-authoring window, where provider availability deliberately does not
      // gate mutations of the existing task.
      store.updateRun(run.id, { status: 'running', currentStepId: 'task' });
      store.updateStep(run.id, 'task', { backend, status: 'running' });
    }
    return run;
  };

  beforeEach(() => {
    delete process.env.CEZ_AGENT_MODELS_LOCKED;
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_FOLLOWUPS = '1';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-provider-action-gating-'));
    dataDir = join(repoRoot, '.ai/cezar');
    store = RunStore.open(dataDir);
    startRun = vi.fn((_workflow: WorkflowDef, input: StartRunInput) => makeRun(input));
    sendMessage = vi.fn(() => true);
    continueRun = vi.fn(() => ({ ok: true }));
    const manager = { startRun, sendMessage, continueRun } as unknown as RunManager;
    app = createApp({
      repoRoot,
      store,
      manager,
      version: 'test',
      providerAuth: providerAuth(),
      workspaceConfig: memoryWorkspaceConfig(),
    });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedModelsLocked === undefined) delete process.env.CEZ_AGENT_MODELS_LOCKED;
    else process.env.CEZ_AGENT_MODELS_LOCKED = savedModelsLocked;
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    if (savedFollowups === undefined) delete process.env.CEZ_FOLLOWUPS;
    else process.env.CEZ_FOLLOWUPS = savedFollowups;
  });

  const expectDisabled = async (response: Response) => {
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: DISABLED_MESSAGE });
  };

  it('blocks a new run selected with a disabled provider before starting it', async () => {
    const response = await apiRequest(app, '/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        task: 'Task',
        runner: 'codex',
        steps: [{ id: 'task', prompt: '{{task}}' }],
      }),
    });

    await expectDisabled(response);
    expect(startRun).not.toHaveBeenCalled();
  });

  it('keeps every runner selectable under the explicit model lock despite provider preferences', async () => {
    process.env.CEZ_AGENT_MODELS_LOCKED = '1';
    const response = await apiRequest(app, '/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        task: 'Task',
        runner: 'codex',
        steps: [{ id: 'task', prompt: '{{task}}' }],
      }),
    });

    expect(response.status).toBe(201);
    expect(startRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ runner: 'codex', model: undefined }),
    );
  });

  it('blocks a mixed inline workflow when one agent step uses a disabled provider', async () => {
    const response = await apiRequest(app, '/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        task: 'Task',
        runner: 'claude',
        steps: [
          { id: 'first', prompt: '{{task}}' },
          { id: 'check', command: 'npm test' },
          { id: 'second', prompt: '{{task}}', runner: 'codex' },
        ],
      }),
    });

    await expectDisabled(response);
    expect(startRun).not.toHaveBeenCalled();
  });

  it('blocks planning when the configured default runner is disabled', async () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ defaultRunner: 'codex' }), 'utf8');

    const response = await apiRequest(app, '/api/v1/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'Plan it' }),
    });

    await expectDisabled(response);
  });

  it('blocks a message using the persisted current backend before delivery', async () => {
    const run = createExistingRun('codex');
    const response = await apiRequest(app, `/api/v1/runs/${run.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Continue' }),
    });

    await expectDisabled(response);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('blocks a continue override before resuming the run', async () => {
    const run = createExistingRun('claude');
    const response = await apiRequest(app, `/api/v1/runs/${run.id}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runner: 'codex' }),
    });

    await expectDisabled(response);
    expect(continueRun).not.toHaveBeenCalled();
  });

  it('uses the run runner, not a historical step backend, for a no-override continue', async () => {
    const run = createExistingRun('codex');
    const response = await apiRequest(app, `/api/v1/runs/${run.id}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(200);
    expect(continueRun).toHaveBeenCalledOnce();
  });

  it('uses the active step backend, not a later historical step, for a live message', async () => {
    const run = store.createRun({
      title: 'Retrying',
      workflow: 'mixed',
      task: 'Retrying task',
      runner: 'claude',
      steps: [
        { id: 'retry', name: 'Retry', kind: 'agent' },
        { id: 'later', name: 'Later', kind: 'agent' },
      ],
    });
    store.updateRun(run.id, { currentStepId: 'retry' });
    store.updateStep(run.id, 'retry', { backend: 'claude', status: 'running' });
    store.updateStep(run.id, 'later', { backend: 'codex', status: 'done' });

    const response = await apiRequest(app, `/api/v1/runs/${run.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Continue retrying' }),
    });

    expect(response.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it('blocks starting an inbox todo with a disabled provider', async () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'todos.json'), JSON.stringify([{ id: 'todo-1', summary: 'Follow up' }]), 'utf8');
    const response = await apiRequest(app, '/api/v1/todos/todo-1/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runner: 'codex' }),
    });

    await expectDisabled(response);
    expect(startRun).not.toHaveBeenCalled();
  });
});

/**
 * The gate re-probes before it refuses (`providerActionError` in `server.ts`).
 *
 * Auth state is served stale-while-revalidate, so a cached "disconnected" can predate a login cezar
 * never saw — someone typing `claude auth login` in a terminal. Refusing on that would lock a user
 * out of their own cockpit with no way back but waiting, which is exactly what a short cache window
 * used to paper over, at the cost of making every reader of `GET /api/v1/providers/status`
 * periodically pay for a CLI spawn.
 */
describe('the gate verifies before it refuses', () => {
  let repoRoot: string;
  let store: RunStore;
  let startRun: ReturnType<typeof vi.fn>;
  const savedDryRun = process.env.CEZ_DRY_RUN;

  beforeEach(() => {
    // The whole point is the real probe path, so dry-run (which reports everything connected) must
    // be off or these would pass without exercising anything.
    delete process.env.CEZ_DRY_RUN;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-gate-verify-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    startRun = vi.fn((_workflow: WorkflowDef, input: StartRunInput) => store.createRun({
      title: 'Task',
      workflow: 'quick-task',
      task: input.task,
      runner: input.runner,
      steps: [],
    }));
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  /** A claude whose login state the test controls, with a clock it can advance. */
  const setup = (options: { disabled?: ProviderId[] } = {}) => {
    let now = 1_000;
    const state = { claudeLoggedIn: false, probes: 0 };
    const providerAuth = new ProviderAuthService({
      platform: 'linux',
      now: () => now,
      runCommand: async (executable) => {
        state.probes += 1;
        if (executable === 'claude') {
          return state.claudeLoggedIn
            ? { stdout: '{"loggedIn":true}', stderr: '', exitCode: 0 }
            : { stdout: '{"loggedIn":false}', stderr: '', exitCode: 1 };
        }
        if (executable === 'codex') return { stdout: 'Logged in using ChatGPT', stderr: '', exitCode: 0 };
        return { stdout: '└  1 credential', stderr: '', exitCode: 0 };
      },
    });
    const app = createApp({
      repoRoot,
      store,
      manager: { startRun, sendMessage: vi.fn(() => true), continueRun: vi.fn(() => ({ ok: true })) } as unknown as RunManager,
      version: 'test',
      providerAuth,
      workspaceConfig: memoryWorkspaceConfig(options.disabled ?? []),
    });
    return { app, providerAuth, state, advance: (ms: number) => { now += ms; } };
  };

  const start = (app: Hono, runner: ProviderId) => apiRequest(app, '/api/v1/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task: 'Task', runner, steps: [{ id: 'task', prompt: '{{task}}' }] }),
  });

  it('starts the run when the cached refusal is out of date — a terminal login is honoured', async () => {
    const { app, providerAuth, state, advance } = setup();
    await providerAuth.status(); // learns: claude disconnected
    advance(61_000); // …and that answer goes stale
    state.claudeLoggedIn = true; // meanwhile, the user logs in from a terminal

    const response = await start(app, 'claude');
    expect(response.status).toBe(201);
    expect(startRun).toHaveBeenCalledTimes(1);
  });

  it('still refuses when the fresh answer agrees — verifying is not a way in', async () => {
    const { app, providerAuth, advance } = setup();
    await providerAuth.status();
    advance(61_000);

    const response = await start(app, 'claude');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Claude Code credentials are unavailable. Authorize it in Settings → Agents → Providers.',
    });
    expect(startRun).not.toHaveBeenCalled();
  });

  it('cannot be talked out of a rejection it actually observed during a run', async () => {
    const { app, providerAuth, state } = setup();
    state.claudeLoggedIn = true; // credentials look fine to a probe…
    await providerAuth.status();
    providerAuth.reportRuntimeAuthFailure('claude'); // …but a run was rejected

    expect((await start(app, 'claude')).status).toBe(409);
    expect(startRun).not.toHaveBeenCalled();
  });

  it('spawns nothing to re-read a DISABLED provider — that is settings, not credentials', async () => {
    const { app, providerAuth, state } = setup({ disabled: ['codex'] });
    await providerAuth.status();
    const warmed = state.probes;

    const response = await start(app, 'codex');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: DISABLED_MESSAGE });
    expect(state.probes).toBe(warmed);
  });

  it('costs nothing on the happy path — a warm connected answer is not re-probed', async () => {
    const { app, providerAuth, state } = setup();
    state.claudeLoggedIn = true;
    await providerAuth.status();
    const warmed = state.probes;

    expect((await start(app, 'claude')).status).toBe(201);
    expect(state.probes).toBe(warmed);
  });
});

describe('provider availability preserves existing execution', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let runId: string | undefined;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  const savedCodexBin = process.env.CEZ_CODEX_BIN;

  beforeEach(() => {
    process.env.CEZ_DRY_RUN = '1';
    // Resolved from this file, not the cwd: the fixture is a sibling of the source under test,
    // so the path holds wherever vitest is invoked from and survives the tree moving.
    process.env.CEZ_CODEX_BIN = join(
      import.meta.dirname,
      '../core/__fixtures__/codex/mock-codex-app-server.mjs',
    );
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-provider-continuity-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    if (runId) manager.cancel(runId);
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    if (savedCodexBin === undefined) delete process.env.CEZ_CODEX_BIN;
    else process.env.CEZ_CODEX_BIN = savedCodexBin;
  });

  const waitFor = async (predicate: () => boolean, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('run did not reach the expected state');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  it('dequeues a task created before disable and reaches its later provider step', async () => {
    const workspaceConfig = memoryWorkspaceConfig([]);
    const app = createApp({
      repoRoot,
      store,
      manager,
      version: 'test',
      providerAuth: providerAuth(),
      workspaceConfig,
    });
    const workflow: WorkflowDef = {
      name: 'mixed-existing',
      source: 'built-in',
      steps: [
        { id: 'claude', name: 'Claude', prompt: '{{task}}', runner: 'claude' },
        { id: 'codex', name: 'Codex', prompt: '{{task}}', runner: 'codex' },
      ],
    };

    const engine = manager as unknown as { pump: () => Promise<void> };
    const pausedPump = vi.spyOn(engine, 'pump').mockResolvedValue();
    const run = manager.startRun(workflow, {
      task: 'mock:native-codex-ask choose a library',
      runner: 'claude',
      worktree: false,
    });
    runId = run.id;
    expect(store.getRun(run.id)?.status).toBe('queued');

    const disabled = await apiRequest(app, '/api/v1/providers/codex/enabled', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(disabled.status).toBe(200);
    pausedPump.mockRestore();
    void engine.pump();

    await waitFor(() => {
      const current = store.getRun(run.id);
      return current?.currentStepId === 'codex' && current.steps.find((step) => step.id === 'codex')?.status === 'waiting';
    });

    const current = store.getRun(run.id);
    expect(current?.steps.map((step) => ({ id: step.id, status: step.status, backend: step.backend }))).toEqual([
      { id: 'claude', status: 'done', backend: 'claude' },
      { id: 'codex', status: 'waiting', backend: 'codex' },
    ]);
  }, 30_000);
});
