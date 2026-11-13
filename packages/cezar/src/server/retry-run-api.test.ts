import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.js';
import type { RunManager } from '../workflows/run.js';
import { createApp } from './server.js';
import { apiRequest } from './loopback-request.testkit.js';

/** `POST /api/v1/runs/:id/retry` (#1733) maps the engine's answer to the wire; the engine half is
 *  pinned in `src/workflows/retry-from-node.test.ts`. */
describe('POST /runs/:id/retry', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let answer: { ok: true } | { ok: false; error: string };
  let asked: [string, string][];

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-retry-api-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    asked = [];
    answer = { ok: true };
    app = createApp({
      repoRoot,
      store,
      manager: {
        retryRun: async (id: string, node: string) => {
          asked.push([id, node]);
          return answer;
        },
      } as unknown as RunManager,
      version: '0.0.0-test',
    });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const post = (id: string, body: unknown) =>
    apiRequest(app, `/api/v1/runs/${id}/retry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const someRun = () => store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] }).id;

  it('answers retried with the node', async () => {
    const id = someRun();
    const res = await post(id, { node: 'pushed' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ retried: true, node: 'pushed' });
    expect(asked).toEqual([[id, 'pushed']]);
  });

  it('409s with the engine refusal', async () => {
    answer = { ok: false, error: 'cannot retry a done run that did not fail' };
    const res = await post(someRun(), { node: 'pushed' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'cannot retry a done run that did not fail' });
  });

  it('400s a body without a node, before the manager is asked', async () => {
    const res = await post(someRun(), {});
    expect(res.status).toBe(400);
    expect(asked).toEqual([]);
  });

  it('404s an unknown id without asking the manager', async () => {
    const res = await post('nope', { node: 'pushed' });
    expect(res.status).toBe(404);
    expect(asked).toEqual([]);
  });
});
