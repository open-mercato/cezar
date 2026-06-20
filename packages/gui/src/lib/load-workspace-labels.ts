import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkspaceLabel } from '@cezar/core';
import type { Database } from './supabase/types';

/**
 * Load the workspace's accepted label catalog (`workspace_labels`) for the
 * workflow engine + triage runner to inject into agent system prompts.
 *
 * Returns an empty array — never throws — so a labels-table glitch never
 * fails a workflow run. The engine treats an empty catalog as "no labels"
 * and skips the prompt section entirely.
 */
export async function loadWorkspaceLabels(
  supabase: SupabaseClient<Database>,
  workspaceId: string,
): Promise<WorkspaceLabel[]> {
  const { data, error } = await supabase
    .from('workspace_labels')
    .select(
      'name, scope, color, description, when_to_add, when_to_remove, add_meaning, remove_meaning',
    )
    .eq('workspace_id', workspaceId);
  if (error) {
    console.error('[labels] loadWorkspaceLabels failed:', error.message);
    return [];
  }
  return (data ?? []).map((row) => ({
    name: row.name,
    scope: row.scope,
    color: row.color,
    description: row.description,
    when_to_add: row.when_to_add,
    when_to_remove: row.when_to_remove,
    add_meaning: row.add_meaning,
    remove_meaning: row.remove_meaning,
  }));
}
