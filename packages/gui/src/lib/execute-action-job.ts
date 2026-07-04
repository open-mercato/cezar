import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadWorkspaceConfig } from './load-workspace-config';
import { buildOpenIssuesContextProviders } from './open-issues-context';
import { createWorkflowRunPersister } from './persist-workflow-run';
import {
  ACTION_ROW_COLUMNS,
  ISSUE_TARGET_COLUMNS,
  PR_TARGET_COLUMNS,
  mapActionRow,
  mapTargetRow,
  insertPendingDecision,
} from './map-action-row';
import type { Database } from './supabase/types';

export interface ExecuteActionJobParams {
  workspaceId: string;
  /** The `jobs` row id this run drains — finalized at the end. */
  jobId: string;
  /** The pre-created `workflow_runs` row (status `queued`) to bind to and run. */
  runId: string;
  /** The `actions.id` to run. */
  actionId: string;
  /** The issue/PR number the action targets. */
  number: number;
}

/**
 * Background executor for a queued manual `action` job. Mirrors the synchronous
 * "run now" path that used to live in `run-now-action.ts`, but runs in the
 * dispatch worker (no session user) and binds to the `workflow_runs` row
 * `enqueueActionRun` created up front.
 *
 * Reads the action + target fresh, resolves a GitHub token the same way the
 * workflow executor does (App install token → any workspace admin's stored
 * token → ambient GITHUB_TOKEN), runs `core.runAction`, persists the agent run
 * and per-effect events, finalizes the run, and closes the job. Never rethrows
 * — a failure marks both the run and the job failed.
 */
