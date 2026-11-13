import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { RunStore } from '../runs/store.ts';
import { GATEWAY_KEY_ENV, ModelGatewayStore } from '../workspace/model-gateway.ts';
import { RunManager } from './run.ts';

/** Spec 2026-11-10-model-gateway: an OpenCode session carries the gateway; no other backend does. */

let root: string, store: RunStore, manager: RunManager, gateway: ModelGatewayStore;
const KEY = 'acme-secret-key-123';

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'gateway-env-')));
  vi.stubEnv('CEZ_HOME', join(root, 'home'));
  vi.stubEnv('CEZ_DRY_RUN', '1');
  store = RunStore.open(join(root, 'state'));
  gateway = new ModelGatewayStore(process.env, { keychain: async () => null });
  manager = new RunManager(store, root, { modelGateway: gateway });
});
afterEach(() => {
  manager.dispose();
  store.flush();
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const envFor = async (backend: 'opencode' | 'claude' | 'codex') => {
  const run = store.createRun({ title: 't', task: 't', workflow: 'quick-task', runner: backend, steps: [{ id: 'task', name: 'task', kind: 'agent' }] });
  const seam = manager as unknown as { agentEnvForStep(id: string, backend: string): Promise<{ env: Record<string, string> }> };
  return { id: run.id, env: (await seam.agentEnvForStep(run.id, backend)).env };
};

it('hands a custom gateway to OpenCode alone, and redacts its key from the run', async () => {
  await gateway.save({ preset: 'custom', name: 'Acme', baseUrl: 'https://api.acme.example/v1', apiKey: KEY, models: ['m'], updatedAt: 'now' });
  const { id, env } = await envFor('opencode');
  expect(env[GATEWAY_KEY_ENV]).toBe(KEY);
  expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!).provider.acme.options.baseURL).toBe('https://api.acme.example/v1');
  expect(JSON.stringify(store.appendEvent(id, { type: 'note', message: `printed ${KEY}` }))).not.toContain(KEY);
  for (const backend of ['claude', 'codex'] as const) {
    const other = (await envFor(backend)).env;
    expect(Object.values(other).join('\n')).not.toContain(KEY);
    expect(other.OPENCODE_CONFIG_CONTENT).toBeUndefined();
  }
});

it('leaves OpenCode as it always was without a gateway', async () => {
  const { env } = await envFor('opencode');
  expect(env[GATEWAY_KEY_ENV]).toBeUndefined();
  expect(env.OPENROUTER_API_KEY).toBeUndefined();
  expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
});
