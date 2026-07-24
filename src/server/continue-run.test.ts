import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.js';
import type { RunManager } from '../workflows/run.js';
import { apiRequest } from './loopback-request.testkit.js';
import { createApp } from './server.js';

/**
 * `POST /api/runs/:id/continue` runner/model override (#401) — the follow-up composer lets the
 * user pick which backend/model reopen the session. Contract: the parsed override is handed to
 * the manager verbatim; an empty POST omits both (the run's current backend is kept — backward
 * compat); a bad runner is a 400. A capturing stub is all the boundary needs (start-run pattern).
 */
describe('POST /api/runs/:id/continue override', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let runId: string;
  let captured: { id: string; opts: { text?: string; runner?: string; model?: string } } | undefined;
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
      continueRun: (id: string, opts: { text?: string; runner?: string; model?: string } = {}) => {
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
    apiRequest(app, `/api/runs/${runId}/continue`, {
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

  it('rejects an unknown runner with a 400 and never reaches the manager', async () => {
    const res = await post({ runner: 'gemini' });
    expect(res.status).toBe(400);
    expect(captured).toBeUndefined();
  });

  it('404s for an unknown run before validating the body', async () => {
    const res = await apiRequest(app, '/api/runs/missing/continue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });
});
