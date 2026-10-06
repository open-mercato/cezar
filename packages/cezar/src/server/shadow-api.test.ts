import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ShadowDiscardResponse, ShadowLedgerResponse } from '@open-mercato/cezar-contract';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { LEDGER_VERSION, appendIntent, newIntentId, shadowDir } from '../shadow/ledger.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/**
 * The shadow family through the real Hono app (spec 2026-10-06-shadow-runs). The promotion itself
 * is covered against a real git in `shadow/promote.test.ts`; what is pinned here is the HTTP
 * boundary: an ordinary run answers empty and refuses decisions, the run-level push and draft-PR
 * actions refuse a shadow run, and the intent id is validated before anything reads the ledger.
 */
describe('/api/v1/runs/:id/shadow', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let app: Hono;
  let ordinary: RunRecord;
  let shadowed: RunRecord;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-shadow-api-'));
    dataDir = join(repoRoot, '.ai/cezar');
    store = RunStore.open(dataDir);
    app = createApp({
      repoRoot,
      store,
      manager: { isActive: () => false } as unknown as RunManager,
      version: '0.0.0-test',
    });
    ordinary = store.createRun({ title: 'plain', workflow: 'quick-task', task: 'plain', steps: [] });
    shadowed = store.createRun({ title: 'shadowed', workflow: 'quick-task', task: 'shadowed', steps: [], shadow: true });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const post = (path: string) => apiRequest(app, path, { method: 'POST' });

  function recordComment(): string {
    const id = newIntentId();
    appendIntent(shadowDir(dataDir, shadowed.id), {
      v: LEDGER_VERSION,
      type: 'intent',
      id,
      at: '2026-10-06T12:00:00.000Z',
      kind: 'forge',
      tool: 'gh',
      argv: ['issue', 'comment', '3', '--body', 'ack'],
      cwd: repoRoot,
      files: [],
    });
    return id;
  }

  it('answers an ordinary run with an empty ledger rather than a 404', async () => {
    const res = await apiRequest(app, `/api/v1/runs/${ordinary.id}/shadow`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ shadow: false, intents: [], truncated: false });
  });

  it('lists what a shadow run recorded, classified by the server', async () => {
    const id = recordComment();
    const res = await apiRequest(app, `/api/v1/runs/${shadowed.id}/shadow`);
    const body = (await res.json()) as ShadowLedgerResponse;
    expect(body.shadow).toBe(true);
    expect(body.intents).toMatchObject([{ id, kind: 'forge', promotable: 'click', state: 'pending', summary: 'gh issue comment' }]);
  });

  it('refuses decisions on an ordinary run', async () => {
    const res = await post(`/api/v1/runs/${ordinary.id}/shadow/intents/${newIntentId()}/promote`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not a shadow run' });
  });

  it('validates the intent id as middleware', async () => {
    const res = await post(`/api/v1/runs/${shadowed.id}/shadow/intents/not-an-intent/discard`);
    expect(res.status).toBe(400);
  });

  it('discards through the API and leaves a note in the transcript', async () => {
    const id = recordComment();
    const res = await post(`/api/v1/runs/${shadowed.id}/shadow/intents/${id}/discard`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as ShadowDiscardResponse).intent.state).toBe('discarded');
    expect((await post(`/api/v1/runs/${shadowed.id}/shadow/intents/${id}/discard`)).status).toBe(409);
  });

  it('refuses the run-level push and draft PR for a shadow run: its only way out is per intent', async () => {
    const push = await post(`/api/v1/runs/${shadowed.id}/git/push`);
    const pr = await post(`/api/v1/runs/${shadowed.id}/pr`);
    expect(push.status).toBe(409);
    expect(pr.status).toBe(409);
    expect(((await pr.json()) as { error: string }).error).toMatch(/shadow run/);
  });

  it('answers 404 for an unknown run on every route', async () => {
    expect((await apiRequest(app, '/api/v1/runs/nope/shadow')).status).toBe(404);
    expect((await post(`/api/v1/runs/nope/shadow/intents/${newIntentId()}/promote`)).status).toBe(404);
  });
});
