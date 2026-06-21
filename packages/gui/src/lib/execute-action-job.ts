import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadWorkspaceConfig } from './load-workspace-config';
import { buildOpenIssuesContextProviders } from './open-issues-context';
import { createWorkflowRunPersister } from './persist-workflow-run';
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
      .select(
        'id, name, kind, description, system_prompt, skill_refs, context_refs, target, triggers, effects, output_schema, enabled, effect_routing, suggested_flow_id',
      )
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
        .select('number, title, body, state, labels, html_url')
        .eq('workspace_id', workspaceId)
        .eq('number', number)
        .maybeSingle();
      targetRow = data;
      if (!targetRow) throw new Error(`PR #${number} not in the workspace's PR store`);
    } else {
      const { data } = await supabase
        .from('issues')
        .select('number, title, body, state, labels, html_url, comments')
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

    // Build an ActionTarget mirroring run-triage-pass-job.ts. Issues carry a
    // cached comments array; PRs don't (pull_requests has no comments column).
    const labels = Array.isArray(targetRow.labels)
      ? targetRow.labels.filter((l): l is string => typeof l === 'string')
      : [];
    const commentsArr = Array.isArray(targetRow.comments) ? targetRow.comments : [];
    type CommentLike = { author?: unknown; createdAt?: unknown; body?: unknown };
    const commentsText =
      commentsArr.length > 0
        ? commentsArr
            .map((c) => {
              const co = c as CommentLike;
              const author = typeof co.author === 'string' ? co.author : 'unknown';
              const createdAt = typeof co.createdAt === 'string' ? co.createdAt : '';
              const body = typeof co.body === 'string' ? co.body : '';
              return `- ${author} (${createdAt}): ${body.slice(0, 500)}`;
            })
            .join('\n')
        : undefined;

    const target: import('@cezar/core').ActionTarget = {
      kind: actionRow.target,
      number: targetRow.number,
      title: targetRow.title ?? '',
      body: targetRow.body ?? '',
      state: targetRow.state ?? 'open',
      labels,
      htmlUrl: targetRow.html_url ?? '',
      comments: commentsText,
    };

    const action: import('@cezar/core').ActionDef = {
      id: actionRow.id,
      workspaceId,
      name: actionRow.name,
      kind: actionRow.kind as 'built-in' | 'user',
      description: actionRow.description,
      systemPrompt: actionRow.system_prompt,
      skillRefs: Array.isArray(actionRow.skill_refs)
        ? (actionRow.skill_refs as unknown[]).filter((s): s is string => typeof s === 'string')
        : [],
      contextRefs: Array.isArray(actionRow.context_refs)
        ? (actionRow.context_refs as unknown[]).filter((s): s is string => typeof s === 'string')
        : [],
      target: actionRow.target as 'issue' | 'pr',
      triggers: Array.isArray(actionRow.triggers)
        ? ((actionRow.triggers as unknown[]).filter(
            (s): s is string => typeof s === 'string',
          ) as import('@cezar/core').ActionTrigger[])
        : [],
      effects:
        actionRow.effects == null
          ? null
          : Array.isArray(actionRow.effects)
            ? ((actionRow.effects as unknown[]).filter(
                (s): s is string => typeof s === 'string',
              ) as import('@cezar/core').EffectName[])
            : null,
      outputSchema:
        actionRow.output_schema &&
        typeof actionRow.output_schema === 'object' &&
        !Array.isArray(actionRow.output_schema)
          ? (actionRow.output_schema as Record<string, unknown>)
          : null,
      enabled: actionRow.enabled,
      effectRouting: parseEffectRouting(actionRow.effect_routing),
      suggestedFlowId:
        typeof actionRow.suggested_flow_id === 'string' ? actionRow.suggested_flow_id : null,
    };

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
          const { error } = await supabase.from('pending_decisions').insert({
            workspace_id: workspaceId,
            action_id: action.id,
            workflow_run_id: runId,
            target_kind: target.kind,
            issue_number: target.kind === 'issue' ? target.number : null,
            pr_number: target.kind === 'pr' ? target.number : null,
            target_title: target.title,
            effect: call.effect,
            effect_args: (call.args ??
              {}) as Database['public']['Tables']['pending_decisions']['Insert']['effect_args'],
            summary,
            confidence,
          });
          // 23505 = unique_violation against the pending-decisions dedup
          // index: a pending decision for this (action, target, effect, args)
          // already exists — intended dedup behaviour, not a failure.
          if (error && error.code !== '23505') {
            console.error('[action-job] pending_decisions insert failed:', error.message);
          }
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
 * Defensive map of the `effect_routing` jsonb column onto
 * `ActionDef.effectRouting` — keeps only entries with a valid routing mode.
 */
function parseEffectRouting(value: unknown): import('@cezar/core').ActionDef['effectRouting'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: NonNullable<import('@cezar/core').ActionDef['effectRouting']> = {};
  let any = false;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === 'auto' || v === 'always-defer') {
      out[k as import('@cezar/core').EffectName] = v;
      any = true;
    }
  }
  return any ? out : undefined;
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
