import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { e2eStatusSchema, secretsListSchema } from '@open-mercato/cezar-contract';
import { ProviderAuthService } from '../core/provider-auth.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { defaultWorkspaceConfig } from '../workspace/config.ts';
import { registerProject } from '../workspace/projects.ts';
import { SecretStore } from '../workspace/secrets.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { E2E_SETUP_WORKFLOW_NAME, E2E_WORKFLOW_FILE } from '../e2e-setup.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

vi.mock('../core/claude-bin.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/claude-bin.ts')>()),
  resolveClaudeBin: () => process.env.CEZ_CLAUDE_BIN ?? 'claude',
}));
vi.mock('../core/junie-auth-probe.ts', () => ({
  probeJunieAuthentication: vi.fn(async () => ({ connected: false })),
}));

const KEY = 'sk-ant-test-value-that-must-never-leak-0123456789';

describe('one-click e2e setup API (spec 2026-10-10-e2e-one-click-setup)', () => {
  let root: string;
  let store: RunStore;
  let secrets: SecretStore;
  let started: Array<{ workflow: WorkflowDef; input: StartRunInput }>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-e2e-setup-'));
    vi.stubEnv('CEZ_HOME', join(root, 'home'));
    vi.stubEnv('CEZ_SINGLE_PROJECT', '0');
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(root, '.ai/cezar'));
    secrets = new SecretStore(process.env, { keychain: async () => null });
    started = [];
  });
  afterEach(() => {
    store.flush();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const gitInit = () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(root, 'README.md'), 'hi\n');
    git('add', 'README.md');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  };

  const manager = {
    startRun: (workflow: WorkflowDef, input: StartRunInput): RunRecord => {
      started.push({ workflow, input });
      return store.createRun({
        title: input.task,
        workflow: workflow.name,
        task: input.task,
        autonomous: input.autonomous,
        steps: workflow.steps.map((s) => ({ id: s.id, name: s.name ?? s.id, kind: s.command ? 'check' : 'agent' })),
      });
    },
  } as unknown as RunManager;

  const app = async () => {
    const project = await registerProject(root);
    const instance = createApp({
      repoRoot: root, store, manager, version: 'test', bootProjectId: project.id, secrets,
      providerAuth: new ProviderAuthService({
        platform: 'linux',
        runCommand: async () => ({ stdout: '{"loggedIn":true}', stderr: '', exitCode: 0 }),
      }),
      workspaceConfig: {
        load: async () => ({ ...defaultWorkspaceConfig(), disabledProviders: [] }),
        mergeWrite: async () => defaultWorkspaceConfig(),
      },
    });
    return { id: project.id, instance };
  };
  const post = (body: unknown): RequestInit => ({
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const status = async (instance: Awaited<ReturnType<typeof app>>['instance'], path = '/api/v1/e2e') =>
    e2eStatusSchema.parse(await (await apiRequest(instance, path)).json());

  it('reports an empty project, on both mounts', async () => {
    gitInit();
    const { id, instance } = await app();
    for (const path of ['/api/v1/e2e', `/api/v1/p/${id}/e2e`]) {
      expect(await status(instance, path)).toEqual({ configFile: null, workflow: false, credentials: [], setup: null });
    }
  });

  it('stores the key as a checks secret and starts the setup task without handing the agent the value', async () => {
    gitInit();
    const { instance } = await app();
    const response = await apiRequest(instance, '/api/v1/e2e/setup', post({ credential: { name: 'ANTHROPIC_API_KEY', value: KEY } }));
    expect(response.status).toBe(201);
    const { runId } = (await response.json()) as { runId: string };

    const listed = secretsListSchema.parse(await (await apiRequest(instance, '/api/v1/secrets')).json());
    expect(listed.secrets.map((s) => [s.name, s.audiences])).toEqual([['ANTHROPIC_API_KEY', ['checks']]]);

    expect(started).toHaveLength(1);
    const [{ workflow, input }] = started as [{ workflow: WorkflowDef; input: StartRunInput }];
    expect(workflow.name).toBe(E2E_SETUP_WORKFLOW_NAME);
    // Not autonomous: an autonomous run skips the review gate, and the setup must be reviewed.
    expect(input.autonomous).toBeUndefined();
    expect(workflow.steps.map((s) => s.id)).toEqual(['setup', 'e2e-list', 'e2e-smoke']);
    const everything = JSON.stringify({ workflow, input });
    expect(everything).not.toContain(KEY);
    // The agent is told WHICH key exists, so it wires the matching provider package.
    expect(workflow.steps[0]!.prompt).toContain('ANTHROPIC_API_KEY');
    expect(workflow.steps[0]!.prompt).toContain('@ai-sdk/anthropic');

    expect(await status(instance)).toEqual({
      configFile: null, workflow: false, credentials: ['ANTHROPIC_API_KEY'], setup: { runId, status: 'queued' },
    });
  });

  it('starts without a key, and refuses a second setup while the first is in flight', async () => {
    gitInit();
    const { instance } = await app();
    expect((await apiRequest(instance, '/api/v1/e2e/setup', post({}))).status).toBe(201);
    expect(started[0]!.workflow.steps[0]!.prompt).toContain('No model key is stored yet');
    const again = await apiRequest(instance, '/api/v1/e2e/setup', post({}));
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toContain('already in progress');
    expect(started).toHaveLength(1);
  });

  it('allows a new setup once the previous one settled', async () => {
    gitInit();
    const { instance } = await app();
    expect((await apiRequest(instance, '/api/v1/e2e/setup', post({}))).status).toBe(201);
    const first = store.listRuns()[0]!;
    store.updateRun(first.id, { status: 'failed' });
    expect((await apiRequest(instance, '/api/v1/e2e/setup', post({}))).status).toBe(201);
    expect(started).toHaveLength(2);
  });

  it('refuses a project that is not a git repository, before storing anything', async () => {
    const { instance } = await app();
    const response = await apiRequest(instance, '/api/v1/e2e/setup', post({ credential: { name: 'OPENAI_API_KEY', value: KEY } }));
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain('git repository');
    expect(secretsListSchema.parse(await (await apiRequest(instance, '/api/v1/secrets')).json()).secrets).toEqual([]);
    expect(started).toHaveLength(0);
  });

  it('rejects a key name it does not know how to wire', async () => {
    gitInit();
    const { instance } = await app();
    const response = await apiRequest(instance, '/api/v1/e2e/setup', post({ credential: { name: 'MY_KEY', value: KEY } }));
    expect(response.status).toBe(400);
    expect(started).toHaveLength(0);
  });

  it('reads what landed in the checkout, and a workspace key counts', async () => {
    gitInit();
    writeFileSync(join(root, 'e2e.config.ts'), 'export default {}\n');
    mkdirSync(join(root, '.ai/cezar/workflows'), { recursive: true });
    writeFileSync(join(root, E2E_WORKFLOW_FILE), 'name: implement-and-e2e\n');
    await secrets.set({ kind: 'workspace' }, 'AI_GATEWAY_API_KEY', KEY, ['checks']);
    // A key only cezar's own features may read is not one the e2e check can use.
    await secrets.set({ kind: 'workspace' }, 'OPENAI_API_KEY', KEY, ['cezar']);
    const { instance } = await app();
    expect(await status(instance)).toEqual({
      configFile: 'e2e.config.ts', workflow: true, credentials: ['AI_GATEWAY_API_KEY'], setup: null,
    });
  });
});
