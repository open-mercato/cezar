import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';

/** Questions inbox spec: an ask card's `askRequestId` must reach the engine from both delivery routes. */
describe('askRequestId on POST /runs/:id/messages and /continue', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  const calls: Array<{ via: string; options: unknown }> = [];
  let live = true;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-ask-reply-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    calls.length = 0;
    live = true;
    const manager = {
      sendMessage: (_id: string, _content: unknown, options: unknown) => (calls.push({ via: 'send', options }), live),
      enqueueMessage: () => null,
      deferMessage: (_id: string, _content: unknown, options: unknown) => (calls.push({ via: 'defer', options }), true),
      continueRun: (_id: string, options: { reply?: unknown }) => (calls.push({ via: 'continue', options: options.reply }), { ok: true }),
    } as unknown as RunManager;
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test', providerAuth: connectedProviderAuth() });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const post = (path: string, body: unknown) =>
    apiRequest(app, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('hands a card answer to a live session with its askRequestId, and a typed reply without one', async () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 'chat', steps: [] });
    store.updateRun(run.id, { status: 'waiting' });
    expect((await post(`/api/v1/runs/${run.id}/messages`, { text: 'Base: main', askRequestId: 'ask-1' })).status).toBe(200);
    expect((await post(`/api/v1/runs/${run.id}/messages`, { text: 'go with main' })).status).toBe(200);
    expect(calls).toEqual([{ via: 'send', options: { askRequestId: 'ask-1' } }, { via: 'send', options: {} }]);
  });

  it('keeps the askRequestId when the message is buffered between sessions', async () => {
    live = false;
    const run = store.createRun({ title: 't', workflow: 'w', task: 'chat', steps: [] });
    store.updateRun(run.id, { status: 'running' });
    expect((await post(`/api/v1/runs/${run.id}/messages`, { text: 'Base: main', askRequestId: 'ask-1' })).status).toBe(200);
    expect(calls.at(-1)).toEqual({ via: 'defer', options: { askRequestId: 'ask-1', userReply: true } });
  });

  it('marks a Continue as the user reply, with the card it answers', async () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 'chat', steps: [] });
    store.updateRun(run.id, { status: 'failed', idleClosedAt: new Date().toISOString() });
    expect((await post(`/api/v1/runs/${run.id}/continue`, { text: 'Base: main', askRequestId: 'ask-1' })).status).toBe(200);
    expect((await post(`/api/v1/runs/${run.id}/continue`, { text: 'carry on' })).status).toBe(200);
    expect(calls).toEqual([{ via: 'continue', options: { askRequestId: 'ask-1' } }, { via: 'continue', options: {} }]);
  });

  it('refuses a card answer whose question already closed (a stale tab), on both routes', async () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 'chat', steps: [] });
    store.updateRun(run.id, { status: 'waiting' });
    store.recordTaskAsk(run.id, { requestId: 'ask-1', askedAt: new Date().toISOString(), questions: [{ header: 'Base', question: 'Which?', options: [{ label: 'a' }, { label: 'b' }] }] });
    store.closeTaskAsks(run.id, () => true, { reason: 'dismissed', at: new Date().toISOString() });
    for (const route of ['messages', 'continue']) {
      const res = await post(`/api/v1/runs/${run.id}/${route}`, { text: 'Base: main', askRequestId: 'ask-1' });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'question already closed' });
    }
    expect(calls).toEqual([]);
    // A typed reply, or a card the run never recorded, still goes through.
    expect((await post(`/api/v1/runs/${run.id}/messages`, { text: 'go on' })).status).toBe(200);
    expect((await post(`/api/v1/runs/${run.id}/messages`, { text: 'x', askRequestId: 'graph-ask' })).status).toBe(200);
  });

  it('settles the idempotency receipt on that 409, so a retry answers instead of hanging', async () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 'chat', steps: [] });
    store.updateRun(run.id, { status: 'waiting' });
    store.recordTaskAsk(run.id, { requestId: 'ask-1', askedAt: new Date().toISOString(), questions: [{ header: 'Base', question: 'Which?', options: [{ label: 'a' }, { label: 'b' }] }] });
    store.closeTaskAsks(run.id, () => true, { reason: 'dismissed', at: new Date().toISOString() });
    for (const route of ['messages', 'continue']) {
      const body = { text: 'Base: main', askRequestId: 'ask-1', idempotencyKey: crypto.randomUUID() };
      expect((await post(`/api/v1/runs/${run.id}/${route}`, body)).status).toBe(409);
      const retry = await Promise.race([post(`/api/v1/runs/${run.id}/${route}`, body), new Promise<'hung'>((done) => setTimeout(() => done('hung'), 2_000))]);
      expect(retry === 'hung' ? retry : retry.status).toBe(409);
    }
  });
});
