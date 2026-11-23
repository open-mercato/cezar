import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attentionOverridesResponseSchema, attentionResponseSchema } from '@open-mercato/cezar-contract';
import { createAttentionOverrideStore } from '../attention/overrides.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

vi.mock('../core/backend-detect.ts', () => ({ detectEnvironment: async () => [] }));

// Needs you triage (spec 2026-11-23-needs-you-triage): dismiss and its undo, through the routes.
describe('attention override routes', () => {
  const savedDry = process.env.CEZ_DRY_RUN;
  let repoRoot: string;
  let store: RunStore;

  beforeEach(() => {
    process.env.CEZ_DRY_RUN = '1';
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-attention-overrides-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    const run = store.createRun({ title: 'Fix login', workflow: 'quick-task', task: 't', steps: [] });
    store.updateRun(run.id, { status: 'waiting', waitingSince: new Date().toISOString() });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedDry === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDry;
  });

  it('hides a dismissed item from the list and its count, and brings it back on clear', async () => {
    const attentionOverrides = createAttentionOverrideStore(() => join(repoRoot, 'attention-overrides.json'));
    const app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', attentionOverrides });
    const list = async () => attentionResponseSchema.strict().parse(await (await apiRequest(app, '/api/v1/workspace/attention')).json());
    const post = async (path: string, body: unknown) => {
      const response = await apiRequest(app, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };

    const before = await list();
    const task = before.items.find((item) => item.kind === 'task');
    expect(task).toBeDefined();
    expect(before.counts.total).toBe(1);

    const set = await post('/api/v1/workspace/attention/overrides', { key: task!.key, mode: 'dismiss' });
    expect(set.status).toBe(200);
    expect(attentionOverridesResponseSchema.parse(set.body).overrides.map((entry) => entry.key)).toEqual([task!.key]);
    const hidden = await list();
    expect(hidden.items).toEqual([]);
    expect(hidden.counts.total).toBe(0);
    expect(hidden.overrides.map((entry) => entry.mode)).toEqual(['dismiss']);

    expect((await post('/api/v1/workspace/attention/overrides/clear', { key: task!.key })).status).toBe(200);
    expect((await list()).counts.total).toBe(1);
  }, 30_000);

  it('refuses an unknown mode', async () => {
    const app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', attentionOverrides: createAttentionOverrideStore(() => join(repoRoot, 'o.json')) });
    const response = await apiRequest(app, '/api/v1/workspace/attention/overrides', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'k', mode: 'hide' }) });
    expect(response.status).toBe(400);
  }, 30_000);
});
