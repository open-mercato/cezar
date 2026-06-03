'use server';

import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { getSessionUser } from '@/lib/auth';
import { setActiveWorkspace } from '@/lib/workspace';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import type {
  LabelAnalysisDraft,
  LabelAnalysisResult,
  WorkspaceLabelScope,
} from '@/lib/supabase/types';

export interface CreateWorkspaceState {
  error?: string;
  /** Set when the workspace was successfully created. The wizard reads this to advance. */
  workspaceId?: string;
}

export async function createWorkspace(
  _prev: CreateWorkspaceState,
  formData: FormData,
): Promise<CreateWorkspaceState> {
  const user = await getSessionUser();
  if (!user) return { error: 'Not authenticated' };

  const name = (formData.get('name') as string)?.trim();
  const repoOwner = (formData.get('repo_owner') as string)?.trim();
  const repoName = (formData.get('repo_name') as string)?.trim();

  if (!name || !repoOwner || !repoName) {
    return { error: 'All fields are required' };
  }

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) return { error: 'Name must contain at least one alphanumeric character' };

  // Workspace creation uses the service-role client because the user isn't a
  // member yet — RLS would block both the workspace INSERT and the initial
  // membership INSERT. Auth is already verified above via getSessionUser().
  const supabase = createSupabaseAdminClient();

  const { data: workspace, error: wsErr } = await supabase
    .from('workspaces')
    .insert({ slug, name, repo_owner: repoOwner, repo_name: repoName })
    .select('id')
    .single();

  if (wsErr) {
    if (wsErr.code === '23505') {
      return { error: 'A workspace with this repo or slug already exists' };
    }
    return { error: wsErr.message };
  }

  const { error: memErr } = await supabase
    .from('workspace_members')
    .insert({ workspace_id: workspace.id, user_id: user.id, role: 'admin' });

  if (memErr) {
    return { error: `Workspace created but failed to add you as admin: ${memErr.message}` };
  }

  // Seed the data-driven default Action set (15 built-in actions + auto-triage
  // pointer). Idempotent on the SQL side — safe if the workspace already has
  // some actions. Failure here is non-fatal: the workspace is usable without
  // actions, the user can hit a "seed defaults" button from the cockpit later.
  const { error: seedErr } = await supabase.rpc('seed_default_actions', {
    p_workspace_id: workspace.id,
  });
  if (seedErr) {
    console.error('[createWorkspace] seed_default_actions failed:', seedErr.message);
  }

  await setActiveWorkspace(workspace.id);
  // Phase 1 — the wizard advances to the label-analysis step instead of
  // redirecting straight to the dashboard. We return the new id so the
  // client can drive the next step; if the wizard is skipped entirely the
  // user just lands on /dashboard via the "Skip for now" path.
  return { workspaceId: workspace.id };
}

/**
 * Wizard step 2: enqueue a label-analysis job for the freshly created
 * workspace. Mirrors `startLabelAnalysis` from the /settings/labels surface
 * but takes the workspace id explicitly so the wizard doesn't rely on the
 * active-workspace cookie having propagated.
 */
export async function startLabelAnalysisForWorkspace(
  workspaceId: string,
): Promise<{ ok: boolean; analysisId?: string; error?: string }> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: 'Not authenticated' };

  const supabase = createSupabaseAdminClient();
  const { data: member } = await supabase
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id)
    .single();
  if (!member || member.role !== 'admin') return { ok: false, error: 'Admin role required' };

  // Dedupe — never start two analyses concurrently.
  const { data: inflight } = await supabase
    .from('workspace_label_analyses')
    .select('id, status')
    .eq('workspace_id', workspaceId)
    .in('status', ['queued', 'running'])
    .order('created_at', { ascending: false })
    .limit(1);
  if (inflight && inflight.length > 0) {
    return { ok: true, analysisId: inflight[0].id };
  }

  const { data: analysis, error: aErr } = await supabase
    .from('workspace_label_analyses')
    .insert({ workspace_id: workspaceId, status: 'queued', created_by: user.id })
    .select('id')
    .single();
  if (aErr || !analysis) return { ok: false, error: aErr?.message ?? 'failed to create analysis row' };

  const { error: jErr } = await supabase.from('jobs').insert({
    workspace_id: workspaceId,
    kind: 'label-analysis',
    status: 'queued',
    // Cron-dispatched + Anthropic API only. See migration 0023.
    required_backend: 'anthropic-api',
    payload: { analysisId: analysis.id },
  });
  if (jErr) {
    await supabase.from('workspace_label_analyses').delete().eq('id', analysis.id);
    return { ok: false, error: jErr.message };
  }

  return { ok: true, analysisId: analysis.id };
}

