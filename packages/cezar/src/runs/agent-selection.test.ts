import { describe, expect, it } from 'vitest';
import { switchedWorkflowAgent, taskAgentSelection, workflowAgentSwitch } from './agent-selection.ts';
import type { RunRecord, StepState } from './store.ts';

const createdAt = '2026-11-24T10:00:00.000Z';
const codex = { runner: 'codex', model: 'gpt-6.2-sol', agentProfile: 'work', reasoningEffort: 'high' } as const;

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'task', title: 'Review the build', task: 'Review the build', workflow: 'review',
    status: 'done', createdAt, tokensUsed: 0, steps: [], archived: false,
    runner: 'claude', model: 'opus', reasoningEffort: 'medium', agentProfile: 'personal',
    workflowDef: { name: 'review', source: 'file', steps: [
      { id: 'work', prompt: '{{task}}', runner: 'claude' },
      { id: 'review', prompt: '{{task}}', runner: 'codex', model: codex.model },
      { id: 'verify', command: 'true' },
    ] },
    ...overrides,
  };
}

function step(id: string, overrides: Partial<StepState> = {}): StepState {
  return { id, name: id, kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, ...overrides };
}

describe('taskAgentSelection', () => {
  it('takes the most recently started agent on a settled run, regardless of stored step order', () => {
    const record = run({ steps: [
      step('review', { backend: 'codex', profileId: 'work', startedAt: '2026-11-24T11:00:00.000Z' }),
      step('work', { backend: 'claude', profileId: 'personal', startedAt: createdAt }),
    ] });
    expect(taskAgentSelection(record)).toMatchObject({ runner: 'codex', agentProfile: 'work', model: codex.model });
  });

  it('selects the effective agent at the queued workflow cursor', () => {
    const record = run({ status: 'queued', graphState: { cursor: 'review', loops: {}, taken: [] } });
    const workflowSelection = workflowAgentSwitch(record, 'codex', { runner: 'opencode', agentProfile: 'default' }, 'claude');
    record.agentSwitch = { summary: 'Switched the review', workflow: true, workflowSelection };
    expect(taskAgentSelection(record)).toMatchObject({ runner: 'opencode', agentProfile: 'default' });
    expect(taskAgentSelection(record).model).toBeUndefined();
  });

  it('selects the queued check repair agent from the task instead of the workflow definition', () => {
    const record = run({
      ...codex, status: 'queued', graphState: { cursor: 'verify', loops: {}, taken: [] },
      agentSwitch: { summary: 'Switched to repair the check', workflow: true, checkRepair: { checkId: 'verify', stepId: 'check-repair-1' } },
    });
    expect(taskAgentSelection(record)).toMatchObject(codex);
  });
});

