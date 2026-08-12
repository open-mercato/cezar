import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/**
 * `POST /api/v1/runs/:id/continue` runner/model override (#401) — the follow-up composer lets the
 * user pick which backend/model reopen the session. Contract: the parsed override is handed to
 * the manager verbatim; an empty POST omits both (the run's current backend is kept — backward
 * compat); a bad runner is a 400. A capturing stub is all the boundary needs (start-run pattern).
 */
describe('POST /api/v1/runs/:id/continue override', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let runId: string;
  type ContinueOpts = {
    text?: string;
    images?: Array<{ type: string; source: { media_type: string; data: string } }>;
    runner?: string;
    model?: string;
  };
  let captured: { id: string; opts: ContinueOpts } | undefined;
  const savedDryRun = process.env.CEZ_DRY_RUN;

  beforeEach(() => {
    process.env.CEZ_DRY_RUN = '1';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-continue-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    captured = undefined;
    runId = store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: 't',
      steps: [],
    }).id;
    const manager = {
      continueRun: (id: string, opts: ContinueOpts = {}) => {
        captured = { id, opts };
        return { ok: true };
      },
    } as unknown as RunManager;
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  const post = (body: unknown) =>
    apiRequest(app, `/api/v1/runs/${runId}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('plumbs a runner + model override through to the manager', async () => {
    const res = await post({ runner: 'codex', model: 'gpt-5.1-codex' });
    expect(res.status).toBe(200);
    expect(captured?.opts.runner).toBe('codex');
    expect(captured?.opts.model).toBe('gpt-5.1-codex');
  });

  it('an empty POST omits both — the run keeps its current backend (backward compat)', async () => {
    const res = await post({});
    expect(res.status).toBe(200);
    expect(captured?.opts.runner).toBeUndefined();
    expect(captured?.opts.model).toBeUndefined();
  });

  it('still carries a follow-up text alongside the override', async () => {
    const res = await post({ text: 'keep going', runner: 'opencode' });
    expect(res.status).toBe(200);
    expect(captured?.opts.text).toBe('keep going');
    expect(captured?.opts.runner).toBe('opencode');
  });

  it('rejects a model override while locked but still permits switching runners', async () => {
    writeFileSync(
      join(repoRoot, '.ai', 'cezar', 'config.json'),
      JSON.stringify({ modelsLocked: true }),
      'utf8',
    );

    expect((await post({ runner: 'codex', model: 'gpt-5.6-codex' })).status).toBe(409);
    expect(captured).toBeUndefined();

    expect((await post({ runner: 'codex' })).status).toBe(200);
    expect(captured?.opts.runner).toBe('codex');
    expect(captured?.opts.model).toBeUndefined();
  });

  /** The follow-up composer is a full composer, so a screenshot pasted into it has to reach the
   *  reopened session — as content blocks, the same shape `POST /messages` hands the engine. */
  it('converts pasted images into content blocks for the manager', async () => {
    const res = await post({ text: 'like this', images: [{ mediaType: 'image/png', data: 'AAAA' }] });
    expect(res.status).toBe(200);
    expect(captured?.opts.images).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ]);
  });

  it('rejects a non-image media type, and more images than a message may carry', async () => {
    expect((await post({ images: [{ mediaType: 'text/plain', data: 'AAAA' }] })).status).toBe(400);
    const five = Array.from({ length: 5 }, () => ({ mediaType: 'image/png', data: 'AAAA' }));
    expect((await post({ images: five })).status).toBe(400);
    expect(captured).toBeUndefined();
  });

  it('rejects an unknown runner with a 400 and never reaches the manager', async () => {
    const res = await post({ runner: 'gemini' });
    expect(res.status).toBe(400);
    expect(captured).toBeUndefined();
  });

  it('404s for an unknown run before validating the body', async () => {
    const res = await apiRequest(app, '/api/v1/runs/missing/continue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });
});
