import { stepKind } from '../workflows/types.ts';
import type { RunnerId } from '../core/agent-runner.ts';
import type { RunRecord } from './store.ts';

/** The agent a switch replaces, including a workflow pin the task itself did not request. */
export function taskAgentSelection(run: RunRecord, defaultRunner: RunnerId = 'claude') {
  const live = run.status === 'queued' ? undefined
    : run.steps.find((step) => step.id === run.currentStepId && step.backend)
      ?? [...run.steps].reverse().find((step) => step.backend);
  const definition = run.agentSwitch?.workflow ? undefined
    : live ? run.workflowDef?.steps.find((step) => step.id === live.id)
      : run.status === 'queued' ? run.workflowDef?.steps.find((step) => stepKind(step) === 'agent') : undefined;
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
