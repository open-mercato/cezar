import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { RunManager } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { isWaitRefusal } from '../workspace/waits.ts';
import { ProjectContexts } from './project-context.ts';
import { connectWaitResolver } from './wait-wiring.ts';

/**
 * Cross-task waits end to end under `CEZ_DRY_RUN=1` (spec 2026-10-05-cross-task-waits, step 10):
 * two projects, a waiter in one declares a wait on a task in the other, parks `awaiting` without
 * a slot, and is woken INTO ITS OPEN SESSION with the target's outcome when the target finishes.
 */
describe('cross-task waits, dry run end to end', () => {
  const SINGLE_STEP: WorkflowDef = { name: 'quick-task', source: 'built-in', steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }] };
  let bootRoot: string;
  let apiRoot: string;
  let stdinFile: string;
  const savedEnv: Record<string, string | undefined> = {};
  let bootStore: RunStore;
  let bootManager: RunManager;
  let contexts: ProjectContexts;
  let disconnect: () => void;
  let resolver: ReturnType<typeof connectWaitResolver>['resolver'];
  const started: Array<{ manager: RunManager; id: string }> = [];

  const waitFor = async (pred: () => boolean, ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error('condition not met in time');
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  const stdin = (): string => {
    try {
      return readFileSync(stdinFile, 'utf8');
    } catch {
      return '';
    }
  };

  beforeEach(() => {
    for (const key of ['CEZ_DRY_RUN', 'CEZ_TASK_WAITS', 'CEZ_MOCK_STDIN_FILE']) savedEnv[key] = process.env[key];
    process.env.CEZ_DRY_RUN = '1';
    delete process.env.CEZ_TASK_WAITS;
    bootRoot = mkdtempSync(join(tmpdir(), 'cez-waits-e2e-web-'));
    apiRoot = mkdtempSync(join(tmpdir(), 'cez-waits-e2e-api-'));
    stdinFile = join(bootRoot, 'mock-stdin.ndjson');
    process.env.CEZ_MOCK_STDIN_FILE = stdinFile;
    // One slot for real work: the waiter must give it up for the target to run at all.
    const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 1, maxMonitoringSessions: 0 } });
    bootStore = RunStore.open(join(bootRoot, '.ai/cezar'));
    bootManager = new RunManager(bootStore, bootRoot, { semaphore, projectId: 'web' });
    contexts = new ProjectContexts({ listProjects: async () => [{ id: 'api', root: apiRoot, status: 'not-git' }], semaphore });
    ({ disconnect, resolver } = connectWaitResolver({
      bootContext: { id: 'web', store: bootStore, manager: bootManager },
      contexts,
      canonical: async (id) => (id === 'default' ? 'web' : id),
      listProjects: async () => [{ id: 'api', root: apiRoot, status: 'not-git' }],
    }));
    started.length = 0;
  });

  afterEach(async () => {
    disconnect();
    for (const { manager, id } of started) manager.cancel(id);
    await waitFor(() => started.every(({ manager, id }) => !manager.isActive(id))).catch(() => undefined);
    contexts.disposeAll();
    bootManager.dispose();
    bootStore.flush();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const root of [bootRoot, apiRoot]) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('A waits on B in another project; B finishes; A wakes in its open session with B’s outcome', async () => {
    const api = await contexts.context('api');
    // The waiter: an autonomous task whose first turn ends plainly — it would be nudged, not
    // parked, without its wait.
    const waiter = bootManager.startRun(SINGLE_STEP, { task: 'mock:pause build the export page', autonomous: true });
    started.push({ manager: bootManager, id: waiter.id });
    await waitFor(() => bootStore.getRun(waiter.id)?.status === 'running');

    // The target is queued behind the waiter's slot (maxParallel 1).
    const target = api.manager.startRun(SINGLE_STEP, { task: 'mock:done add the export endpoint' });
    started.push({ manager: api.manager, id: target.id });
    expect(api.store.getRun(target.id)?.status).toBe('queued');

    // The agent's `cez task wait api/<id8>`, as the route would call it.
    const declared = await resolver.declare('web', waiter.id, { target: { projectId: 'api', runId: target.id.slice(0, 8) } }, 'agent');
    expect(isWaitRefusal(declared) ? declared.error : declared.kind).toBe('pending');

    // The waiter's turn ends with no marker → it parks awaiting and hands the slot to the target.
    await waitFor(() => bootStore.getRun(waiter.id)?.activity === 'monitoring');
    await waitFor(() => isSettled(api.store.getRun(target.id)));

    // The target's outcome lands in the waiter's still-open session.
    await waitFor(() => stdin().includes('The task you were waiting for (api/'));
    const edge = bootStore.getRun(waiter.id)?.waits?.[0];
    expect(edge?.state).toBe('settled');
    expect(['done', 'review']).toContain(edge?.outcome?.status);
  }, 60_000);

  const isSettled = (run: RunRecord | undefined) => run !== undefined && ['done', 'review', 'failed', 'cancelled'].includes(run.status);
});
