import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';
import type { RunRecord } from '../runs/store.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';

/** `POST /api/v1/runs` `sourceUrl` (#1601) — the structured link from a run back to its GitHub item. */
describe('POST /api/v1/runs sourceUrl', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let seen: StartRunInput | undefined;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-srcurl-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    seen = undefined;
    const manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) => {
        seen = input;
        return store.createRun({ title: 't', workflow: '(planned)', task: input.task, steps: [] });
      },
    } as unknown as RunManager;
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test', providerAuth: connectedProviderAuth() });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const post = (body: unknown) =>
    apiRequest(app, '/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const base = { task: 'fix it', steps: [{ id: 'work', prompt: '{{task}}' }] };

  it('hands the item URL to the manager', async () => {
    const res = await post({ ...base, sourceUrl: 'https://github.com/acme/demo/issues/142' });
    expect(res.status).toBe(201);
    expect(seen?.sourceUrl).toBe('https://github.com/acme/demo/issues/142');
  });

  it('omits it when absent and rejects a non-URL', async () => {
    expect((await post(base)).status).toBe(201);
    expect(seen && 'sourceUrl' in seen).toBe(false);
    expect((await post({ ...base, sourceUrl: 'not a url' })).status).toBe(400);
  });
});