export async function executeActionJob(
  supabase: SupabaseClient<Database>,
  params: ExecuteActionJobParams,
): Promise<void> {
  const { workspaceId, jobId, runId, actionId, number } = params;

  const finishJob = async (
    status: Database['public']['Tables']['jobs']['Row']['status'],
  ): Promise<void> => {
    await supabase
      .from('jobs')
      .update({ status, claim_expires_at: null, updated_at: new Date().toISOString() })
      .eq('id', jobId);
  };

  // Bind the persister to the pre-created run row up front so any early failure
  // below still marks the run (not just the job) failed in the cockpit.
  const persister = await createWorkflowRunPersister(supabase, {
    workspaceId,
    jobId,
    existingRunId: runId,
    workflow: 'single-action',
    repo: null,
    issueNumber: null,
    onPersistError: (label, err) =>
      console.error(
        `[action-job] persist ${label} failed:`,
        err instanceof Error ? err.message : err,
      ),
  });

  try {
    const core = await import('@cezar/core');

    const { data: actionRow } = await supabase
      .from('actions')
      .select(ACTION_ROW_COLUMNS)
      .eq('id', actionId)
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    if (!actionRow) throw new Error(`action ${actionId} not found`);

    const { data: workspaceRow } = await supabase
      .from('workspaces')
      .select(
        'config, repo_owner, repo_name, auto_triage_enabled, autofix_enabled, separate_comment_per_step, action_auto_comment',
      )
      .eq('id', workspaceId)
      .single();
    const autoCommentEnabled = workspaceRow?.action_auto_comment ?? true;

    const isPr = actionRow.target === 'pr';

    // Issues live in `issues` (with cached comments), PRs in `pull_requests`.
    type TargetRow = {
      number: number;
      title: string | null;
      body: string | null;
      state: string | null;
      labels: string[] | null;
      html_url: string | null;
      comments?: unknown;
    };
    let targetRow: TargetRow | null = null;
    if (isPr) {
      const { data } = await supabase
        .from('pull_requests')
        .select(PR_TARGET_COLUMNS)
        .eq('workspace_id', workspaceId)
        .eq('number', number)
        .maybeSingle();
      targetRow = data;
      if (!targetRow) throw new Error(`PR #${number} not in the workspace's PR store`);
    } else {
      const { data } = await supabase
        .from('issues')
        .select(ISSUE_TARGET_COLUMNS)
        .eq('workspace_id', workspaceId)
        .eq('number', number)
        .maybeSingle();
      targetRow = data;
      if (!targetRow) throw new Error(`issue #${number} not in the workspace's issue store`);
    }

    // GitHub token: App install token → any workspace admin's stored token →
    // ambient GITHUB_TOKEN. Mirrors execute-workflow-job.ts (no session user
    // available in the dispatch context).
    let githubToken: string | null = null;
    const owner = workspaceRow?.repo_owner ?? undefined;
    if (owner && core.GitHubAppService.isConfigured()) {
      try {
        githubToken = await new core.GitHubAppService().getInstallationToken(owner);
      } catch (err) {
        console.error(
          `[action-job] installation token failed for ${owner}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    if (!githubToken) githubToken = await resolveWorkspaceToken(workspaceId, supabase);
    if (!githubToken) throw new Error('no github token available for workspace');

    const config = await loadWorkspaceConfig(workspaceId, supabase, {
      githubToken,
      prefetchedWorkspace: workspaceRow,
    });
    const github = new core.GitHubService(config);

    await persister.recordEvent('lifecycle', {
      message: `run-now: ${actionRow.name} on ${isPr ? 'PR' : 'issue'} #${number} (manual)`,
    });

    // Build the core ActionDef + ActionTarget via the shared mappers (also used
    // by the runner claim route) so the two surfaces never drift.
    const target = mapTargetRow(actionRow.target as 'issue' | 'pr', targetRow);
    const action = mapActionRow(workspaceId, actionRow);

    const startedAt = new Date().toISOString();
    let runStatus: 'succeeded' | 'failed' = 'succeeded';
    let reason: string | undefined;
    let tokensUsed = 0;
    let summary: string | undefined;
    let runError: string | undefined;
    let effectsApplied: Array<{ call: import('@cezar/core').EffectCall; summary: string }> = [];

    try {
      const skills = await core.discoverBuiltinSkills();
      const result = await core.runAction(action, target, {
        skills,
        effectCtx: { github, targetNumber: number, supabase, workspaceId },
        autoComment: { enabled: autoCommentEnabled, triggeredBy: 'manual · run now' },
        // Always passed — the runner only invokes providers for refs the
        // action declares via `contextRefs`. For PR targets the `open-issues`
        // provider still returns issues, which is what dedupe-style actions want.
        contextProviders: buildOpenIssuesContextProviders(supabase, workspaceId, number),
        // Mirror the triage path's deferSink (execute-workflow-job.ts):
        // without it, always-defer effects (workflow suggestions) and
        // mid-confidence HITL effects from a manual "run now" are silently
        // dropped instead of landing in the inbox. Each deferral is also
        // surfaced as a 'tool-call' event via the effectsApplied loop below,
        // same as the triage path.
        deferSink: async ({ call, confidence, summary }) => {
          const { error } = await insertPendingDecision(supabase, {
            workspaceId,
            actionId: action.id,
            runId,
            targetKind: target.kind,
            targetNumber: target.number,
            targetTitle: target.title,
            effect: call.effect,
            effectArgs: call.args,
            summary,
            confidence,
          });
          if (error) console.error('[action-job] pending_decisions insert failed:', error);
        },
      });
      summary = result.text?.slice(0, 500);
      effectsApplied = result.effectsApplied;
      tokensUsed = result.usage.inputTokens + result.usage.outputTokens;
    } catch (err) {
      runStatus = 'failed';
      runError = err instanceof Error ? err.message : String(err);
      reason = runError;
    }

    const finishedAt = new Date().toISOString();
    const record: import('@cezar/core').AgentRunRecord = {
      id: randomUUID(),
      workflow: 'single-action',
      stepId: action.name,
      kind: 'agent',
      iteration: 0,
      backend: 'anthropic-api',
      model: 'claude-sonnet-4-6',
      status: runStatus,
      startedAt,
      finishedAt,
      tokensUsed,
      summary,
      error: runError,
    };
    await persister.recordAgentRun(record);

    for (const e of effectsApplied) {
      await persister.recordEvent('tool-call', {
        action: action.name,
        effect: e.call.effect,
        args: e.call.args,
        summary: e.summary,
      });
    }

    await persister.recordEvent('lifecycle', {
      message:
        runStatus === 'succeeded'
          ? `run-now: ${action.name} succeeded (${effectsApplied.length} effect${effectsApplied.length === 1 ? '' : 's'})`
          : `run-now: ${action.name} failed: ${runError ?? 'unknown error'}`,
    });

    await persister.finalize({
      status: runStatus,
      reason: reason ?? null,
      tokens_used: tokensUsed,
      finished_at: finishedAt,
      outcome: {
        action: action.name,
        effectsApplied: effectsApplied.map((e) => ({
          effect: e.call.effect,
          args: e.call.args as never,
          summary: e.summary,
        })),
      } as never,
    });
    await finishJob(runStatus === 'succeeded' ? 'done' : 'failed');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[action-job] executeActionJob failed:', message);
    await persister.fail(message).catch(() => {});
    await finishJob('failed').catch(() => {});
  }
}

/**
 * Mirrors execute-workflow-job.ts: grab any workspace admin's stored GitHub
 * token, else fall back to the ambient `GITHUB_TOKEN` env var.
 */
async function resolveWorkspaceToken(
  workspaceId: string,
  supabase: SupabaseClient<Database>,
): Promise<string | null> {
  const { data: admins } = await supabase
    .from('workspace_members')
    .select('user_id')
    .eq('workspace_id', workspaceId)
    .eq('role', 'admin');
  if (admins && admins.length > 0) {
    const ids = admins.map((a) => a.user_id);
    const { data: tokens } = await supabase
      .from('user_github_tokens')
      .select('provider_token')
      .in('user_id', ids)
      .limit(1);
    const token = tokens?.[0]?.provider_token;
    if (token) return token;
  }
  return process.env.GITHUB_TOKEN || null;
}
