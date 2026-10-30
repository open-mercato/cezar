import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { digest, previewDeferredStart, resolveDeferredExecution, validateDeferredBinding } from './deferred-start.ts';
import { AutomationStore } from './store.ts';
import { launchScheduledRun } from './task-template.ts';
import { automationTaskSchema, type ScheduleAutomationDefinition } from './types.ts';

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'scheduled-access-')));
  mkdirSync(join(root, 'codex'));
  vi.stubEnv('CEZ_HOME', join(root, 'home'));
  vi.stubEnv('CODEX_HOME', join(root, 'codex'));
  vi.stubEnv('CEZ_DRY_RUN', '1');
  vi.stubEnv('CEZ_AGENT_MODELS_LOCKED', '0');
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
const start = { kind: 'at', date: '2099-01-01', hour: 9, minute: 0 } as const;
const task = { task: 'Later', workflow: 'quick-task', runner: 'codex' } as const;

describe('scheduled execution access mode', () => {
  it.each([undefined, 'standard', 'daybreak-blue'] as const)('forwards %s through ordinary and deferred scheduled launch', async accessMode => {
    const selected = { ...task, ...(accessMode ? { accessMode } : {}) };
    const previewed = await previewDeferredStart(root, { task: selected, start }, true);
    if (!previewed.preview.available || !previewed.binding || !previewed.schedule) throw new Error('Fixture preview unavailable');
    const store = RunStore.open(join(root, '.ai/cezar'));
    const automations = AutomationStore.open(join(root, '.ai/cezar'));
    const inputs: StartRunInput[] = [];
    const manager = { startRun: (workflow: WorkflowDef, input: StartRunInput) => {
      inputs.push(input);
      return store.createRun({ title: 'Scheduled fixture', workflow: workflow.name, task: input.task,
        runner: input.runner, accessMode: input.accessMode, steps: [] });
    } } as unknown as RunManager;
    for (const deferred of [false, true]) {
      const definition = automations.create({ name: 'Later', kind: 'schedule', enabled: false,
        schedule: previewed.schedule, task: { prompt: selected.task, workflow: selected.workflow, runner: selected.runner,
          ...(accessMode ? { accessMode } : {}) },
        ...(deferred ? { deferredStart: { origin: 'composer' as const, reason: 'at' as const,
          notBefore: previewed.preview.notBefore, timeZone: previewed.preview.timeZone, binding: previewed.binding,
          creationKey: randomUUID(), requestDigest: 'fixture', status: 'launching' as const, runIds: [randomUUID()] } } : {}),
      }) as ScheduleAutomationDefinition;
      const launched = await launchScheduledRun({ root, store, manager, definition,
        occurrence: { at: previewed.preview.notBefore, trigger: 'schedule' }, receiptId: randomUUID(), projectName: 'Fixture', timeZone: 'UTC' });
      expect(store.getRun(launched.runId)?.accessMode).toBe(accessMode);
    }
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      if (accessMode) expect(input.accessMode).toBe(accessMode);
      else expect(input).not.toHaveProperty('accessMode');
    }
  });

  it('binds explicit treatment changes while retaining legacy native binding digests', async () => {
    const native = await resolveDeferredExecution(root, task);
    const standard = await resolveDeferredExecution(root, { ...task, accessMode: 'standard' });
    const blue = await resolveDeferredExecution(root, { ...task, accessMode: 'daybreak-blue' });
    expect(new Set([native.binding.revision, standard.binding.revision, blue.binding.revision]).size).toBe(3);
    expect(native.binding.revision).toBe(digest({ root, workflow: native.workflow, runner: native.binding.runner,
      accounts: native.binding.accounts, models: native.models.map(({ runner, model }) => ({ runner, model })), modelPolicy: false }));
    const previewed = await previewDeferredStart(root, { task: { ...task, accessMode: 'daybreak-blue' }, start }, true);
    if (!previewed.preview.available || !previewed.binding || !previewed.schedule) throw new Error('Fixture preview unavailable');
    const definition = AutomationStore.open(join(root, 'automations')).create({ name: 'Later', kind: 'schedule', enabled: false,
      schedule: previewed.schedule, task: { prompt: task.task, workflow: task.workflow, runner: task.runner, accessMode: 'standard' },
      deferredStart: { origin: 'composer', reason: 'at', notBefore: previewed.preview.notBefore, timeZone: previewed.preview.timeZone,
        binding: previewed.binding, creationKey: 'mode-change', requestDigest: 'fixture', status: 'pending', runIds: [] },
    });
    await expect(validateDeferredBinding(root, definition)).rejects.toThrow('execution settings changed');
  });

  it('validates the stored field and refuses explicit treatment under model lock', async () => {
    expect(automationTaskSchema.safeParse({ prompt: 'Later', accessMode: 'unknown' }).success).toBe(false);
    expect(automationTaskSchema.safeParse({ prompt: 'Later', accessMode: null }).success).toBe(false);
    vi.stubEnv('CEZ_AGENT_MODELS_LOCKED', '1');
    const previewed = await previewDeferredStart(root, { task: { ...task, accessMode: 'daybreak-blue' }, start }, true);
    expect(previewed.preview).toMatchObject({ available: false, message: 'Model selection is locked for this project.' });
  });
});
