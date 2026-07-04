import { cn } from '@/components/ui/cn';
import type { DbWorkflowRunStatus, AgentRunStatus } from '@/lib/supabase/types';

/** Colored badge for a workflow_runs.status. */
export function RunStatusBadge({
  status,
  className,
}: {
  status: DbWorkflowRunStatus;
  className?: string;
}) {
  const colors: Record<DbWorkflowRunStatus, string> = {
    queued: 'bg-fg-subtle/15 text-fg-subtle',
    running: 'bg-blue-500/20 text-blue-400',
    paused: 'bg-amber-500/20 text-amber-400',
    succeeded: 'bg-accent/20 text-accent',
    failed: 'bg-danger/20 text-danger',
    cancelled: 'bg-fg-subtle/20 text-fg-subtle',
  };
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-xs font-medium uppercase',
        colors[status],
        className,
      )}
    >
      {status}
    </span>
  );
}

/** Colored badge for an agent_runs.status (per-step). */
export function StepStatusBadge({
  status,
  className,
}: {
  status: AgentRunStatus;
  className?: string;
}) {
  const colors: Record<AgentRunStatus, string> = {
    running: 'bg-blue-500/20 text-blue-400',
    succeeded: 'bg-accent/20 text-accent',
    failed: 'bg-danger/20 text-danger',
    skipped: 'bg-fg-subtle/20 text-fg-subtle',
  };
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-xs font-medium uppercase',
        colors[status],
        className,
      )}
    >
      {status}
    </span>
  );
}

export function isTerminalRunStatus(status: DbWorkflowRunStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

/** Friendly labels for step ids (autofix pipeline + triage + effect steps). */
export const STEP_LABELS: Record<string, string> = {
  // Autofix pipeline
  'verify-in-repo': 'Verify in repo',
  'confirm-fix': 'Confirm fix',
  'root-cause': 'Root-cause analysis',
  fix: 'Implement fix',
  commit: 'Commit',
  review: 'Review the fix',
  'open-pr': 'Open PR',
  push: 'Push',
  // Triage steps
  'bug-detector': 'Bug detector',
  priority: 'Priority',
  categorize: 'Categorize',
  security: 'Security',
  quality: 'Quality',
  'good-first-issue': 'Good first issue',
  'missing-info': 'Missing info',
  'claim-detector': 'Claim detector',
  'contributor-welcome': 'Contributor welcome',
  'recurring-questions': 'Recurring questions',
  duplicates: 'Duplicates',
  stale: 'Stale issues',
  'done-detector': 'Done detector',
  'auto-label': 'Auto-label',
};

export function stepLabel(stepId: string | null | undefined): string {
  if (!stepId) return '—';
  return STEP_LABELS[stepId] ?? stepId;
}

/**
 * Build a GitHub URL for a run row. Prefers an explicit pr_url; otherwise
 * constructs from owner/name + pr_number/issue_number.
 */
export function githubUrlForRun(
  run: { pr_url: string | null; pr_number: number | null; issue_number: number | null },
  repoOwner: string,
  repoName: string,
): string | null {
  if (run.pr_url) return run.pr_url;
  if (run.pr_number != null)
    return `https://github.com/${repoOwner}/${repoName}/pull/${run.pr_number}`;
  if (run.issue_number != null)
    return `https://github.com/${repoOwner}/${repoName}/issues/${run.issue_number}`;
  return null;
}

export function runRefLabel(run: {
  pr_number: number | null;
  issue_number: number | null;
}): string {
  if (run.pr_number != null) return `PR #${run.pr_number}`;
  if (run.issue_number != null) return `Issue #${run.issue_number}`;
  return '—';
}
