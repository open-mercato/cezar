import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { automationCancelQueuedResponseSchema, automationWorkSchema } from '@open-mercato/cezar-contract';
import { AutomationStore } from '../automations/store.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

/** #1980: what a paused automation leaves running, the explicit cancel for its queued work, and
 *  the dispatch route reading the automation's paused state live. */
describe('paused automation work routes (#1980)', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let automations: AutomationStore;
  let automationId: string;
  const cancelled: string[] = [];
  let dispatchHook: ((id: string) => boolean) | undefined;
  const saved = process.env.CEZ_AUTOMATIONS;

  beforeEach(() => {
    delete process.env.CEZ_AUTOMATIONS;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-automation-work-'));
    dataDir = join(repoRoot, '.ai/cezar');
    mkdirSync(dataDir, { recursive: true });
    store = RunStore.open(dataDir);
    automations = AutomationStore.open(dataDir);
    automationId = automations.create({
      name: 'Nightly', enabled: false, kind: 'schedule',
      schedule: { type: 'daily', hour: 16, minute: 0 },
      task: { prompt: 'do the thing' },
    } as Parameters<AutomationStore['create']>[0]).id;
    cancelled.length = 0;
    dispatchHook = undefined;
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (saved === undefined) delete process.env.CEZ_AUTOMATIONS;
    else process.env.CEZ_AUTOMATIONS = saved;
  });

  const manager = {
    cancel: (id: string) => {
      cancelled.push(id);
      store.updateRun(id, { status: 'cancelled' });
      return true;
    },
    dispatch: (_id: string, _input: unknown, opts: { automationPaused?: (id: string) => boolean }) => {
      dispatchHook = opts.automationPaused;
      return { refused: 'stub' };
    },
  } as unknown as RunManager;
  const app = () => createApp({ repoRoot, store, manager, automationStore: automations, version: '0.0.0-test' });

  const seed = () => {
    const trigger = { automationId, automationRevision: 1, receiptId: 'r', trigger: 'schedule' as const, occurrenceAt: '2026-11-04T15:00:00.000Z' };
    const root = store.createRun({ title: 'root', workflow: '(planned)', task: 't', steps: [] });
    store.updateRun(root.id, { status: 'running', automationTrigger: trigger, dispatch: { rootRunId: root.id } });
    const fresh = store.createRun({ title: 'fresh child', workflow: '(planned)', task: 't', steps: [] });
    store.updateRun(fresh.id, { dispatch: { rootRunId: root.id, parentRunId: root.id } });
    const backlog = store.createRun({ title: 'backlog', workflow: '(planned)', task: 't', steps: [] });
    store.updateRun(backlog.id, { automationTrigger: trigger });
    const byHand = store.createRun({ title: 'by hand', workflow: '(planned)', task: 't', steps: [] });
    store.updateRun(byHand.id, { automationTrigger: { ...trigger, trigger: 'manual' } });
    return { root, fresh, backlog, byHand };
  };

  it('discloses queued and active work across the tree, not a by-hand Run now', async () => {
    const { root, fresh, backlog } = seed();
    const res = await apiRequest(app(), `/api/v1/automations/${automationId}/work`);
    expect(res.status).toBe(200);
    const work = automationWorkSchema.strict().parse(await res.json());
    expect(work.queued.map((r) => [r.id, r.kind]).sort()).toEqual([[fresh.id, 'never-started'], [backlog.id, 'never-started']].sort());
    expect(work.active.map((r) => r.id)).toEqual([root.id]);
    expect((await apiRequest(app(), '/api/v1/automations/nope/work')).status).toBe(404);
  });

  it('cancels only the queued work, leaving active and by-hand tasks alone', async () => {
    const { root, fresh, backlog, byHand } = seed();
    const res = await apiRequest(app(), `/api/v1/automations/${automationId}/cancel-queued`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = automationCancelQueuedResponseSchema.strict().parse(await res.json());
    expect(body.cancelled.sort()).toEqual([fresh.id, backlog.id].sort());
    expect(body.kept).toEqual([]);
    expect(cancelled.sort()).toEqual([fresh.id, backlog.id].sort());
    expect(store.getRun(root.id)?.status).toBe('running');
    expect(store.getRun(byHand.id)?.status).toBe('queued');
  });

  it('reports a queued run the manager refused to cancel as kept', async () => {
    const { fresh, backlog } = seed();
    const refusing = { ...manager, cancel: (id: string) => id !== fresh.id && manager.cancel(id) } as unknown as RunManager;
    const res = await apiRequest(createApp({ repoRoot, store, manager: refusing, automationStore: automations, version: '0.0.0-test' }), `/api/v1/automations/${automationId}/cancel-queued`, { method: 'POST' });
    expect(await res.json()).toEqual({ cancelled: [backlog.id], kept: [fresh.id] });
  });

  it('hands the dispatch route a live read of the paused flag', async () => {
    const { root } = seed();
    const res = await apiRequest(app(), `/api/v1/runs/${root.id}/dispatch`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objective: 'more' }),
    });
    expect(res.status).toBe(409);
    expect(dispatchHook?.(automationId)).toBe(true);
    automations.update(automationId, 1, { ...automations.get(automationId)!, enabled: true } as Parameters<AutomationStore['update']>[2]);
    expect(dispatchHook?.(automationId)).toBe(false);
    expect(dispatchHook?.('deleted-automation')).toBe(false);
  });
});
