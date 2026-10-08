import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WaitEdge } from '@open-mercato/cezar-contract';
import { readRunIndexFromDisk } from '../runs/run-index.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { RunManager } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { isWaitRefusal } from '../workspace/waits.ts';
import { ProjectContexts, type ProjectContextSource } from './project-context.ts';
import { connectWaitResolver } from './wait-wiring.ts';

/**
 * The resolver wired into the REAL project context registry (spec
 * `.ai/specs/2026-10-05-cross-task-waits.md`, step 4): two temp projects, real stores and managers
 * on one shared semaphore, the dry-run agent. A boot target holds the only slot (`mock:slow`), so
 * the non-boot waiter — recovered into a queued continuation — never spawns an agent here.
 */
describe('cross-task waits wired into the project contexts', () => {
  const SINGLE_STEP: WorkflowDef = { name: 'quick-task', source: 'built-in', steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }] };
  let bootRoot: string;
  let webRoot: string;
  let apiRoot: string;
  let semaphore: WorkspaceSemaphore;
  let bootStore: RunStore;
  let bootManager: RunManager;
  let bootTarget: RunRecord;
  const cleanups: Array<() => Promise<void> | void> = [];
  const savedEnv: Record<string, string | undefined> = {};

  const registry = (): ProjectContextSource[] => [
    { id: 'web', root: webRoot, status: 'not-git' },
    { id: 'api', root: apiRoot, status: 'not-git' },
  ];

  const waitFor = async (pred: () => boolean, ms = 15_000) => {
    const deadline = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error('condition not met in time');
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  /** One "process": a context map + the wired resolver, as `createApp` builds them. */
  const boot = () => {
    const contexts = new ProjectContexts({ listProjects: async () => registry(), semaphore });
    const wiring = connectWaitResolver({
      bootContext: { id: 'boot', store: bootStore, manager: bootManager },
      contexts,
      canonical: async (id) => (id === 'default' ? 'boot' : id),
      listProjects: async () => registry(),
    });
    return { contexts, ...wiring };
  };

  /** A waiter in `web` as a previous process left it: running, parked, with a pending edge. */
  const seedWaiter = (deadline: string): string => {
    const store = RunStore.open(join(webRoot, '.ai/cezar'), { keepLive: true });
    const run = store.createRun({ title: 'Build the export page', workflow: 'quick-task', task: 'mock:pause build it', steps: [{ id: 'task', name: 'Task', kind: 'agent' }] });
    store.updateStep(run.id, 'task', { status: 'running', sessionId: 'sess-web-1' });
    const edge: WaitEdge = {
      id: 'edge-1',
      target: { projectId: 'boot', runId: bootTarget.id },
      targetTitle: 'Add export endpoint',
      origin: 'agent',
      createdAt: new Date().toISOString(),
      deadline,
      state: 'pending',
    };
    store.updateRun(run.id, { status: 'running', activity: 'monitoring', workflowDef: SINGLE_STEP, waits: [edge] });
    store.flush();
    return run.id;
  };

  const diskEdge = (runId: string): WaitEdge | undefined =>
    readRunIndexFromDisk(join(webRoot, '.ai/cezar')).find((run) => run.id === runId)?.waits?.[0];

  beforeEach(async () => {
    for (const key of ['CEZ_DRY_RUN', 'CEZ_TASK_WAITS']) savedEnv[key] = process.env[key];
    process.env.CEZ_DRY_RUN = '1';
    delete process.env.CEZ_TASK_WAITS;
    bootRoot = mkdtempSync(join(tmpdir(), 'cez-wire-boot-'));
    webRoot = mkdtempSync(join(tmpdir(), 'cez-wire-web-'));
    apiRoot = mkdtempSync(join(tmpdir(), 'cez-wire-api-'));
    semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 1 } });
    bootStore = RunStore.open(join(bootRoot, '.ai/cezar'));
    bootManager = new RunManager(bootStore, bootRoot, { semaphore, projectId: 'boot' });
    bootTarget = bootManager.startRun(SINGLE_STEP, { task: 'mock:slow add the export endpoint' });
    await waitFor(() => bootStore.getRun(bootTarget.id)?.status === 'running');
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    bootManager.cancel(bootTarget.id);
    await waitFor(() => !bootManager.isActive(bootTarget.id)).catch(() => undefined);
    bootManager.dispose();
    bootStore.flush();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const root of [bootRoot, webRoot, apiRoot]) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const teardown = (process: ReturnType<typeof boot>) => async () => {
    process.disconnect();
    for (const id of process.contexts.ids()) {
      const ctx = process.contexts.peek(id);
      for (const run of ctx?.store.listRuns() ?? []) ctx?.manager.cancel(run.id);
    }
    process.contexts.disposeAll();
  };

  it('the boot sweep builds a cold project holding a pending edge; shutdown leaves the edge pending; a deadline that passed while down fires after restart', async () => {
    const waiterId = seedWaiter(new Date(Date.now() + 60 * 60_000).toISOString());

    // Process 1: only the boot context exists until the sweep finds web's pending edge.
    const first = boot();
    expect(first.contexts.peek('web')).toBeUndefined();
    await first.resolver.bootSweep();
    await waitFor(() => first.contexts.peek('web') !== undefined);
    // Not the api project: nothing there waits or is waited on.
    expect(first.contexts.peek('api')).toBeUndefined();
    const web = first.contexts.peek('web')!;
    // Recovered behind the occupied slot: a queued continuation, still waiting.
    expect(web.store.getRun(waiterId)?.status).toBe('queued');
    expect(web.store.getRun(waiterId)?.waits?.[0]?.state).toBe('pending');

    // Shutdown: the process disposes every context. That is NOT a project removal.
    first.contexts.disposeAll();
    first.disconnect();
    expect(diskEdge(waiterId)?.state).toBe('pending');

    // The deadline passes while cezar is down.
    const offline = RunStore.open(join(webRoot, '.ai/cezar'), { keepLive: true });
    const edge = offline.getRun(waiterId)!.waits![0]!;
    offline.updateRun(waiterId, { waits: [{ ...edge, deadline: new Date(Date.now() - 1_000).toISOString() }] });
    offline.flush();

    // Process 2: the sweep builds web again; its catch-up resolves the stale edge at once and
    // the outcome rides the queued continuation's prompt stack.
    const second = boot();
    cleanups.push(teardown(second));
    await second.resolver.bootSweep();
    await waitFor(() => second.contexts.peek('web')?.store.getRun(waiterId)?.waits?.[0]?.state === 'timed-out');
    const waiter = second.contexts.peek('web')!.store.getRun(waiterId)!;
    expect(waiter.queuedMessages?.some((message) => message.text.includes('timed out'))).toBe(true);
  }, 40_000);

  it('a target settling in the boot project wakes a waiter in another project (live path)', async () => {
    const waiterId = seedWaiter(new Date(Date.now() + 60 * 60_000).toISOString());
    const proc = boot();
    cleanups.push(teardown(proc));
    await proc.resolver.bootSweep();
    await waitFor(() => proc.contexts.peek('web') !== undefined);
    bootManager.cancel(bootTarget.id);
    const web = proc.contexts.peek('web')!;
    await waitFor(() => web.store.getRun(waiterId)?.waits?.[0]?.state === 'settled');
    expect(web.store.getRun(waiterId)?.waits?.[0]?.outcome?.status).toBe('cancelled');
    expect(web.store.getRun(waiterId)?.queuedMessages?.some((message) => message.text.includes('has settled — cancelled'))).toBe(true);
  }, 40_000);

  it('declaring a wait on a cold project builds it; removing a project resolves its targets as unavailable', async () => {
    // A finished task in `api`, and one still to come.
    const apiStore = RunStore.open(join(apiRoot, '.ai/cezar'));
    const finished = apiStore.createRun({ title: 'Released the client', workflow: 'quick-task', task: 't', steps: [] });
    apiStore.updateRun(finished.id, { status: 'review' });
    apiStore.flush();

    const proc = boot();
    cleanups.push(teardown(proc));
    // The waiter is a live boot run: the dry-run target itself.
    const waiter = bootManager.startRun(SINGLE_STEP, { task: 'mock:slow second boot run' });
    cleanups.push(() => {
      bootManager.cancel(waiter.id);
    });
    bootStore.updateRun(waiter.id, { status: 'running' });
    expect(proc.contexts.peek('api')).toBeUndefined();
    const settled = await proc.resolver.declare('boot', waiter.id, { target: { projectId: 'api', runId: finished.id.slice(0, 8) } }, 'agent');
    expect(isWaitRefusal(settled) ? settled : settled.kind).toBe('settled');
    expect(proc.contexts.peek('api')).toBeDefined();

    const live = proc.contexts.peek('api')!.store.createRun({ title: 'Ship v2', workflow: 'quick-task', task: 't', steps: [] });
    proc.contexts.peek('api')!.store.updateRun(live.id, { status: 'running' });
    const pending = await proc.resolver.declare('boot', waiter.id, { target: { projectId: 'api', runId: live.id } }, 'agent');
    expect(isWaitRefusal(pending) ? pending : pending.kind).toBe('pending');

    proc.contexts.dispose('api');
    proc.resolver.projectRemoved('api');
    expect(bootStore.getRun(waiter.id)?.waits?.[0]?.state).toBe('target-unavailable');
  }, 40_000);

  it('disposeAll (shutdown) announces no settle — it must never resolve a wait (guard)', async () => {
    const spy = vi.fn();
    const proc = boot();
    cleanups.push(teardown(proc));
    await proc.contexts.context('api');
    proc.contexts.peek('api')!.store.on('settled', spy);
    proc.contexts.disposeAll();
    expect(spy).not.toHaveBeenCalled();
  });
});
