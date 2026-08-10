import { loadWorkflows } from '../workflows/load.ts';
import { stepsIssue, type WorkflowDef } from '../workflows/types.ts';
import type { RunStore } from '../runs/store.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';
import type { ScheduledTaskStore } from './store.ts';
import type { ScheduledTaskDefinition, ScheduledTaskTrigger } from './types.ts';

export interface ScheduledLaunchResult {
  runId: string;
  groupId?: string;
}

/**
 * Launch one due (or `Run now`) occurrence through the ORDINARY manager, crash-safely.
 *
 * The provenance is carried into every record at CREATION (the `scheduledTask` create option),
 * the jobs are DEFERRED, the run store is flushed SYNCHRONOUSLY, and only then is the queue made
 * pumpable. This is the whole point of the durable-launch contract: no paid agent work can exist
 * before its occurrence id is on disk, so a crash on either side reconciles rather than duplicates.
 * The launch adapter never patches `scheduledTask` onto a run after `startRun` returns.
 */
export async function launchScheduledRun(options: {
  root: string;
  manager: RunManager;
  store: RunStore;
  definition: ScheduledTaskDefinition;
  occurrenceId: string;
  trigger: ScheduledTaskTrigger;
  scheduledFor: string;
}): Promise<ScheduledLaunchResult> {
  const { definition } = options;
  let workflow: WorkflowDef | undefined;
  if (definition.task.steps) {
    const issue = stepsIssue(definition.task.steps);
    if (issue) throw new Error(issue);
    workflow = { name: '(planned)', source: 'built-in', steps: definition.task.steps };
  } else {
    const loaded = await loadWorkflows(options.root);
    workflow = loaded.workflows.find((item) => item.name === (definition.task.workflow ?? 'quick-task'));
    if (!workflow) throw new Error(`unknown workflow: ${definition.task.workflow ?? 'quick-task'}`);
  }

  const input: StartRunInput = {
    task: definition.task.prompt,
    model: definition.task.model,
    runner: definition.task.runner,
    agentProfile: definition.task.agentProfile,
    systemPrompt: definition.task.systemPrompt,
    worktree: definition.task.worktree,
    autonomous: definition.task.autonomous,
    generateFollowups: definition.task.generateFollowups,
  };
  const provenance = {
    scheduledTaskId: definition.id,
    revision: definition.revision,
    occurrenceId: options.occurrenceId,
    scheduledFor: options.scheduledFor,
    trigger: options.trigger,
  };
  const variants = definition.task.variants ?? 1;
  const runs = variants > 1
    ? options.manager.startVariants(workflow, input, variants, { scheduledTask: provenance, defer: true })
    : [options.manager.startRun(workflow, input, undefined, { scheduledTask: provenance, defer: true })];

  // Persist the provenance-bearing record(s) BEFORE any agent can pump.
  options.store.flush();
  options.manager.pumpQueue();

  const first = runs[0];
  if (!first) throw new Error('run manager did not create a run');
  return { runId: first.id, ...(first.groupId ? { groupId: first.groupId } : {}) };
}

/**
 * Reconcile reserved occurrences against additive run provenance after a restart.
 *
 *  - reserved + matching run → finalize `launched` and complete the definition;
 *  - reserved + no run → `launch-error`, which offers an explicit one-occurrence retry.
 *
 * A definition becomes `completed` ONLY once the matching run is durably visible.
 */
export function reconcileScheduledTasks(store: ScheduledTaskStore, runStore: RunStore): number {
  const byOccurrence = new Map(
    runStore
      .listRuns()
      .flatMap((run) => (run.scheduledTask ? [[run.scheduledTask.occurrenceId, run] as const] : [])),
  );
  let reconciled = 0;
  for (const occurrence of store.latestOccurrencesById().values()) {
    if (occurrence.status !== 'reserved') continue;
    const run = byOccurrence.get(occurrence.occurrenceId);
    const now = new Date().toISOString();
    store.appendOccurrence({
      ...occurrence,
      status: run ? 'launched' : 'launch-error',
      runId: run?.id,
      groupId: run?.groupId,
      reason: run
        ? undefined
        : 'Cezar restarted before run creation completed; explicit retry is available.',
      updatedAt: now,
    });
    if (run) {
      const state = store.state(occurrence.scheduledTaskId) ?? {};
      store.setState(occurrence.scheduledTaskId, {
        ...state,
        status: 'completed',
        lastOccurrenceId: occurrence.occurrenceId,
        lastRunId: run.id,
        lastObservedAt: now,
      });
    }
    reconciled++;
  }
  return reconciled;
}
