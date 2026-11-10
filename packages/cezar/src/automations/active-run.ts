import type { RunRecord, RunStore } from '../runs/store.ts';

/** #1801: `review` and terminal states count as finished, so a forgotten review gate never blocks. */
const ACTIVE_STATUSES: ReadonlySet<RunRecord['status']> = new Set(['queued', 'running', 'waiting']);

export interface ActiveAutomationRun {
  id: string;
  status: RunRecord['status'];
}

/** A previous run of `waitForPrevious` automation, if one is still active; `undefined` = free. */
export type ActiveAutomationRunLookup = (automationId: string) => Promise<ActiveAutomationRun | undefined>;

/**
 * Matches on the automation id (any revision, any variant). Persisted runs cover a second cockpit's
 * launches; a live record wins over its persisted copy.
 */
export function findActiveAutomationRun(
  store: Pick<RunStore, 'listRuns' | 'listPersistedRuns'>,
  automationId: string,
): ActiveAutomationRun | undefined {
  const live = store.listRuns();
  const liveIds = new Set(live.map((run) => run.id));
  let persisted: RunRecord[] = [];
  try {
    persisted = store.listPersistedRuns().filter((run) => !liveIds.has(run.id));
  } catch {
    // An unreadable runs.json still leaves this process's own runs to answer.
  }
  for (const run of [...live, ...persisted]) {
    const owner = run.automation?.automationId ?? run.automationTrigger?.automationId ?? run.automationTracker?.automationId;
    if (owner === automationId && ACTIVE_STATUSES.has(run.status)) return { id: run.id, status: run.status };
  }
  return undefined;
}

export function waitingForPreviousReason(run: ActiveAutomationRun): string {
  return `Waiting for the previous execution: run ${run.id} is still ${run.status}.`;
}
