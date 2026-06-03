import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ActionTarget,
  AgentRunRecord,
  GitHubService,
  TriagePassActionResult,
  TriagePassDeferSink,
  WorkspaceLabel,
} from '@cezar/core';
import type { WorkflowRunPersister } from './persist-workflow-run';
import type { Database } from './supabase/types';

export interface RunTriagePassJobParams {
  workspaceId: string;
  issueNumber: number;
  github: GitHubService;
  supabase: SupabaseClient<Database>;
  persister: WorkflowRunPersister;
  /** Free-form label describing what initiated the pass (e.g. `'on-issue-opened'`). */
  trigger?: string;
  /** Optional sink — receives effects deferred to human review. When omitted
   *  the runner drops them. */
  deferSink?: TriagePassDeferSink;
  /** Workspace label catalog appended to each action's system message. */
  labels?: WorkspaceLabel[];
}

export interface RunTriagePassJobResult {
  status: 'succeeded' | 'failed';
  reason?: string;
  tokensUsed: number;
  outcome: {
    results: Array<{
      actionName: string;
      ok: boolean;
      error?: string;
      effectsApplied: TriagePassActionResult['effectsApplied'];
    }>;
  };
}

/**
 * Soft-cutover triage executor — replaces `runWorkflow(triageWorkflow, …)` for
 * jobs of kind `'triage'`. Fetches the live issue, builds an `ActionTarget`,
 * then runs the data-driven `runTriagePass` and streams results into the
 * existing `workflow_runs` / `agent_runs` / `agent_run_events` tables so the
 * cockpit UI keeps working untouched.
 *
 * One `workflow_runs` row already exists (created by the caller before this
 * function runs); we record one `agent_runs` row per action invocation and one
 * `agent_run_events` row per effect that fired plus a final lifecycle event.
 */
export async function runTriagePassJob(params: RunTriagePassJobParams): Promise<RunTriagePassJobResult> {
  const core = await import('@cezar/core');
  const { issueNumber, github, supabase, persister, workspaceId, trigger, deferSink, labels } = params;

  const { data: workspaceRow } = await supabase
    .from('workspaces')
    .select('action_auto_comment')
    .eq('id', workspaceId)
    .single();
  const autoCommentEnabled = workspaceRow?.action_auto_comment ?? true;

  await persister.recordEvent('lifecycle', { message: `triage-pass: fetching issue #${issueNumber}` });
  const fetched = await github.getIssueWithComments(issueNumber);
  const target: ActionTarget = {
    kind: 'issue',
    number: fetched.issue.number,
    title: fetched.issue.title,
    body: fetched.issue.body,
    state: fetched.issue.state,
    labels: fetched.issue.labels,
    htmlUrl: fetched.issue.htmlUrl,
    comments:
      fetched.comments.length > 0
        ? fetched.comments
            .map((c) => `- ${c.author} (${c.createdAt}): ${c.body.slice(0, 500)}`)
            .join('\n')
        : undefined,
  };

  let pass: Awaited<ReturnType<typeof core.runTriagePass>>;
  try {
    pass = await core.runTriagePass({
      workspaceId,
      issueNumber,
      target,
      supabase,
      github,
      trigger: 'on-issue-opened',
      autoComment: {
        enabled: autoCommentEnabled,
        triggeredBy: `cron · ${trigger ?? 'on-issue-opened'}`,
      },
      deferSink,
      labels,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await persister.recordEvent('lifecycle', { message: `triage-pass failed: ${message}` });
    return {
      status: 'failed',
      reason: message,
      tokensUsed: 0,
      outcome: { results: [] },
    };
  }

  const startedAt = new Date().toISOString();
  for (const r of pass.results) {
    const finishedAt = new Date().toISOString();
    const record: AgentRunRecord = {
      id: randomUUID(),
      workflow: 'triage',
      stepId: r.actionName,
      kind: 'agent',
      iteration: 0,
      backend: 'anthropic-api',
      model: 'claude-sonnet-4-6',
      status: r.ok ? 'succeeded' : 'failed',
      startedAt,
      finishedAt,
      tokensUsed: 0,
      summary: r.ok ? r.text.slice(0, 500) : undefined,
      error: r.error,
    };
    await persister.recordAgentRun(record);

    for (const e of r.effectsApplied) {
      await persister.recordEvent('tool-call', {
        action: r.actionName,
        effect: e.call.effect,
        args: e.call.args,
        summary: e.summary,
      });
    }
  }

  await persister.recordEvent('lifecycle', {
    message: `triage-pass: ran ${pass.results.length} actions (${pass.results.filter((r) => r.ok).length} ok)`,
  });

  const failed = pass.results.filter((r) => !r.ok);
  // `workflow_runs.status` is binary (`succeeded` | `failed`), so a partial
  // failure stays `succeeded` but carries a non-null `reason`; only an
  // all-actions-failed run is recorded as `failed`. Surface the failed action
  // names in a lifecycle event so the cockpit drill-down can show them.
  const allFailed = pass.results.length > 0 && failed.length === pass.results.length;
  if (failed.length > 0) {
    await persister.recordEvent('lifecycle', {
      message: `triage-pass: ${failed.length}/${pass.results.length} actions failed (${failed
        .map((r) => r.actionName)
        .join(', ')})`,
    });
  }
  return {
    status: allFailed ? 'failed' : 'succeeded',
    reason: failed.length > 0 ? `${failed.length}/${pass.results.length} triage actions failed` : undefined,
    tokensUsed: pass.totalUsage.inputTokens + pass.totalUsage.outputTokens,
    outcome: {
      results: pass.results.map((r) => ({
        actionName: r.actionName,
        ok: r.ok,
        error: r.error,
        effectsApplied: r.effectsApplied,
      })),
    },
  };
}
