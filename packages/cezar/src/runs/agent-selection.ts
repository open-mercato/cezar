import type { SwitchRunAgentInput, WorkflowAgentSwitch } from '@open-mercato/cezar-contract';
import { stepKind } from '../workflows/types.ts';
import { RUNNER_IDS, type RunnerId } from '../core/agent-runner.ts';
import type { RunRecord } from './store.ts';

type AgentPin = { runner?: RunnerId; model?: string; reasoningEffort?: string };
type WorkflowSwitchInput = Pick<SwitchRunAgentInput, 'runner' | 'model' | 'reasoningEffort'> & { agentProfile: string };

export function workflowAgentSwitch(
  run: RunRecord,
  from: RunnerId,
  target: WorkflowSwitchInput,
  defaultRunner: RunnerId,
): WorkflowAgentSwitch {
  const previous = run.agentSwitch?.workflowSelection;
  const original = previous?.original ?? {
    runner: run.runner ?? defaultRunner,
    agentProfile: run.agentProfile,
    model: run.model,
    reasoningEffort: run.reasoningEffort,
  };
  const overrides = { ...previous?.overrides };
  for (const slot of ['unpinned', ...RUNNER_IDS] as const) {
    const old = overrides[slot];
    if (slot !== 'unpinned' && (old?.runner ?? slot) !== from) continue;
    const keepsRunner = (old?.runner ?? (slot === 'unpinned' ? original.runner : slot)) === target.runner;
    overrides[slot] = {
      runner: target.runner,
      agentProfile: target.agentProfile,
      model: target.model === undefined ? (keepsRunner ? old?.model : null) : target.model || null,
      reasoningEffort: target.reasoningEffort ?? (keepsRunner && target.model === undefined ? old?.reasoningEffort : null),
    };
  }
  return { original, overrides };
}

/** Resolve a node against the original task defaults and its own switch, if any. */
export function switchedWorkflowAgent(run: RunRecord, pin: AgentPin) {
  const plan = run.agentSwitch?.workflowSelection;
  if (!plan) {
    // Older records applied the selected agent to every node.
    return run.agentSwitch?.workflow && run.runner
      ? { runner: run.runner, model: run.model, reasoningEffort: run.reasoningEffort, agentProfile: run.agentProfile, replaced: true }
      : undefined;
  }
  const { original, overrides } = plan;
  const runner = pin.runner ?? original.runner;
  const override = overrides[pin.runner ?? 'unpinned'];
  const usesTaskDefaults = runner === original.runner;
  const model = pin.model ?? (usesTaskDefaults ? original.model : undefined);
  const reasoningEffort = pin.reasoningEffort ?? (usesTaskDefaults ? original.reasoningEffort : undefined);
  return {
    runner: override?.runner ?? runner,
    agentProfile: override ? override.agentProfile : usesTaskDefaults ? original.agentProfile : undefined,
    model: override?.model === undefined ? model : override.model ?? undefined,
    reasoningEffort: override?.reasoningEffort === undefined ? reasoningEffort : override.reasoningEffort ?? undefined,
    replaced: Boolean(override),
  };
}

/** The agent a switch replaces, including a workflow pin the task itself did not request. */
export function taskAgentSelection(run: RunRecord, defaultRunner: RunnerId = 'claude') {
  const live = run.status === 'queued' ? undefined
    : run.steps.find((step) => step.id === run.currentStepId && step.backend)
      ?? [...run.steps].reverse().find((step) => step.backend);
  const queuedWorkflow = run.status === 'queued'
    && !run.steps.some((step) => step.status === 'pending' && step.id.startsWith('continue-'));
  const definition = live ? run.workflowDef?.steps.find((step) => step.id === live.id)
    : queuedWorkflow ? run.workflowDef?.steps.find((step) => step.id === run.graphState?.cursor && stepKind(step) === 'agent')
      ?? run.workflowDef?.steps.find((step) => stepKind(step) === 'agent') : undefined;
  const planned = definition && switchedWorkflowAgent(run, definition);
  if (planned && (!live?.backend || planned.runner === live.backend)) {
    return {
      ...planned,
      agentProfile: live?.profileId ?? planned.agentProfile,
      actualModel: live?.actualModel,
    };
  }
  const taskRunner = run.runner ?? defaultRunner;
  const runner = live?.backend ?? definition?.runner ?? taskRunner;
  const usesTaskAgent = runner === taskRunner;
  return {
    runner,
    agentProfile: live?.profileId ?? (usesTaskAgent ? run.agentProfile : undefined),
    model: live?.model ?? definition?.model ?? (usesTaskAgent ? run.model : undefined),
    reasoningEffort: live?.reasoningEffort ?? definition?.reasoningEffort ?? (usesTaskAgent ? run.reasoningEffort : undefined),
    actualModel: live?.actualModel ?? (usesTaskAgent ? run.actualModel : undefined),
  };
}
