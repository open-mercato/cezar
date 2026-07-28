import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunnerModelCatalog } from '../core/runner-model-catalog.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

describe('workspace model catalog API', () => {
  let root: string;
  let store: RunStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-models-api-'));
    store = RunStore.open(join(root, '.ai/cezar'));
  });

  afterEach(() => {
    store.flush();
    rmSync(root, { recursive: true, force: true });
  });

  const app = (discover: () => Promise<Array<{ id: string; label: string; description: string }>>) =>
    createApp({
      repoRoot: root,
      store,
      manager: {} as RunManager,
      version: 'test',
      modelCatalog: new RunnerModelCatalog({ adapters: { codex: { discover } } }),
    });

  it('returns the discovered catalog and reuses its cache', async () => {
    let calls = 0;
    const server = app(async () => {
      calls += 1;
      return [{ id: 'gpt-future', label: 'GPT Future', description: 'Newly available' }];
    });
    for (let i = 0; i < 2; i += 1) {
      const response = await apiRequest(server, '/api/v1/models?runner=codex');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        runner: 'codex',
        models: [{ id: 'gpt-future' }],
        source: i === 0 ? 'live' : 'cache',
        stale: false,
      });
    }
    expect(calls).toBe(1);
  });

  it('degrades discovery failures to an unavailable 200 response', async () => {
    const response = await apiRequest(app(async () => { throw new Error('secret detail'); }), '/api/v1/models?runner=codex');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      runner: 'codex', models: [], source: 'unavailable', stale: false,
      reason: 'Codex model discovery is temporarily unavailable',
    });
  });

  it.each(['/api/v1/models', '/api/v1/models?runner=claude'])('rejects invalid query %s', async (path) => {
    const response = await apiRequest(app(async () => []), path);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'runner must be codex' });
  });

  it('is workspace-level rather than project-scoped', async () => {
    const response = await apiRequest(app(async () => []), '/api/v1/p/default/models?runner=codex');
    expect(response.status).toBe(404);
  });
});
