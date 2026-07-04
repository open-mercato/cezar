import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActionDef, ActionTarget, ActionTrigger, EffectName } from '@cezar/core';
import type { Database } from './supabase/types';

/**
 * Shared `actions` / target-row → core-type mappers, used by both the cron
 * action executor (`execute-action-job.ts`) and the runner claim route
 * (`api/runner/jobs/route.ts`) so the two surfaces never drift. The column
 * lists are exported alongside the mappers so callers select exactly what the
 * mapper reads.
 */

export const ACTION_ROW_COLUMNS =
  'id, name, kind, description, system_prompt, skill_refs, context_refs, target, triggers, effects, output_schema, enabled, effect_routing, suggested_flow_id';

export const ISSUE_TARGET_COLUMNS = 'number, title, body, state, labels, html_url, comments';
export const PR_TARGET_COLUMNS = 'number, title, body, state, labels, html_url';

/** The subset of an `actions` row {@link ACTION_ROW_COLUMNS} selects. */
export interface ActionRowLike {
  id: string;
  name: string;
  kind: string;
  description: string;
  system_prompt: string;
  skill_refs: unknown;
  context_refs: unknown;
  target: string;
  triggers: unknown;
  effects: unknown;
  output_schema: unknown;
  enabled: boolean;
  effect_routing: unknown;
  suggested_flow_id: unknown;
}

/** The subset of an `issues` / `pull_requests` row the target mappers read. */
export interface TargetRowLike {
  number: number;
  title: string | null;
  body: string | null;
  state: string | null;
  labels: string[] | null;
  html_url: string | null;
  comments?: unknown;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string') : [];
}

/** Map an `actions` row onto a core {@link ActionDef}. */
export function mapActionRow(workspaceId: string, row: ActionRowLike): ActionDef {
  return {
    id: row.id,
    workspaceId,
    name: row.name,
    kind: row.kind as 'built-in' | 'user',
    description: row.description,
    systemPrompt: row.system_prompt,
    skillRefs: stringArray(row.skill_refs),
    contextRefs: stringArray(row.context_refs),
    target: row.target as 'issue' | 'pr',
    triggers: stringArray(row.triggers) as ActionTrigger[],
    effects: row.effects == null ? null : (stringArray(row.effects) as EffectName[]),
    outputSchema:
      row.output_schema &&
      typeof row.output_schema === 'object' &&
      !Array.isArray(row.output_schema)
        ? (row.output_schema as Record<string, unknown>)
        : null,
    enabled: row.enabled,
    effectRouting: parseEffectRouting(row.effect_routing),
    suggestedFlowId: typeof row.suggested_flow_id === 'string' ? row.suggested_flow_id : null,
  };
}

/**
 * Map an issue/PR row onto a core {@link ActionTarget}. Issues carry a cached
 * comments array (flattened to a short text block); PRs don't.
 */
export function mapTargetRow(kind: 'issue' | 'pr', row: TargetRowLike): ActionTarget {
  const labels = Array.isArray(row.labels)
    ? row.labels.filter((l): l is string => typeof l === 'string')
    : [];
  const commentsArr = Array.isArray(row.comments) ? row.comments : [];
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

  return {
    kind,
    number: row.number,
    title: row.title ?? '',
    body: row.body ?? '',
    state: row.state ?? 'open',
    labels,
    htmlUrl: row.html_url ?? '',
    comments: commentsText,
  };
}

/**
 * Defensive map of the `effect_routing` jsonb column onto
 * `ActionDef.effectRouting` — keeps only entries with a valid routing mode.
 */
export function parseEffectRouting(value: unknown): ActionDef['effectRouting'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: NonNullable<ActionDef['effectRouting']> = {};
  let any = false;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === 'auto' || v === 'always-defer') {
      out[k as EffectName] = v;
      any = true;
    }
  }
  return any ? out : undefined;
}

export interface PendingDecisionInput {
  workspaceId: string;
  actionId: string;
  runId: string;
  targetKind: 'issue' | 'pr';
  targetNumber: number;
  targetTitle: string;
  effect: string;
  effectArgs: unknown;
  summary: string;
  confidence: number;
}

/**
 * Insert one human-review row into `pending_decisions`. Shared by the cron
 * action deferSink (`execute-action-job.ts`) and the runner finalize route
 * (which replays deferred effects a self-hosted run streamed back). A 23505
 * unique-violation against the dedup index is the intended "already pending"
 * no-op, swallowed here; other errors are surfaced to the caller's logger.
 */
export async function insertPendingDecision(
  supabase: SupabaseClient<Database>,
  input: PendingDecisionInput,
): Promise<{ error?: string }> {
  const { error } = await supabase.from('pending_decisions').insert({
    workspace_id: input.workspaceId,
    action_id: input.actionId,
    workflow_run_id: input.runId,
    target_kind: input.targetKind,
    issue_number: input.targetKind === 'issue' ? input.targetNumber : null,
    pr_number: input.targetKind === 'pr' ? input.targetNumber : null,
    target_title: input.targetTitle,
    effect: input.effect,
    effect_args: (input.effectArgs ??
      {}) as Database['public']['Tables']['pending_decisions']['Insert']['effect_args'],
    summary: input.summary,
    confidence: input.confidence,
  });
  if (error && error.code !== '23505') return { error: error.message };
  return {};
}
