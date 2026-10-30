import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';
import { RunStore } from '../runs/store.ts';
import { ProviderAuthService } from '../core/provider-auth.ts';
import { SecretStore } from '../workspace/secrets.ts';
import { LlmProviders } from '../workspace/llm-providers.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';

let root: string;
let store: RunStore;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'llm-api-'));
  vi.stubEnv('CEZ_HOME', join(root, 'home'));
  vi.stubEnv('CEZ_AGENT_MODELS_LOCKED', '0');
  store = RunStore.open(join(root, '.ai/cezar'));
});
afterEach(() => {
  store.flush();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it('adds write-only credentials and starts an API-backed task without a native subscription login', async () => {
  const secrets = new SecretStore(process.env, { keychain: async () => null });
  const startRun = vi.fn((workflow: WorkflowDef, input: StartRunInput) =>
    store.createRun({
      title: 'API task',
      workflow: workflow.name,
      task: input.task,
      runner: input.runner,
      model: input.model,
      llmProviderId: input.llmProviderId,
      steps: [],
    }),
  );
  const app = createApp({
    repoRoot: root,
    store,
    manager: { startRun } as unknown as RunManager,
    version: 'test',
    secrets,
    providerAuth: new ProviderAuthService({
      runCommand: async () => ({
        stdout: '{"loggedIn":false}',
        stderr: '',
        exitCode: 1,
      }),
    }),
  });
  const apiKey = 'only-the-selected-process-may-see-this-key';
  const added = await apiRequest(app, '/api/v1/llm-providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'openrouter',
      name: 'OpenRouter',
      protocol: 'openai-completions',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey,
    }),
  });
  expect(added.status).toBe(201);
  const provider = (await added.json()) as { id: string };
  expect(JSON.stringify(provider)).not.toContain(apiKey);
  const listed = await apiRequest(app, '/api/v1/llm-providers');
  expect(await listed.text()).not.toContain(apiKey);
  const request = {
    workflow: 'quick-task',
    task: 'Use the explicit API connection',
    runner: 'claude',
    model: 'anthropic/example',
    llmProviderId: provider.id,
    worktree: false,
  };
  const launched = await apiRequest(app, '/api/v1/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  expect(launched.status).toBe(201);
  expect(startRun).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      llmProviderId: provider.id,
      model: request.model,
    }),
  );
  expect(await launched.text()).not.toContain(apiKey);
  await new LlmProviders(secrets).remove(provider.id);
  const refused = await apiRequest(app, '/api/v1/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  expect(refused.status).toBe(409);
  expect(startRun).toHaveBeenCalledTimes(1);
});
