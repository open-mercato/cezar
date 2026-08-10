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

  type Discover = () => Promise<Array<{ id: string; label: string; description: string }>>;

  /** Both discovering runners share one adapter here — the route contract is what is under test,
   *  and each adapter's own wire handling lives in its `*-model-catalog.test.ts`. */
  const app = (discover: Discover) =>
    createApp({
      repoRoot: root,
      store,
      manager: {} as RunManager,
      version: 'test',
      modelCatalog: new RunnerModelCatalog({
        adapters: { claude: { discover }, codex: { discover } },
      }),
    });

  it.each([
    ['codex', 'gpt-future'],
    ['claude', 'opus[1m]'],
  ])('returns %s\'s discovered catalog and reuses its cache', async (runner, id) => {
    let calls = 0;
    const server = app(async () => {
      calls += 1;
      return [{ id, label: 'Newest', description: 'Newly available' }];
    });
    for (let i = 0; i < 2; i += 1) {
      const response = await apiRequest(server, `/api/v1/models?runner=${runner}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        runner,
        models: [{ id }],
        source: i === 0 ? 'live' : 'cache',
        stale: false,
      });
    }
    expect(calls).toBe(1);
  });

  it('caches each runner separately', async () => {
    const seen: string[] = [];
    const server = createApp({
      repoRoot: root,
      store,
      manager: {} as RunManager,
      version: 'test',
      modelCatalog: new RunnerModelCatalog({
        adapters: {
          claude: { discover: async () => (seen.push('claude'), [{ id: 'sonnet', label: 'Sonnet', description: '' }]) },
          codex: { discover: async () => (seen.push('codex'), [{ id: 'gpt-future', label: 'GPT', description: '' }]) },
        },
      }),
    });
    const claude = await (await apiRequest(server, '/api/v1/models?runner=claude')).json();
    const codex = await (await apiRequest(server, '/api/v1/models?runner=codex')).json();
    expect(claude).toMatchObject({ runner: 'claude', models: [{ id: 'sonnet' }] });
    expect(codex).toMatchObject({ runner: 'codex', models: [{ id: 'gpt-future' }] });
    expect(seen).toEqual(['claude', 'codex']);
  });

  it.each([
    ['codex', 'Codex model discovery is temporarily unavailable'],
    ['claude', 'Claude model discovery is temporarily unavailable'],
  ])('degrades %s discovery failures to an unavailable 200 response', async (runner, reason) => {
    const response = await apiRequest(
      app(async () => { throw new Error('secret detail'); }),
      `/api/v1/models?runner=${runner}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      runner, models: [], source: 'unavailable', stale: false, reason,
    });
  });

  // opencode has no host-local catalog to read, so it is still not a valid runner here (#799
  // is adding one separately).
  it.each(['/api/v1/models', '/api/v1/models?runner=opencode', '/api/v1/models?runner=nope'])(
    'rejects invalid query %s',
    async (path) => {
      const response = await apiRequest(app(async () => []), path);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'runner must be claude or codex' });
    },
  );

  it('is workspace-level rather than project-scoped', async () => {
    const response = await apiRequest(app(async () => []), '/api/v1/p/default/models?runner=codex');
    expect(response.status).toBe(404);
  });
});
