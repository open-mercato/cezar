import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunnerModelCatalog, type ModelOption } from '../core/runner-model-catalog.ts';
import { mergeWriteAgentAccounts } from '../workspace/agent-accounts.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

describe('workspace model catalog API', () => {
  let root: string;
  let store: RunStore;
  let home: string | undefined;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.CEZ_HOME;
    root = mkdtempSync(join(tmpdir(), 'cez-models-api-'));
    store = RunStore.open(join(root, '.ai/cezar'));
  });

  afterEach(() => {
    store.flush();
    rmSync(root, { recursive: true, force: true });
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    home = undefined;
    if (previousHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = previousHome;
  });

  type Discover = () => Promise<Array<{ id: string; label: string; description: string }>>;

  /** The route contract is what is under test; each adapter's wire handling lives in its own test. */
  const app = (discover: Discover, opencodeDiscover: Discover = discover) =>
    createApp({
      repoRoot: root,
      store,
      manager: {} as RunManager,
      version: 'test',
      modelCatalog: new RunnerModelCatalog({
        adapters: {
          claude: { discover },
          codex: { discover },
          opencode: { discover: opencodeDiscover },
          junie: { discover },
        },
      }),
    });

  it.each([
    ['codex', 'gpt-future'],
    ['claude', 'opus[1m]'],
    ['junie', 'v1:model:junie:sonnet'],
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
    ['junie', 'Junie model discovery is temporarily unavailable'],
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

  it('answers the OpenCode catalog too — the runner that used to have no discovery path (#794)', async () => {
    const server = app(
      async () => [{ id: 'gpt-future', label: 'GPT Future', description: 'Newly available' }],
      async () => [{ id: 'openai/gpt-5.4', label: 'openai/gpt-5.4', description: 'via openai' }],
    );
    const response = await apiRequest(server, '/api/v1/models?runner=opencode');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runner: 'opencode',
      models: [{ id: 'openai/gpt-5.4', description: 'via openai' }],
      source: 'live',
    });
  });

  it('degrades an OpenCode discovery failure the same way', async () => {
    const server = app(async () => [], async () => { throw new Error('secret detail'); });
    const response = await apiRequest(server, '/api/v1/models?runner=opencode');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      runner: 'opencode', models: [], source: 'unavailable', stale: false,
      reason: 'OpenCode model discovery is temporarily unavailable',
    });
  });

  // Every runner cezar ships now discovers, so only a MISSING or unknown `runner` is rejected.
  it.each(['/api/v1/models', '/api/v1/models?runner=nope'])('rejects invalid query %s', async (path) => {
    const response = await apiRequest(app(async () => []), path);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'runner must be claude, codex, opencode, cursor, or junie' });
  });

  it('returns a Cursor catalog when that adapter is registered', async () => {
    const server = createApp({
      repoRoot: root,
      store,
      manager: {} as RunManager,
      version: 'test',
      modelCatalog: new RunnerModelCatalog({
        adapters: {
          cursor: {
            discover: async () => [{ id: 'composer-2.5', label: 'Composer 2.5', description: '' }],
          },
        },
      }),
    });
    const response = await apiRequest(server, '/api/v1/models?runner=cursor');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runner: 'cursor',
      models: [{ id: 'composer-2.5' }],
      source: 'live',
    });
  });

  it('is workspace-level rather than project-scoped', async () => {
    const response = await apiRequest(app(async () => []), '/api/v1/p/default/models?runner=codex');
    expect(response.status).toBe(404);
  });

  it('isolates the selected Codex account capabilities and refuses unknown or missing accounts', async () => {
    home = mkdtempSync(join(tmpdir(), 'cez-model-accounts-'));
    process.env.CEZ_HOME = home;
    const profilePath = join(home, 'research');
    mkdirSync(profilePath);
    await mergeWriteAgentAccounts((state) => {
      state.accounts.push({ id: 'research', provider: 'codex', configDir: profilePath, label: 'Research', addedAt: '' });
      state.accounts.push({ id: 'missing', provider: 'codex', configDir: join(home!, 'missing'), label: '', addedAt: '' });
    });
    const seen: Array<Record<string, string> | undefined> = [];
    const server = createApp({ repoRoot: root, store, manager: {} as RunManager, version: 'test',
      modelCatalog: new RunnerModelCatalog({ adapters: { codex: {
        discover: async (context): Promise<ModelOption[]> => {
          seen.push(context?.env);
          return [{ id: 'gpt-future', label: 'Future', description: '',
            supportedAccessModes: context?.env.CODEX_HOME === profilePath ? ['standard', 'daybreak-blue'] : ['standard'] }];
        },
      } } }),
    });
    for (const account of [undefined, 'research', undefined, 'research']) {
      const response = await apiRequest(server, `/api/v1/models?runner=codex${account ? `&agentProfile=${account}` : ''}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ models: [{ supportedAccessModes: account ? ['standard', 'daybreak-blue'] : ['standard'] }] });
    }
    expect(seen).toEqual([undefined, { CODEX_HOME: profilePath }]);
    expect((await apiRequest(server, '/api/v1/models?runner=codex&agentProfile=unknown')).status).toBe(400);
    expect((await apiRequest(server, '/api/v1/models?runner=codex&agentProfile=missing')).status).toBe(409);
    expect(seen).toHaveLength(2);
  });
});
