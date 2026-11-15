import type { RunRecord } from './store.ts';

/** Allowlisted task state for synchronous observers; never includes a prompt or transcript. */
export function runLifecycleSnapshot(run: RunRecord) {
  return structuredClone({
    id: run.id, status: run.status, archived: run.archived,
    // Keep complete values until the observer can redact its own known secrets.
    title: run.title, titleOrigin: run.titleOrigin,
    attentionRequest: run.attentionRequest, completionReason: run.completionReason,
    autoResumeAt: run.autoResumeAt, finishedAt: run.finishedAt, startedAt: run.startedAt,
    parentTaskId: run.dispatch?.parentRunId, rootTaskId: run.dispatch?.rootRunId,
    continuation: run.steps.reduce((latest, step) => {
      const match = /^continue-(\d+)$/.exec(step.id);
      return match ? Math.max(latest, Number(match[1])) : latest;
    }, 0),
    error: run.error,
    pullRequestUrl: run.pullRequestUrl, referencedPullRequestUrl: run.referencedPullRequestUrl,
    referencedIssueUrl: run.referencedIssueUrl,
    automationUrl: run.automation?.githubUrl,
    automationTracker: run.automationTracker ? { provider: run.automationTracker.provider, ...(run.automationTracker.association ? { association: run.automationTracker.association } : {}), key: run.automationTracker.key, url: run.automationTracker.url } : undefined,
    inputTokens: Number.isSafeInteger(run.inputTokens) && run.inputTokens! >= 0 ? run.inputTokens : undefined,
    outputTokens: Number.isSafeInteger(run.outputTokens) && run.outputTokens! >= 0 ? run.outputTokens : undefined,
    costUsd: Number.isFinite(run.costUsd) && run.costUsd! >= 0 ? run.costUsd : undefined,
  });
}
type Snapshot = ReturnType<typeof runLifecycleSnapshot>;
export type RunLifecycleSnapshot = Pick<Snapshot, 'id' | 'status' | 'archived' | 'continuation'> & Partial<Omit<Snapshot, 'id' | 'status' | 'archived' | 'continuation'>>;
export type RunLifecycleCause = 'change' | 'delete' | 'reconcile';
export type RunLifecycleObserver = (before: RunLifecycleSnapshot | undefined, after: RunLifecycleSnapshot | undefined, cause: RunLifecycleCause) => void;