/**
 * Wizard step 3: persist the (possibly user-edited) draft as the workspace's
 * accepted label catalog. Wipes any prior `workspace_labels` for the same
 * workspace and re-inserts from the draft, then flips the analysis row to
 * `accepted`. Used by both the /workspaces/new wizard and Phase 2's reinit
 * surface in /settings/labels.
 */
export async function acceptLabelAnalysis(
  analysisId: string,
  edited: LabelAnalysisResult,
): Promise<{ ok: boolean; error?: string }> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: 'Not authenticated' };

  const supabase = createSupabaseAdminClient();
  const { data: analysis } = await supabase
    .from('workspace_label_analyses')
    .select('id, workspace_id, status')
    .eq('id', analysisId)
    .single();
  if (!analysis) return { ok: false, error: 'analysis not found' };

  const { data: member } = await supabase
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', analysis.workspace_id)
    .eq('user_id', user.id)
    .single();
  if (!member || member.role !== 'admin') return { ok: false, error: 'Admin role required' };

  if (analysis.status !== 'completed' && analysis.status !== 'accepted') {
    return { ok: false, error: `Cannot accept an analysis in status '${analysis.status}'` };
  }

  // Wipe prior catalog for this workspace — the accept is a full replace
  // (the user reviewed the whole draft, so we treat their decision as the
  // authoritative new state).
  const { error: delErr } = await supabase
    .from('workspace_labels')
    .delete()
    .eq('workspace_id', analysis.workspace_id);
  if (delErr) return { ok: false, error: `clear failed: ${delErr.message}` };

  const rows = [
    ...edited.issue_labels.map((d) => draftToRow(d, analysis.workspace_id, analysisId, 'issue')),
    ...edited.pr_labels.map((d) => draftToRow(d, analysis.workspace_id, analysisId, 'pr')),
  ];
  if (rows.length > 0) {
    const { error: insErr } = await supabase.from('workspace_labels').insert(rows);
    if (insErr) return { ok: false, error: `insert failed: ${insErr.message}` };
  }

  await supabase
    .from('workspace_label_analyses')
    .update({ status: 'accepted', updated_at: new Date().toISOString() })
    .eq('id', analysisId);

  revalidatePath('/settings');
  return { ok: true };
}

function draftToRow(
  d: LabelAnalysisDraft,
  workspaceId: string,
  analysisId: string,
  scope: WorkspaceLabelScope,
) {
  return {
    workspace_id: workspaceId,
    analysis_id: analysisId,
    name: d.name,
    scope,
    color: d.color ?? null,
    description: d.description || null,
    when_to_add: d.when_to_add || null,
    when_to_remove: d.when_to_remove || null,
    add_meaning: d.add_meaning || null,
    remove_meaning: d.remove_meaning || null,
    exists_on_github: d.exists_on_github,
    source: 'user-edited' as const,
  };
}

export async function deleteWorkspace(workspaceId: string) {
  const user = await getSessionUser();
  if (!user) throw new Error('Not authenticated');
  const supabase = createSupabaseAdminClient();
  const { data: member } = await supabase
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!member || member.role !== 'admin') throw new Error('Admin role required');
  const { error } = await supabase.from('workspaces').delete().eq('id', workspaceId);
  if (error) throw new Error(error.message);
  redirect('/dashboard');
}
