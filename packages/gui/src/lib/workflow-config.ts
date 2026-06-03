import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkflowBinding, WorkspaceWorkflowSettings } from '@cezar/core';
import { DEFAULT_WORKSPACE_WORKFLOW_SETTINGS } from '@cezar/core';
import type { Database, WorkflowBackend } from './supabase/types';

const VALID_BACKENDS: WorkflowBackend[] = ['anthropic-api', 'claude-cli', 'codex-cli'];

/**
 * The subset of `workspaces` columns the workflow loaders read. When a caller
 * has already fetched the row (e.g. `executeWorkflowJob`), it can thread it
 * down so the loaders skip a redundant `SELECT … FROM workspaces`.
 */
export type WorkspaceWorkflowRow = Pick<
  Database['public']['Tables']['workspaces']['Row'],
  'auto_triage_enabled' | 'autofix_enabled' | 'separate_comment_per_step'
>;

/**
 * Loads the workspace's `workflow_bindings` rows (for this repo, plus the
 * repo-agnostic null-repo rows) as core `WorkflowBinding`s. Rows that set
 * nothing (skill/backend/model all null AND extra_tools empty) are dropped —
 * an empty binding is identical to "no binding", so it shouldn't shadow the
 * built-in default. The core orchestrator (Phase 1a) consumes these.
 */
export async function loadWorkflowBindings(
  workspaceId: string,
  supabase: SupabaseClient<Database>,
  repo?: string,
): Promise<WorkflowBinding[]> {
  let query = supabase
    .from('workflow_bindings')
    .select('repo, step_id, skill_name, backend, model, extra_tools')
    .eq('workspace_id', workspaceId);

  // null repo = applies to all repos; or an exact repo match.
  query = repo ? query.or(`repo.is.null,repo.eq.${repo}`) : query.is('repo', null);

  const { data, error } = await query;
  if (error || !data) return [];

  const bindings: WorkflowBinding[] = [];
  for (const row of data) {
    const extraTools = Array.isArray(row.extra_tools)
      ? (row.extra_tools as unknown[]).filter((t): t is string => typeof t === 'string')
      : [];
    const backend =
      typeof row.backend === 'string' && (VALID_BACKENDS as string[]).includes(row.backend)
        ? (row.backend as WorkflowBackend)
        : null;
    const skillName = row.skill_name ?? null;
    const model = row.model ?? null;
    // "use default" — nothing set: no row needed.
    if (!skillName && !backend && !model && extraTools.length === 0) continue;
    bindings.push({ stepId: row.step_id, skillName, backend, model, extraTools });
  }
  return bindings;
}

/**
 * Reads the three workflow toggle columns off the `workspaces` row, defaulting
 * via core. Pass `prefetched` to reuse an already-loaded row and skip the
 * `SELECT`.
 */
export async function loadWorkflowSettings(
  workspaceId: string,
  supabase: SupabaseClient<Database>,
  prefetched?: WorkspaceWorkflowRow | null,
): Promise<WorkspaceWorkflowSettings> {
  let data: WorkspaceWorkflowRow | null;
  if (prefetched !== undefined) {
    data = prefetched;
  } else {
    ({ data } = await supabase
      .from('workspaces')
      .select('auto_triage_enabled, autofix_enabled, separate_comment_per_step')
      .eq('id', workspaceId)
      .single());
  }

  if (!data) return { ...DEFAULT_WORKSPACE_WORKFLOW_SETTINGS };
  return {
    autoTriageEnabled: data.auto_triage_enabled ?? DEFAULT_WORKSPACE_WORKFLOW_SETTINGS.autoTriageEnabled,
    autofixEnabled: data.autofix_enabled ?? DEFAULT_WORKSPACE_WORKFLOW_SETTINGS.autofixEnabled,
    separateCommentPerStep:
      data.separate_comment_per_step ?? DEFAULT_WORKSPACE_WORKFLOW_SETTINGS.separateCommentPerStep,
  };
}
