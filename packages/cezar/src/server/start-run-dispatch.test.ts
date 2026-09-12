import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';

/**
 * `POST /runs` with the composer's Dispatch toggle (spec 2026-09-10-dispatch): the body's
 * `dispatch` intent reaches `startRun` as `dispatchIntent` while the capability is on, and is
 * dropped — the run still starts — while it is off. The route validates the intent's shape
 * strictly, so a misspelled limit is a 400 rather than a brake that never fired.
 */
describe('POST /runs and the dispatch intent', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let inputs: StartRunInput[];
  const savedFlag = process.env.CEZ_DISPATCH;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-startrun-dispatch-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    inputs = [];
    delete process.env.CEZ_DISPATCH;
    const manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) => {
        inputs.push(input);
        return store.createRun({ title: 't', workflow: 'quick-task', task: input.task, steps: [] });
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

  const post = (body: unknown) =>
    apiRequest(app, '/api/v1/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('threads the intent into startRun while dispatch is on (the default)', async () => {
    const res = await post({ steps: [{ id: 'work', prompt: '{{task}}' }], task: 'split this', dispatch: { maxSubtasks: 10, inFlight: 2, model: 'sonnet' } });
    expect(res.status).toBe(201);
    expect(inputs[0]?.dispatchIntent).toEqual({ maxSubtasks: 10, inFlight: 2, model: 'sonnet' });
  });

  it('the bare toggle is an empty intent, and no toggle is no intent', async () => {
    expect((await post({ steps: [{ id: 'work', prompt: '{{task}}' }], task: 'split this', dispatch: {} })).status).toBe(201);
    expect(inputs[0]?.dispatchIntent).toEqual({});
    expect((await post({ steps: [{ id: 'work', prompt: '{{task}}' }], task: 'plain' })).status).toBe(201);
    expect(inputs[1]?.dispatchIntent).toBeUndefined();
  });

  it('drops the intent — still starting the run — while CEZ_DISPATCH=0', async () => {
    process.env.CEZ_DISPATCH = '0';
    const res = await post({ steps: [{ id: 'work', prompt: '{{task}}' }], task: 'split this', dispatch: { maxSubtasks: 3 } });
    expect(res.status).toBe(201);
    expect(inputs[0]?.dispatchIntent).toBeUndefined();
  });

  it('400s an intent outside the contract: an unknown key, or a cap above the engine’s', async () => {
    expect((await post({ steps: [{ id: 'work', prompt: '{{task}}' }], task: 't', dispatch: { maxSubtask: 3 } })).status).toBe(400);
    expect((await post({ steps: [{ id: 'work', prompt: '{{task}}' }], task: 't', dispatch: { inFlight: 9 } })).status).toBe(400);
    expect(inputs).toHaveLength(0);
  });
});
