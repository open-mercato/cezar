import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';

/**
 * Tightened request validation (#429): the mutating routes now bound their
 * inputs and follow the safeParse→`{error}` 400 convention. These tests pin
 * the new bounds — over-limit is a 400, legitimate large-but-reasonable input
 * still passes — and the ui-state passthrough policy.
 */
describe('request validation bounds (#429)', () => {
  const savedRemote = process.env.CEZ_REMOTE;
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let captured: StartRunInput | undefined;
  let continueText: string | undefined;

  beforeEach(() => {
    delete process.env.CEZ_REMOTE;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-reqval-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    captured = undefined;
    continueText = undefined;
    const manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) => {
        captured = input;
        return store.createRun({ title: 't', workflow: '(planned)', task: input.task, steps: [] });
      },
      // Options object since #401 (runner/model override rides alongside the resume text);
      // these bounds tests still only care about `text`.
      continueRun: (_id: string, opts: { text?: string } = {}) => {
        continueText = opts.text;
        return { ok: true };
      },
    } as unknown as RunManager;
    app = createApp({
      repoRoot,
      store,
      manager,
      version: '0.0.0-test',
      providerAuth: connectedProviderAuth(),
    });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = savedRemote;
  });

  const postJson = (path: string, body: unknown) =>
    apiRequest(app, path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  // ---- startRunSchema.task -------------------------------------------------
  const stepsBody = { steps: [{ id: 'work', prompt: '{{task}}' }] };

  it('accepts a 100k-char task', async () => {
    const res = await postJson('/api/v1/runs', { ...stepsBody, task: 'x'.repeat(100_000) });
    expect(res.status).toBe(201);
    expect(captured?.task).toHaveLength(100_000);
  });

  it('rejects an over-cap task with a 400', async () => {
    const res = await postJson('/api/v1/runs', { ...stepsBody, task: 'x'.repeat(100_001) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('task');
    expect(captured).toBeUndefined();
  });

  // ---- planSchema.task -----------------------------------------------------
  it('rejects an over-cap plan task with a 400 (before planChain runs)', async () => {
    const res = await postJson('/api/v1/plan', { task: 'x'.repeat(100_001) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('task');
  });

  // ---- continue text -------------------------------------------------------
  it('accepts a 100k-char continue text', async () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] });
    const res = await postJson(`/api/v1/runs/${run.id}/continue`, { text: 'y'.repeat(100_000) });
    expect(res.status).toBe(200);
    expect(continueText).toHaveLength(100_000);
  });

  it('rejects over-cap continue text with a 400', async () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] });
    const res = await postJson(`/api/v1/runs/${run.id}/continue`, { text: 'y'.repeat(100_001) });
    expect(res.status).toBe(400);
    expect(continueText).toBeUndefined();
  });

  it('an empty continue body still resumes (text optional)', async () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] });
    const res = await apiRequest(app, `/api/v1/runs/${run.id}/continue`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(continueText).toBeUndefined();
  });

  // ---- saveWorkflowSchema.description --------------------------------------
  it('accepts a workflow with a 2k-char description', async () => {
    const res = await postJson('/api/v1/workflows', {
      name: 'wf-ok',
      description: 'd'.repeat(2_000),
      skills: ['some-skill'],
    });
    expect(res.status).toBe(201);
  });

  it('rejects an over-cap workflow description with a 400', async () => {
    const res = await postJson('/api/v1/workflows', {
      name: 'wf-bad',
      description: 'd'.repeat(2_001),
      skills: ['some-skill'],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('description');
  });

  // ---- archive schema ------------------------------------------------------
  it('archives with no body', async () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] });
    const res = await apiRequest(app, `/api/v1/runs/${run.id}/archive`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(store.getRun(run.id)?.archived).toBe(true);
  });

  it('rejects a wrong-typed archived flag with a 400', async () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] });
    const res = await postJson(`/api/v1/runs/${run.id}/archive`, { archived: 'nope' });
    expect(res.status).toBe(400);
  });

  // ---- open-in schema ------------------------------------------------------
  it('rejects an open-in with no target (400)', async () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] });
    const res = await apiRequest(app, `/api/v1/runs/${run.id}/open-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  // ---- ui-state passthrough policy -----------------------------------------
  const putJson = (path: string, body: unknown) =>
    apiRequest(app, path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('passes an unknown ui-state key through and persists it', async () => {
    const res = await putJson('/api/v1/ui-state', { someFuturePref: 'keep-me' });
    expect(res.status).toBe(200);
    const merged = (await res.json()) as Record<string, unknown>;
    expect(merged.someFuturePref).toBe('keep-me');
    const onDisk = JSON.parse(readFileSync(join(repoRoot, '.ai/cezar/ui-state.json'), 'utf8'));
    expect(onDisk.someFuturePref).toBe('keep-me');
  });

  it('rejects a ui-state body with too many top-level keys (400)', async () => {
    const body: Record<string, number> = {};
    for (let i = 0; i < 201; i++) body[`k${i}`] = i;
    const res = await putJson('/api/v1/ui-state', body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('too many keys');
  });

  it('accepts a valid known ui-state field', async () => {
    const res = await putJson('/api/v1/ui-state', { runsView: 'table' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { runsView: string }).runsView).toBe('table');
  });

  // ---- how the body is parsed, not just what the schema says ----------------
  /**
   * These routes moved from parsing inline (`await c.req.json().catch(() => …)`) to Hono's
   * `validator('json')`, so that `hc` can typecheck request bodies. Hono's validator is stricter
   * than the old code in two ways that reach the wire: it answers a PLAIN-TEXT 400 for malformed
   * JSON, and it ignores a body sent without a JSON content-type. `jsonBody` exists to paper over
   * exactly that — the first two cases below fail against a bare `validator('json')`. The other
   * two pin the `absent` fallback, which a bare validator happens to satisfy today only because
   * Hono's stand-in `{}` agrees with these two schemas; they are here so a change to either one
   * is a deliberate act.
   */
  describe('body parsing stays as tolerant as the inline parse it replaced', () => {
    it('answers malformed JSON with the {error} shape, not Hono plain text', async () => {
      const res = await apiRequest(app, '/api/v1/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ this is not json',
      });
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toContain('application/json');
      // The schema's own complaint about the fallback — the same text as before the move.
      expect(await res.json()).toHaveProperty('error');
      expect(captured).toBeUndefined();
    });

    it('still reads a body sent without a JSON content-type', async () => {
      const res = await apiRequest(app, '/api/v1/runs', {
        method: 'POST',
        body: JSON.stringify({ ...stepsBody, task: 'no content-type here' }),
      });
      expect(res.status).toBe(201);
      expect(captured?.task).toBe('no content-type here');
    });

    it('treats a body-less request as the route’s own fallback, not as {}', async () => {
      // `POST /runs` required a body before; a bodyless request must still 400 rather than
      // sail through on the `{}` Hono hands a validator when there is nothing to parse.
      const res = await apiRequest(app, '/api/v1/runs', { method: 'POST' });
      expect(res.status).toBe(400);
      expect(await res.json()).toHaveProperty('error');
      expect(captured).toBeUndefined();
    });

    it('lets a body-less request through where the route tolerated one (archive)', async () => {
      const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] });
      const res = await apiRequest(app, `/api/v1/runs/${run.id}/archive`, { method: 'POST' });
      expect(res.status).toBe(200);
    });
  });
});