describe('workflowAgentSwitch', () => {
  it('uses the project default for unpinned steps on older runs with no stored runner', () => {
    const result = workflowAgentSwitch(run({ runner: undefined }), 'claude', codex, 'claude');
    expect(result.original).toEqual({ runner: 'claude', agentProfile: 'personal', model: 'opus', reasoningEffort: 'medium' });
    expect(result.overrides).toEqual({ claude: codex, unpinned: codex });
  });

  it('changes only slots that use the replaced runner and clears its model and effort for a new runner', () => {
    const result = workflowAgentSwitch(run(), 'codex', { runner: 'opencode', agentProfile: 'default' }, 'claude');
    expect(result.overrides).toEqual({ codex: { runner: 'opencode', agentProfile: 'default', model: null, reasoningEffort: null } });
  });

  it('keeps effective pins for an account switch and leaves other overrides intact', () => {
    const record = run();
    const first = workflowAgentSwitch(record, 'claude', codex, 'claude');
    const second = workflowAgentSwitch({
      ...record, runner: 'codex', agentSwitch: { summary: 'First switch', workflow: true, workflowSelection: first },
    }, 'pi', { runner: 'pi', agentProfile: 'extra' }, 'claude');
    const third = workflowAgentSwitch({
      ...record, runner: 'pi', agentSwitch: { summary: 'Second switch', workflow: true, workflowSelection: second },
    }, 'codex', { runner: 'codex', agentProfile: 'another' }, 'claude');
    expect(third.original).toEqual(first.original);
    expect(third.overrides.unpinned).toEqual({ ...codex, agentProfile: 'another' });
    expect(third.overrides.claude).toEqual(third.overrides.unpinned);
    expect(third.overrides.pi).toEqual(second.overrides.pi);
    expect(first.overrides.codex).toBeUndefined();
  });

  it('drops an earlier override model when models are locked', () => {
    const record = run();
    const first = workflowAgentSwitch(record, 'claude', codex, 'claude');
    const switched = { ...record, ...codex, agentSwitch: { summary: 'First switch', workflow: true as const, workflowSelection: first } };
    const target = { runner: 'codex', agentProfile: 'another' } as const;
    expect(workflowAgentSwitch(switched, 'codex', target, 'claude').overrides.unpinned)
      .toMatchObject({ model: codex.model, reasoningEffort: codex.reasoningEffort });
    expect(workflowAgentSwitch(switched, 'codex', target, 'claude', false).overrides.unpinned)
      .toEqual({ ...target, model: null, reasoningEffort: null });
  });

  it('switches both originally pinned Codex steps and steps moved there by the first switch', () => {
    const record = run();
    const first = workflowAgentSwitch(record, 'claude', codex, 'claude');
    const switched = { ...record, ...codex, agentSwitch: { summary: 'First switch', workflow: true as const, workflowSelection: first } };
    expect(switchedWorkflowAgent(switched, { runner: 'codex', model: codex.model })?.replaced).toBe(false);
    const target = { runner: 'pi', agentProfile: 'default' } as const;
    const second = workflowAgentSwitch(switched, 'codex', target, 'claude');
    const result = { ...switched, ...target, agentSwitch: { ...switched.agentSwitch, workflowSelection: second } };
    for (const runner of [undefined, 'claude', 'codex'] as const) {
      expect(switchedWorkflowAgent(result, { runner })).toEqual({
        ...target, model: undefined, reasoningEffort: undefined, replaced: true,
      });
    }
    expect(switchedWorkflowAgent(result, { runner: 'opencode' })).toMatchObject({ runner: 'opencode', replaced: false });
  });
});

describe('switchedWorkflowAgent', () => {
  it('leaves resolution to the normal workflow when there is no switch and honors older switch records', () => {
    expect(switchedWorkflowAgent(run(), { runner: 'pi' })).toBeUndefined();
    expect(switchedWorkflowAgent(run({
      ...codex, agentSwitch: { summary: 'Older switch', workflow: true },
    }), { runner: 'claude', model: 'sonnet' })).toEqual({ ...codex, replaced: true });
  });

  it('preserves each step’s own pins for an account-only change on the same runner', () => {
    const record = run();
    const workflowSelection = workflowAgentSwitch(record, 'claude', { runner: 'claude', agentProfile: 'work' }, 'claude');
    record.agentSwitch = { summary: 'Account switch', workflow: true, workflowSelection };
    expect(switchedWorkflowAgent(record, { model: 'sonnet', reasoningEffort: 'low' })).toEqual({
      runner: 'claude', model: 'sonnet', reasoningEffort: 'low', agentProfile: 'work', replaced: true,
    });
    expect(switchedWorkflowAgent(record, {})).toMatchObject({ model: 'opus', reasoningEffort: 'medium' });
    expect(switchedWorkflowAgent(record, { runner: 'codex', model: codex.model })).toEqual({
      runner: 'codex', model: codex.model, reasoningEffort: undefined, agentProfile: undefined, replaced: false,
    });
  });

  it('uses native defaults after a runner switch even when the previous node pinned a model and effort', () => {
    const record = run();
    const workflowSelection = workflowAgentSwitch(record, 'claude', { runner: 'codex', agentProfile: 'work' }, 'claude');
    record.agentSwitch = { summary: 'Runner switch', workflow: true, workflowSelection };
    expect(switchedWorkflowAgent(record, { runner: 'claude', model: 'sonnet', reasoningEffort: 'high' })).toEqual({
      runner: 'codex', agentProfile: 'work', model: undefined, reasoningEffort: undefined, replaced: true,
    });
  });
});
