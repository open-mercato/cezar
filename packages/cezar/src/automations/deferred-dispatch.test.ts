import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

vi.mock('./deferred-start.ts', async (original) => ({ ...await original<typeof import('./deferred-start.ts')>(), validateDeferredBinding: async () => {} }));
const { launchScheduledRun } = await import('./task-template.ts');
const { RunStore } = await import('../runs/store.ts');
type Definition = Parameters<typeof launchScheduledRun>[0]['definition'];

it('a composer start keeps its whole dispatch intent, not just the subtask ceiling (#1340)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-deferred-dispatch-'));
  try {
    const store = RunStore.open(join(root, '.ai/cezar'));
    const inputs: Array<Record<string, unknown>> = [];
    const manager = { startRun: (workflow: { name: string }, input: Record<string, unknown>) => {
      inputs.push(input);
      return store.createRun({ title: 't', workflow: workflow.name, task: String(input.task), steps: [] });
    } } as unknown as Parameters<typeof launchScheduledRun>[0]['manager'];
    const dispatch = { maxSubtasks: 3, inFlight: 1, runner: 'codex', model: 'gpt-5', budgetUsd: 5 };
    const definition = { id: 'later', revision: 1, name: 'Later', kind: 'schedule', enabled: true, createdAt: '', updatedAt: '',
      schedule: { type: 'once', date: '2099-01-01', hour: 9, minute: 0 },
      task: { prompt: 'Split it', workflow: 'quick-task', dispatch },
      deferredStart: { origin: 'composer', reason: 'at', notBefore: '2099-01-01T09:00:00.000Z', timeZone: 'UTC', creationKey: 'k', requestDigest: 'd', status: 'launching', runIds: ['run-a'],
        binding: { revision: 'r', runner: 'claude', accounts: [] } },
    } as unknown as Definition;
    await launchScheduledRun({ root, manager, store, definition, occurrence: { at: '2099-01-01T09:00:00.000Z', trigger: 'schedule' }, receiptId: 'r', projectName: 'p', timeZone: 'UTC', dispatchEnabled: true });
    expect(inputs[0]).toMatchObject({ dispatchIntent: dispatch });
    store.flush();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('reuses a variant persisted by a different cockpit without overwriting it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-deferred-reuse-'));
  try {
    const dir = join(root, '.ai/cezar');
    const store = RunStore.open(dir);
    const writer = RunStore.open(dir);
    writer.createRun({ id: 'run-a', title: 'original', workflow: 'quick-task', task: 'original', steps: [] });
    writer.flush({ throwOnError: true });
    const startRun = vi.fn((workflow, input) => store.createRun({
      id: input.scheduledLaunch.id, title: 'new', workflow: workflow.name, task: input.task, steps: [],
    }));
    const definition = { id: 'later', revision: 1, name: 'Later', kind: 'schedule', enabled: true,
      createdAt: '', updatedAt: '', schedule: { type: 'once', date: '2099-01-01', hour: 9, minute: 0 },
      task: { prompt: 'test', workflow: 'quick-task', variants: 2 },
      deferredStart: { origin: 'composer', reason: 'at', notBefore: '2099-01-01T09:00:00.000Z',
        timeZone: 'UTC', creationKey: 'k', requestDigest: 'd', status: 'launching', runIds: ['run-a', 'run-b'],
        binding: { revision: 'r', runner: 'claude', accounts: [] } },
    } as Definition;
    await launchScheduledRun({ root, store, manager: { startRun } as unknown as Parameters<typeof launchScheduledRun>[0]['manager'],
      definition, occurrence: { at: definition.deferredStart!.notBefore, trigger: 'manual' },
      receiptId: 'r', projectName: 'p', timeZone: 'UTC' });
    expect(startRun).toHaveBeenCalledTimes(1);
    expect(startRun.mock.calls[0]![1].scheduledLaunch.id).toBe('run-b');
    expect(store.listPersistedRuns().find(r => r.id === 'run-a')).toMatchObject({ title: 'original', task: 'original' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each([false, true])('a failed scheduled write cannot be rescued or overwrite a retry (same cockpit: %s)', async (sameCockpit) => {
  const { RunManager } = await import('../workflows/run.ts');
  const { AutomationStore } = await import('./store.ts');
  const { ScheduleRunner } = await import('./schedule-runner.ts');
  const root = await mkdtemp(join(tmpdir(), 'review-flush-'));
  vi.stubEnv('CEZ_AUTONAME', '0');
  vi.stubEnv('CEZ_DRY_RUN', '1');
  const dataDir = join(root, '.ai/cezar');
  const store = RunStore.open(dataDir);
  const manager = new RunManager(store, root);
  const execute = vi.spyOn(manager as unknown as { execute: (...args: unknown[]) => Promise<void> }, 'execute').mockResolvedValue(undefined);
  const automations = AutomationStore.open(join(root, '.ai/cezar'));
  const definition = automations.create({ name: 'Later', kind: 'schedule', enabled: true,
    schedule: { type: 'once', date: '2099-01-01', hour: 9, minute: 0 },
    task: { prompt: 'test', workflow: 'quick-task', runner: 'claude', worktree: false },
    deferredStart: { origin: 'composer', reason: 'at', notBefore: '2099-01-01T09:00:00.000Z',
      timeZone: 'UTC', creationKey: 'k', requestDigest: 'd', status: 'pending', runIds: [],
      binding: { revision: 'r', runner: 'claude', accounts: [] } },
  }) as Definition;
  try {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dataDir, 'runs.json')); // Real rename failure, independent of unique temp names.
    const runner = new ScheduleRunner({ projectId: 'p', store: automations, timeZone: 'UTC', validateDeferred: async () => {},
      launch: (definition, occurrence, receiptId) => launchScheduledRun({ root, store, manager, definition, occurrence, receiptId, projectName: 'p', timeZone: 'UTC' }),
    });
    expect(await runner.runNow(definition)).toMatchObject({ result: 'failed' });
    expect(automations.get(definition.id)?.deferredStart).toMatchObject({ status: 'failed', failureKind: 'ambiguous' });
    expect(execute).not.toHaveBeenCalled();
    await rm(join(dataDir, 'runs.json'), { recursive: true });
    await manager.rescueStalledQueue();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(store.listPersistedRuns()).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    const secondStore = sameCockpit ? store : RunStore.open(dataDir);
    const secondManager = sameCockpit ? manager : new RunManager(secondStore, root);
    const secondExecute = sameCockpit ? execute : vi.spyOn(secondManager as unknown as { execute: (...args: unknown[]) => Promise<void> }, 'execute').mockResolvedValue(undefined);
    try {
      const retry = new ScheduleRunner({ projectId: 'p', store: automations, timeZone: 'UTC', validateDeferred: async () => {},
        deferredRunIds: async (_, ids) => secondStore.listPersistedRuns().filter(r => ids.includes(r.id)).map(r => r.id),
        launch: (definition, occurrence, receiptId) => launchScheduledRun({ root, store: secondStore, manager: secondManager, definition, occurrence, receiptId, projectName: 'p', timeZone: 'UTC' }),
      });
      await retry.runNow(automations.get(definition.id) as Definition);
      await new Promise(resolve => setTimeout(resolve, 100));
      if (!sameCockpit) expect(execute).not.toHaveBeenCalled();
      expect(secondExecute).toHaveBeenCalledOnce();
      const id = secondExecute.mock.calls[0]![0] as string;
      expect(id).toBe(automations.creation('k')?.runIds[0]);
      secondStore.flush({ throwOnError: true });
      store.flush({ throwOnError: true });
      expect(store.listPersistedRuns().map(run => run.id)).toContain(id);
      if (!sameCockpit) expect(store.getRun(id)).toBeUndefined();
    } finally { if (!sameCockpit) { secondManager.dispose(); secondStore.flush(); } }
  } finally { manager.dispose(); store.flush(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});
