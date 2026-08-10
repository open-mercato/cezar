import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { launchScheduledRun, reconcileScheduledTasks } from './task-template.ts';
import { ScheduledTaskStore } from './store.ts';
import type { ScheduledTaskDefinition } from './types.ts';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

const definition: ScheduledTaskDefinition = {
  id: 'one', revision: 3, name: 'Nightly', enabled: true,
  timing: { kind: 'once', at: '2026-09-01T13:30:00.000Z', timezone: 'America/New_York' },
  task: { prompt: 'Summarize the day', workflow: 'quick-task' },
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
};

async function root(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A manager stub whose `startRun` bakes provenance into the record at creation (via `createRun`),
 *  matching the real manager's durable-launch contract. */
function stubManager(store: RunStore) {
  const pumpQueue = vi.fn();
  const startRun = (
    workflow: { name: string; steps: Array<{ id: string; name?: string; command?: string }> },
    input: { task: string },
    _group: unknown,
    options?: { scheduledTask?: never },
  ) => store.createRun({
    title: 'scheduled', workflow: workflow.name, task: input.task,
    scheduledTask: options?.scheduledTask,
    steps: workflow.steps.map((s) => ({ id: s.id, name: s.name ?? s.id, kind: s.command ? 'check' as const : 'agent' as const })),
  });
  const manager = {
    startRun,
    startVariants: (workflow: never, input: never, count: number, options?: never) =>
      Array.from({ length: count }, () => startRun(workflow as never, input as never, undefined, options)),
    pumpQueue,
  } as unknown as RunManager;
  return { manager, pumpQueue };
}

describe('scheduled task launch', () => {
  it('bakes provenance into the run at creation and flushes before pumping', async () => {
    const dir = await root('cezar-sched-launch-');
    const store = RunStore.open(join(dir, '.ai/cezar'));
    const flush = vi.spyOn(store, 'flush');
    const { manager, pumpQueue } = stubManager(store);
    const launched = await launchScheduledRun({
      root: dir, manager, store, definition,
      occurrenceId: 'occ-1', trigger: 'scheduled', scheduledFor: definition.timing.at,
    });
    expect(store.getRun(launched.runId)?.scheduledTask).toEqual({
      scheduledTaskId: 'one', revision: 3, occurrenceId: 'occ-1', scheduledFor: definition.timing.at, trigger: 'scheduled',
    });
    // The record must be flushed to disk BEFORE the queue is made pumpable.
    expect(flush).toHaveBeenCalled();
    expect(pumpQueue).toHaveBeenCalled();
    expect(flush.mock.invocationCallOrder[0]!).toBeLessThan(pumpQueue.mock.invocationCallOrder[0]!);
  });

  it('creates one record per variant carrying the same occurrence provenance', async () => {
    const dir = await root('cezar-sched-variants-');
    const store = RunStore.open(join(dir, '.ai/cezar'));
    const { manager } = stubManager(store);
    await launchScheduledRun({
      root: dir, manager, store,
      definition: { ...definition, task: { ...definition.task, variants: 3 } },
      occurrenceId: 'occ-2', trigger: 'scheduled', scheduledFor: definition.timing.at,
    });
    const runs = store.listRuns().filter((r) => r.scheduledTask?.occurrenceId === 'occ-2');
    expect(runs).toHaveLength(3);
  });

  it('reconciles a reserved occurrence from persisted run provenance', async () => {
    const dir = await root('cezar-sched-reconcile-');
    const dataDir = join(dir, '.ai/cezar');
    const runs = RunStore.open(dataDir);
    const run = runs.createRun({
      title: 'x', workflow: 'quick-task', task: 'x', steps: [],
      scheduledTask: { scheduledTaskId: 'one', revision: 3, occurrenceId: 'occ-1', scheduledFor: definition.timing.at, trigger: 'scheduled' },
    });
    const scheduled = ScheduledTaskStore.open(dataDir);
    scheduled.appendOccurrence({
      occurrenceId: 'occ-1', occurrenceKey: 'one:3:at', scheduledTaskId: 'one', revision: 3,
      scheduledFor: definition.timing.at, observedAt: '2026-09-01T13:30:00.000Z', trigger: 'scheduled',
      status: 'reserved', updatedAt: '2026-09-01T13:30:00.000Z',
    });
    expect(reconcileScheduledTasks(scheduled, runs)).toBe(1);
    expect(scheduled.latestOccurrencesById().get('occ-1')).toMatchObject({ status: 'launched', runId: run.id });
    expect(scheduled.state('one')?.status).toBe('completed');
  });

  it('marks a reserved occurrence launch-error when no run exists to reconcile', async () => {
    const dir = await root('cezar-sched-reconcile-error-');
    const dataDir = join(dir, '.ai/cezar');
    const runs = RunStore.open(dataDir);
    const scheduled = ScheduledTaskStore.open(dataDir);
    scheduled.appendOccurrence({
      occurrenceId: 'occ-9', occurrenceKey: 'one:3:at', scheduledTaskId: 'one', revision: 3,
      scheduledFor: definition.timing.at, observedAt: '2026-09-01T13:30:00.000Z', trigger: 'scheduled',
      status: 'reserved', updatedAt: '2026-09-01T13:30:00.000Z',
    });
    expect(reconcileScheduledTasks(scheduled, runs)).toBe(1);
    expect(scheduled.latestOccurrencesById().get('occ-9')?.status).toBe('launch-error');
  });
});
