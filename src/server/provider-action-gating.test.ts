import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderAuthService, type ProviderId } from '../core/provider-auth.js';
import { RunStore, type RunRecord } from '../runs/store.js';
import { defaultWorkspaceConfig, type WorkspaceConfig } from '../workspace/config.js';
import type { RunManager, StartRunInput } from '../workflows/run.js';
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
    if (backend) store.updateStep(run.id, 'task', { backend });
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

  it('blocks a continue using the persisted current backend before resuming the run', async () => {
    const run = createExistingRun('codex');
    const response = await apiRequest(app, `/api/runs/${run.id}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    await expectDisabled(response);
    expect(continueRun).not.toHaveBeenCalled();
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
