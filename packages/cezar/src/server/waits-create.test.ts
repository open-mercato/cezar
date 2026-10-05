import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WaitEdge } from '@open-mercato/cezar-contract';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { RunManager } from '../workflows/run.ts';
import { clearProjectProbeCache, listProjects, registerProject } from '../workspace/projects.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { ProjectContexts } from './project-context.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';
import { createApp, TASK_ID_HEADER } from './server.ts';

/**
 * Create-and-wait in another project (spec 2026-10-05-cross-task-waits, Phase 2) through the real
 * route: the target starts in the OTHER project as an independent autonomous root task that
 * remembers its creator, the edge is written only once the start succeeded, and the dispatch
 * brakes apply — the in-flight cap and the creator's budget.
 */
describe('POST /runs/:id/waits — create in another project', () => {
  let home: string;
  let bootRoot: string;
  let otherRoot: string;
  let otherId: string;
  let store: RunStore;
  let manager: RunManager;
  let contexts: ProjectContexts;
  let app: Hono;
  const disposers: Array<() => void> = [];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const key of ['CEZ_HOME', 'CEZ_DRY_RUN', 'CEZ_TASK_WAITS', 'CEZ_DISPATCH', 'CEZ_MOCK_STDIN_FILE']) savedEnv[key] = process.env[key];
    home = mkdtempSync(join(tmpdir(), 'cez-waits-create-home-'));
    bootRoot = mkdtempSync(join(tmpdir(), 'cez-waits-create-boot-'));
    otherRoot = mkdtempSync(join(tmpdir(), 'cez-waits-create-other-'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_DRY_RUN = '1';
    delete process.env.CEZ_TASK_WAITS;
    delete process.env.CEZ_DISPATCH;
    clearProjectProbeCache();
    const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 4 } });
    store = RunStore.open(join(bootRoot, '.ai/cezar'));
    manager = new RunManager(store, bootRoot, { semaphore });
    otherId = (await registerProject(otherRoot)).id;
    contexts = new ProjectContexts({ listProjects, semaphore });
    build();
  });

  const build = () => {
    app = createApp({
      repoRoot: bootRoot,
      store,
      manager,
      version: '0.0.0-test',
      providerAuth: connectedProviderAuth(),
      contexts,
      onDispose: (cleanup) => disposers.push(cleanup),
    });
  };

  afterEach(async () => {
    for (const dispose of disposers.splice(0)) dispose();
    const other = contexts.peek(otherId);
    for (const run of other?.store.listRuns() ?? []) other?.manager.cancel(run.id);
    const deadline = Date.now() + 10_000;
    while ((other?.store.listRuns() ?? []).some((run) => other?.manager.isActive(run.id)) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    contexts.disposeAll();
    manager.dispose();
    store.flush();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of [home, bootRoot, otherRoot]) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const liveWaiter = (patch: Partial<RunRecord> = {}): RunRecord => {
    const run = store.createRun({ title: 'Build the export page', workflow: 'quick-task', task: 't', steps: [] });
    store.updateRun(run.id, { status: 'running', ...patch });
    return store.getRun(run.id)!;
  };

  const create = (waiterId: string, create: Record<string, unknown>) =>
    apiRequest(app, `/api/v1/runs/${waiterId}/waits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [TASK_ID_HEADER]: waiterId },
      body: JSON.stringify({ create: { projectId: otherId, objective: 'mock:done add the export endpoint', ...create } }),
    });

  it('starts an autonomous root task in the other project and waits for it', async () => {
    const waiter = liveWaiter();
    const res = await create(waiter.id, { title: 'Add export endpoint', success: 'GET /export answers CSV' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; edge: WaitEdge };
    expect(body).toMatchObject({ kind: 'pending', edge: { created: true, origin: 'agent', target: { projectId: otherId }, targetTitle: 'Add export endpoint' } });
    const target = contexts.peek(otherId)!.store.getRun(body.edge.target.runId)!;
    expect(target.title).toBe('Add export endpoint');
    expect(target.autonomous).toBe(true);
    expect(target.waitedBy).toEqual({ projectId: 'default', runId: waiter.id });
    expect(target.dispatch).toBeUndefined();
    expect(target.task).toContain('## Task order');
    expect(target.task).toContain('- Success criteria: GET /export answers CSV');
    expect(target.task).toContain('- Created by: task "Build the export page"');
    expect(store.getRun(waiter.id)?.waits).toHaveLength(1);
  }, 30_000);

  it('refuses a missing project folder, the waiter’s own project and a dispatch-off cockpit — writing no edge', async () => {
    const waiter = liveWaiter();
    // The folder is gone before anything opened the project: its context is never built.
    rmSync(otherRoot, { recursive: true, force: true });
    clearProjectProbeCache();
    const missing = await create(waiter.id, {});
    expect(missing.status).toBe(409);
    expect(((await missing.json()) as { error: string }).error).toContain('project folder not found');
    mkdirSync(otherRoot);
    clearProjectProbeCache();

    const own = await apiRequest(app, `/api/v1/runs/${waiter.id}/waits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ create: { projectId: 'default', objective: 'x' } }),
    });
    expect(own.status).toBe(400);

    process.env.CEZ_DISPATCH = '0';
    const off = await create(waiter.id, {});
    expect(off.status).toBe(409);
    expect(((await off.json()) as { error: string }).error).toContain('CEZ_DISPATCH=0');
    expect(store.getRun(waiter.id)?.waits).toBeUndefined();
  });

  it('counts created tasks and dispatched children against one in-flight cap', async () => {
    const pending = (i: number): WaitEdge => ({
      id: `w${i}`,
      target: { projectId: otherId, runId: `t${i}` },
      targetTitle: `t${i}`,
      origin: 'agent',
      created: true,
      createdAt: new Date().toISOString(),
      deadline: new Date(Date.now() + 60_000).toISOString(),
      state: 'pending',
    });
    const waiter = liveWaiter({ waits: [pending(1), pending(2)] });
    for (let i = 0; i < 2; i += 1) {
      const child = store.createRun({ title: `child ${i}`, workflow: '(planned)', task: 't', steps: [] });
      store.updateRun(child.id, { status: 'running', dispatch: { rootRunId: waiter.id, parentRunId: waiter.id } });
    }
    const res = await create(waiter.id, {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('the cap is 4');
    // …and a dispatch from the same task is refused by the same count.
    expect(manager.dispatch(waiter.id, { objective: 'one more' })).toMatchObject({ refused: expect.stringContaining('the cap is 4') });
  });

  it('a budgeted creator must name a budget, within what it has left; the target gets it as its ceiling', async () => {
    const waiter = liveWaiter({ dispatch: { rootRunId: 'self', budgetUsd: 5 }, costUsd: 1 });
    store.updateRun(waiter.id, { dispatch: { rootRunId: waiter.id, budgetUsd: 5 } });
    const unnamed = await create(waiter.id, {});
    expect(unnamed.status).toBe(409);
    expect(((await unnamed.json()) as { error: string }).error).toContain('add --budget');
    const tooMuch = await create(waiter.id, { budget: 10 });
    expect(tooMuch.status).toBe(409);
    expect(((await tooMuch.json()) as { error: string }).error).toMatch(/only \$4\.00 of the budget is left/);
    const fits = await create(waiter.id, { budget: 3 });
    expect(fits.status).toBe(200);
    const { edge } = (await fits.json()) as { edge: WaitEdge };
    expect(edge.budgetUsd).toBe(3);
    expect(contexts.peek(otherId)!.store.getRun(edge.target.runId)?.dispatch).toEqual({ rootRunId: edge.target.runId, budgetUsd: 3 });
    // The reservation is carved: $1 left, so a second $2 task is refused.
    const second = await create(waiter.id, { budget: 2 });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toMatch(/only \$1\.00 of the budget is left/);
  }, 30_000);

  it('dry run end to end: A creates a task in Q, parks awaiting, and wakes with Q’s outcome', async () => {
    const stdinFile = join(bootRoot, 'mock-stdin.ndjson');
    savedEnv.CEZ_MOCK_STDIN_FILE = process.env.CEZ_MOCK_STDIN_FILE;
    process.env.CEZ_MOCK_STDIN_FILE = stdinFile;
    const waiter = manager.startRun(
      { name: 'quick-task', source: 'built-in', steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }] },
      { task: 'mock:pause build the export page', autonomous: true },
    );
    const until = async (pred: () => boolean) => {
      const deadline = Date.now() + 25_000;
      while (!pred()) {
        if (Date.now() > deadline) throw new Error('condition not met in time');
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    try {
      await until(() => store.getRun(waiter.id)?.status === 'running');
      const res = await create(waiter.id, { title: 'Add export endpoint' });
      expect(res.status).toBe(200);
      const { edge } = (await res.json()) as { edge: WaitEdge };
      await until(() => store.getRun(waiter.id)?.activity === 'monitoring');
      await until(() => store.getRun(waiter.id)?.waits?.[0]?.state === 'settled');
      const target = contexts.peek(otherId)!.store.getRun(edge.target.runId)!;
      expect(['done', 'review']).toContain(target.status);
      await until(() => {
        try {
          return readFileSync(stdinFile, 'utf8').includes(`The task you were waiting for (${otherId}/${edge.target.runId.slice(0, 8)})`);
        } catch {
          return false;
        }
      });
    } finally {
      manager.cancel(waiter.id);
      const deadline = Date.now() + 10_000;
      while (manager.isActive(waiter.id) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    }
  }, 60_000);
});
