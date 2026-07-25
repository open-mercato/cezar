import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderAuthService, type ProviderId } from '../core/provider-auth.js';
import { RunStore, type RunRecord } from '../runs/store.js';
import { defaultWorkspaceConfig, type WorkspaceConfig } from '../workspace/config.js';
import { RunManager, type StartRunInput } from '../workflows/run.js';
import type { WorkflowDef } from '../workflows/types.js';
import { apiRequest } from './loopback-request.testkit.js';
import { createApp } from './server.js';

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
      store.updateRun(run.id, { currentStepId: 'task' });
      store.updateStep(run.id, 'task', { backend, status: 'running' });
    }
    return run;
  };

  beforeEach(() => {
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
    const response = await apiRequest(app, '/api/runs', {
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

  it('blocks a mixed inline workflow when one agent step uses a disabled provider', async () => {
    const response = await apiRequest(app, '/api/runs', {
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

    const response = await apiRequest(app, '/api/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'Plan it' }),
    });

    await expectDisabled(response);
  });

  it('blocks a message using the persisted current backend before delivery', async () => {
    const run = createExistingRun('codex');
    const response = await apiRequest(app, `/api/runs/${run.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Continue' }),
    });

    await expectDisabled(response);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('blocks a continue override before resuming the run', async () => {
    const run = createExistingRun('claude');
    const response = await apiRequest(app, `/api/runs/${run.id}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runner: 'codex' }),
    });

    await expectDisabled(response);
    expect(continueRun).not.toHaveBeenCalled();
  });

  it('uses the run runner, not a historical step backend, for a no-override continue', async () => {
    const run = createExistingRun('codex');
    const response = await apiRequest(app, `/api/runs/${run.id}/continue`, {
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

    const response = await apiRequest(app, `/api/runs/${run.id}/messages`, {
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
    const response = await apiRequest(app, '/api/todos/todo-1/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runner: 'codex' }),
    });

    await expectDisabled(response);
    expect(startRun).not.toHaveBeenCalled();
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
    process.env.CEZ_CODEX_BIN = join(
      process.cwd(),
      'src/core/__fixtures__/codex/mock-codex-app-server.mjs',
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

    const disabled = await apiRequest(app, '/api/providers/codex/enabled', {
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
