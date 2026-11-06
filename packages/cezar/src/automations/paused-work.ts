/**
 * What a paused automation still has in flight (#1980). Pausing stops the timer only; the tasks
 * it already launched are ordinary tasks (spec 2026-09-14), so the cockpit discloses them and an
 * agent under a paused automation's tree may no longer dispatch fresh children.
 */
import type { AutomationWork, AutomationWorkRun } from '@open-mercato/cezar-contract';
import type { RunRecord } from '../runs/store.ts';

/** The automation that launched this run on its own, or `undefined`. A by-hand `Run now`
 *  (trigger `manual`) is the user's own task, so it is never attributed here. */
export function launchingAutomationId(run: RunRecord): string | undefined {
  if (run.automationTrigger) return run.automationTrigger.trigger === 'manual' ? undefined : run.automationTrigger.automationId;
  return run.automation?.automationId ?? run.automationTracker?.automationId;
}

const rootIdOf = (run: RunRecord): string => run.dispatch?.rootRunId ?? run.id;

/** A queued run that already had a session (or a reserved `continue-*` step) resumes work rather
 *  than starting it — the same signal `reviveQueuedRun` keys on. */
function isContinuation(run: RunRecord): boolean {
  return run.steps.some((step) => Boolean(step.sessionId) || step.id.startsWith('continue-'));
}

/** Every live run in the trees this automation launched, split into pending and active. */
export function automationWork(runs: readonly RunRecord[], automationId: string): AutomationWork {
  const roots = new Set(runs.filter((run) => launchingAutomationId(run) === automationId).map((run) => run.id));
  const queued: AutomationWorkRun[] = [];
  const active: AutomationWorkRun[] = [];
  for (const run of runs) {
    if (!roots.has(rootIdOf(run))) continue;
    const entry: AutomationWorkRun = { id: run.id, title: run.title, status: run.status, ...(run.id === rootIdOf(run) ? {} : { rootRunId: rootIdOf(run) }) };
    if (run.status === 'queued') queued.push({ ...entry, kind: isContinuation(run) ? 'continuation' : 'never-started' });
    else if (run.status === 'running' || run.status === 'waiting') active.push(entry);
  }
  return { queued, active };
}

/** Does any descendant of `runId` still run or wait? Cancelling a run cancels its subtree, so a
 *  queued parent with live children is left for an explicit tree cancel in Tasks. */
function hasActiveDescendant(runs: readonly RunRecord[], runId: string): boolean {
  const children = runs.filter((run) => run.dispatch?.parentRunId === runId);
  return children.some((child) => child.status === 'running' || child.status === 'waiting' || hasActiveDescendant(runs, child.id));
}

/** The queued work `cancel-queued` may stop without touching active work, and what it keeps. */
export function queuedToCancel(runs: readonly RunRecord[], automationId: string): { cancel: string[]; keep: string[] } {
  const cancel: string[] = [];
  const keep: string[] = [];
  for (const run of automationWork(runs, automationId).queued) (hasActiveDescendant(runs, run.id) ? keep : cancel).push(run.id);
  return { cancel, keep };
}

/** Why an agent under this run may not dispatch, or `undefined`. Read live on every dispatch,
 *  so re-enabling the automation lifts it and a restart cannot lose it. */
export function pausedAutomationHold(
  runs: readonly RunRecord[],
  run: RunRecord,
  isPaused: (automationId: string) => boolean,
): string | undefined {
  const root = runs.find((candidate) => candidate.id === rootIdOf(run)) ?? run;
  const automationId = launchingAutomationId(root);
  if (!automationId || !isPaused(automationId)) return undefined;
  return 'the automation that launched this task tree is paused, so it may not start new tasks. Do not substitute sub-agents or do the delegated work yourself: finish with what exists and report.';
}
