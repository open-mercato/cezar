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

/**
 * The dispatch family (spec 2026-09-10-dispatch): both routes are thin over `RunManager.dispatch`
 * and `RunManager.recordReport`, so what is pinned here is the wiring — the gate, the validation,
 * the status codes, and that the manager is called with exactly the validated body.
 */
describe('the dispatch routes', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let calls: Array<{ kind: 'dispatch' | 'report'; runId: string; body: unknown }>;
  let outcome: { id: string; branch?: string } | { refused: string };
  let reportOk: boolean;
  const savedFlag = process.env.CEZ_DISPATCH;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-dispatch-api-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    calls = [];
    outcome = { id: 'child-1', branch: 'cez/child1' };
    reportOk = true;
    process.env.CEZ_DISPATCH = '1';
    const manager = {
      dispatch: (runId: string, body: unknown) => {
        calls.push({ kind: 'dispatch', runId, body });
        return outcome;
      },
      recordReport: (runId: string, body: unknown) => {
        calls.push({ kind: 'report', runId, body });
        return reportOk;
      },
    } as unknown as RunManager;
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test', providerAuth: connectedProviderAuth() });
  });

  afterEach(() => {
    if (savedFlag === undefined) delete process.env.CEZ_DISPATCH;
    else process.env.CEZ_DISPATCH = savedFlag;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('creates a child through the manager and answers its id and branch', async () => {
    const res = await apiRequest(app, '/api/v1/runs/parent-1/dispatch', json({ objective: 'take the flank', max_cost: 2 }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'child-1', branch: 'cez/child1' });
    expect(calls).toEqual([{ kind: 'dispatch', runId: 'parent-1', body: { objective: 'take the flank', max_cost: 2 } }]);
  });

  it('answers a refusal as 409 with the reason', async () => {
    outcome = { refused: 'no budget left' };
    const res = await apiRequest(app, '/api/v1/runs/parent-1/dispatch', json({ objective: 'x' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'no budget left' });
  });

  it('400s an order with an unknown key — a misspelled cap is a brake that did not fire', async () => {
    const res = await apiRequest(app, '/api/v1/runs/parent-1/dispatch', json({ objective: 'x', max_costs: 2 }));
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('records a report and answers ok; 404 for a run outside any tree', async () => {
    const report = { status: 'done', result: 'all green', evidence: ['npm test → 3 passed'], verdict: 'approve' };
    const res = await apiRequest(app, '/api/v1/runs/child-1/report', json(report));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({ kind: 'report', runId: 'child-1' });
    expect(calls[0]?.body).toMatchObject({ ...report, side_effects: [], errors: [], suggestions: [] });
    reportOk = false;
    expect((await apiRequest(app, '/api/v1/runs/plain/report', json(report))).status).toBe(404);
  });

  it('answers 409 on both routes while CEZ_DISPATCH=0, before touching the manager', async () => {
    process.env.CEZ_DISPATCH = '0';
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', providerAuth: connectedProviderAuth() });
    for (const path of ['/api/v1/runs/p/dispatch', '/api/v1/runs/p/report']) {
      const res = await apiRequest(app, path, json({ objective: 'x', status: 'done', result: 'r' }));
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/^dispatch is disabled on this cockpit \(CEZ_DISPATCH=0\).*stop and report/);
    }
  });
});
