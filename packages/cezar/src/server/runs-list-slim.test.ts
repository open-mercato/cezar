import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/** GET /runs leaves out `workflowDef` (~1.3 MB per run); `?full=1` and GET /runs/:id keep it. */
describe('GET /runs omits workflowDef', () => {
  let repoRoot: string;
  let store: RunStore;
  let id: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-runs-slim-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    id = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] }).id;
    store.updateRun(id, { workflowDef: { name: 'w', steps: [], source: 'file' } });
  });
  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const get = async (path: string) => {
    const app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
    const res = await apiRequest(app, path);
    expect(res.status).toBe(200);
    return res.json();
  };

  it('slim by default', async () => {
    const run = ((await get('/api/v1/runs')) as Array<Record<string, unknown>>)[0]!;
    expect(run.id).toBe(id);
    expect('workflowDef' in run).toBe(false);
  });

  it('?full=1 and /runs/:id keep it', async () => {
    const run = ((await get('/api/v1/runs?full=1')) as Array<Record<string, unknown>>)[0]!;
    expect(run.workflowDef).toBeDefined();
    expect(((await get(`/api/v1/runs/${id}`)) as Record<string, unknown>).workflowDef).toBeDefined();
  });
});
