import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { questionKey } from '@open-mercato/cezar-contract';
import { ProviderAuthService, type ProviderId } from '../core/provider-auth.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { defaultWorkspaceConfig, type WorkspaceConfig } from '../workspace/config.ts';
import { clearProjectProbeCache, listProjects, registerProject } from '../workspace/projects.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { ProjectContexts, type ProjectContext } from './project-context.ts';
import { createApp } from './server.ts';

vi.mock('../core/backend-detect.ts', () => ({ detectEnvironment: async () => [] }));

const DISABLED_MESSAGE = 'Codex is disabled. Enable it in Settings → Agents → Providers.';

const memoryWorkspaceConfig = (disabledProviders: ProviderId[]) => {
  let config: WorkspaceConfig = { ...defaultWorkspaceConfig(), disabledProviders };
  return {
    load: async () => config,
    mergeWrite: async (mutator: (current: WorkspaceConfig) => WorkspaceConfig | void) => (config = mutator(config) ?? config),
  };
};

const providerAuth = () => new ProviderAuthService({
  platform: 'linux',
  runCommand: async () => ({ stdout: '{"loggedIn":true}\nLogged in using ChatGPT', stderr: '', exitCode: 0 }),
});

/** Questions inbox spec: an inbox answer meets the provider gate the messages and Continue routes meet. */
describe('Questions inbox provider gate', () => {
  const saved = { home: process.env.CEZ_HOME, dry: process.env.CEZ_DRY_RUN };
  let home: string;
  let repoRoot: string;
  let store: RunStore;
  let contexts: ProjectContexts;
  let app: ReturnType<typeof createApp>;
  let ctx: ProjectContext;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cez-qgate-home-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-qgate-'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_DRY_RUN = '1';
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), '{"skillsRepos": []}\n', 'utf8');
    clearProjectProbeCache();
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    contexts = new ProjectContexts({ listProjects });
    await registerProject(repoRoot);
    app = createApp({
      repoRoot,
      store,
      manager: { isActive: () => false } as unknown as RunManager,
      version: '0.0.0-test',
      contexts,
      providerAuth: providerAuth(),
      workspaceConfig: memoryWorkspaceConfig(['codex']),
    });
    const [project] = await listProjects();
    ctx = await contexts.context(project!.id);
  });

  afterEach(() => {
    contexts.disposeAll();
    store.flush();
    rmSync(home, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    for (const [key, value] of [['CEZ_HOME', saved.home], ['CEZ_DRY_RUN', saved.dry]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const parkedCodexRun = () => {
    const question = { header: 'Base', question: 'Which base?', options: [{ label: 'main' }, { label: 'dev' }] };
    const run = ctx.store.createRun({ title: 't', workflow: 'quick-task', task: 't', runner: 'codex', steps: [{ id: 'task', name: 'Task', kind: 'agent' }] });
    const askedAt = new Date().toISOString();
    ctx.store.updateRun(run.id, { status: 'waiting', attentionRequest: { requestId: 'ask-1', askedAt, questions: [{ question: question.question }] } });
    ctx.store.recordTaskAsk(run.id, { requestId: 'ask-1', askedAt, questions: [question] });
    return { runId: run.id, key: questionKey({ kind: 'task', projectId: ctx.id, runId: run.id, requestId: 'ask-1' }) };
  };
  const post = (path: string, body?: unknown) =>
    apiRequest(app, path, { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  it('refuses an answer for a task whose provider is disabled, and leaves the question open', async () => {
    const { runId, key } = parkedCodexRun();
    const res = await post(`/api/v1/workspace/questions/${encodeURIComponent(key)}/answer`, { text: 'main' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: DISABLED_MESSAGE });
    expect(ctx.store.getRun(runId)?.asks?.[0]?.closed).toBeUndefined();
  });

  it('still dismisses, holding the note for the next Continue instead of waking the agent', async () => {
    const { runId, key } = parkedCodexRun();
    const res = await post(`/api/v1/workspace/questions/${encodeURIComponent(key)}/dismiss`);
    expect(res.status).toBe(200);
    expect(ctx.store.getRun(runId)?.asks?.[0]?.closed?.reason).toBe('dismissed');
    expect(ctx.store.getRun(runId)?.askNotes).toHaveLength(1);
  });
});
