import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp, TASK_ID_HEADER } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';

/**
 * The wait routes (spec 2026-10-05-cross-task-waits): the gate, validation as middleware, the
 * origin the route derives (never the body's), and the status mapping of the resolver's
 * refusals. The resolver itself is pinned in `workspace/waits.test.ts`.
 */
describe('the wait routes', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let delivered: Array<{ runId: string; text: string }>;
  const disposers: Array<() => void> = [];
  const savedFlag = process.env.CEZ_TASK_WAITS;

  const build = () => {
    const manager = {
      deliverWaitNotice: (runId: string, text: string) => {
        delivered.push({ runId, text });
        return true;
      },
    } as unknown as RunManager;
    app = createApp({
      repoRoot,
      store,
      manager,
      version: '0.0.0-test',
      providerAuth: connectedProviderAuth(),
      onDispose: (cleanup) => disposers.push(cleanup),
    });
  };

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-waits-api-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    delivered = [];
    delete process.env.CEZ_TASK_WAITS;
    build();
  });

  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
    if (savedFlag === undefined) delete process.env.CEZ_TASK_WAITS;
    else process.env.CEZ_TASK_WAITS = savedFlag;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const live = (title: string) => {
    const run = store.createRun({ title, workflow: 'quick-task', task: title, steps: [] });
    store.updateRun(run.id, { status: 'running' });
    return run;
  };

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    apiRequest(app, path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('declares an agent wait when the CLI acts for the waiter itself, and a user wait otherwise', async () => {
    const waiter = live('waiter');
    const target = live('target');
    const asAgent = await post(`/api/v1/runs/${waiter.id}/waits`, { target: { runId: target.id.slice(0, 8) } }, { [TASK_ID_HEADER]: waiter.id });
    expect(asAgent.status).toBe(200);
    expect(await asAgent.json()).toMatchObject({ kind: 'pending', edge: { origin: 'agent', target: { runId: target.id }, state: 'pending' } });

    const other = live('other target');
    // A header naming SOME OTHER run is not this run's agent speaking.
    const asUser = await post(`/api/v1/runs/${waiter.id}/waits`, { target: { runId: other.id } }, { [TASK_ID_HEADER]: target.id });
    expect(await asUser.json()).toMatchObject({ kind: 'pending', edge: { origin: 'user' } });
    expect(delivered.some((entry) => entry.text.includes('The user asked you to wait'))).toBe(true);
  });

  it('answers a settled target with its outcome and records nothing', async () => {
    const waiter = live('waiter');
    const target = live('target');
    store.updateRun(target.id, { status: 'done' });
    const res = await post(`/api/v1/runs/${waiter.id}/waits`, { target: { projectId: 'default', runId: target.id } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: 'settled', outcome: { status: 'done', title: 'target' } });
    expect(store.getRun(waiter.id)?.waits).toBeUndefined();
  });

  it('validates the body as middleware: origin, unknown keys and bad timeouts are 400', async () => {
    const waiter = live('waiter');
    for (const body of [{ target: { runId: 'x' }, origin: 'user' }, { target: { runId: 'x' }, timeoutMinutes: 0 }, {}]) {
      expect((await post(`/api/v1/runs/${waiter.id}/waits`, body)).status).toBe(400);
    }
  });

  it('maps refusals onto 400 / 404 / 409', async () => {
    const waiter = live('waiter');
    expect((await post(`/api/v1/runs/${waiter.id}/waits`, { target: { runId: waiter.id } })).status).toBe(400);
    expect((await post(`/api/v1/runs/${waiter.id}/waits`, { target: { runId: 'nothere' } })).status).toBe(404);
    expect((await post(`/api/v1/runs/${waiter.id}/waits`, { target: { projectId: 'no-such-project', runId: 'x' } })).status).toBe(404);
    const settledWaiter = live('settled waiter');
    store.updateRun(settledWaiter.id, { status: 'done' });
    const res = await post(`/api/v1/runs/${settledWaiter.id}/waits`, { target: { runId: waiter.id } });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('only a live task can wait');
  });

  it('stops a wait with DELETE and answers the cancelled edge', async () => {
    const waiter = live('waiter');
    const target = live('target');
    const declared = (await (await post(`/api/v1/runs/${waiter.id}/waits`, { target: { runId: target.id } })).json()) as { edge: { id: string } };
    const res = await apiRequest(app, `/api/v1/runs/${waiter.id}/waits/${declared.edge.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ edge: { id: declared.edge.id, state: 'cancelled' } });
    expect((await apiRequest(app, `/api/v1/runs/${waiter.id}/waits/${declared.edge.id}`, { method: 'DELETE' })).status).toBe(409);
    expect((await apiRequest(app, `/api/v1/runs/${waiter.id}/waits/nope`, { method: 'DELETE' })).status).toBe(404);
  });

  it('answers 409 on both routes while CEZ_TASK_WAITS=0', async () => {
    process.env.CEZ_TASK_WAITS = '0';
    for (const dispose of disposers.splice(0)) dispose();
    build();
    const waiter = live('waiter');
    const res = await post(`/api/v1/runs/${waiter.id}/waits`, { target: { runId: 'x' } });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('CEZ_TASK_WAITS=0');
    expect((await apiRequest(app, `/api/v1/runs/${waiter.id}/waits/w`, { method: 'DELETE' })).status).toBe(409);
  });
});
