'use server';

import { revalidatePath } from 'next/cache';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace } from '@/lib/workspace';

export interface StartLabelAnalysisResult {
  ok: boolean;
  analysisId?: string;
  error?: string;
}

/**
 * Enqueues a label-analysis job for the active workspace.
 *
 * Idempotent against in-flight runs: if there's already a `queued` or
 * `running` analysis, we return its id rather than starting a duplicate.
 * Phase 0c — a successful call returns the analysisId so the client UI
 * can start polling immediately.
 */
export async function startLabelAnalysis(): Promise<StartLabelAnalysisResult> {
  const [user, workspace] = await Promise.all([getSessionUser(), getActiveWorkspace()]);
  if (!user) return { ok: false, error: 'Not authenticated' };
  if (!workspace) return { ok: false, error: 'No active workspace' };
  if (workspace.role !== 'admin') return { ok: false, error: 'Admin role required' };

  const supabase = createSupabaseAdminClient();

  // Dedupe against an in-flight run.
  const { data: inflight } = await supabase
    .from('workspace_label_analyses')
    .select('id, status')
    .eq('workspace_id', workspace.id)
    .in('status', ['queued', 'running'])
    .order('created_at', { ascending: false })
    .limit(1);

  if (inflight && inflight.length > 0) {
    return { ok: true, analysisId: inflight[0].id };
  }

  const { data: analysis, error: aErr } = await supabase
    .from('workspace_label_analyses')
    .insert({
      workspace_id: workspace.id,
      status: 'queued',
      created_by: user.id,
    })
    .select('id')
    .single();
  if (aErr || !analysis) return { ok: false, error: aErr?.message ?? 'failed to create analysis row' };

  const { error: jErr } = await supabase.from('jobs').insert({
    workspace_id: workspace.id,
    repo: `${workspace.repoOwner}/${workspace.repoName}`,
    kind: 'label-analysis',
    status: 'queued',
    // Pin to the Anthropic API backend — the executor calls the SDK directly
    // and does not understand the runner-API workflow shape. The SQL-level
    // guard (0023) is the hard enforcement; this stamp documents intent and
    // makes a misrouted job easy to spot.
    required_backend: 'anthropic-api',
    payload: { analysisId: analysis.id },
  });
  if (jErr) {
    // Roll back the analysis row so we don't strand it as `queued` forever.
    await supabase.from('workspace_label_analyses').delete().eq('id', analysis.id);
    return { ok: false, error: jErr.message };
  }

  revalidatePath('/settings');
  return { ok: true, analysisId: analysis.id };
}

/**
 * Cancels any in-flight (queued/running) label-analysis for the active
 * workspace. Marks both the analysis row and its job as `cancelled`.
 * Idempotent — no-op if nothing is in flight.
 */
export async function cancelLabelAnalysis(): Promise<{ ok: boolean; cancelled: number; error?: string }> {
  const workspace = await getActiveWorkspace();
  if (!workspace) return { ok: false, cancelled: 0, error: 'No active workspace' };
  if (workspace.role !== 'admin') return { ok: false, cancelled: 0, error: 'Admin role required' };

  const supabase = createSupabaseAdminClient();
  const { data: inflight } = await supabase
    .from('workspace_label_analyses')
    .select('id, job_id')
    .eq('workspace_id', workspace.id)
    .in('status', ['queued', 'running']);

  if (!inflight || inflight.length === 0) return { ok: true, cancelled: 0 };

  const ts = new Date().toISOString();
  const analysisIds = inflight.map((a) => a.id);
  const { error: aErr } = await supabase
    .from('workspace_label_analyses')
    .update({ status: 'cancelled', finished_at: ts, error: 'Cancelled by user' })
    .in('id', analysisIds);
  if (aErr) return { ok: false, cancelled: 0, error: aErr.message };

  // Also flip the matching jobs to 'cancelled' so the watchdog stops looking
  // at them and the dispatcher doesn't try to claim them later. Match by
  // payload.analysisId since job_id is only stamped on the analysis row by
  // the executor after the run begins.
  const { error: jErr } = await supabase
    .from('jobs')
    .update({ status: 'cancelled', updated_at: ts })
    .eq('workspace_id', workspace.id)
    .eq('kind', 'label-analysis')
    .in('status', ['queued', 'claimed', 'running'])
    .in('payload->>analysisId', analysisIds);
  if (jErr) {
    // Non-fatal: analyses are already cancelled. Log + continue.
    console.error('[cancelLabelAnalysis] job update failed:', jErr.message);
  }

  revalidatePath('/settings');
  return { ok: true, cancelled: inflight.length };
}

/**
 * Wipes the accepted label catalog (workspace_labels) for the active
 * workspace. Used by the reinit flow before kicking off a fresh analysis.
 * (Phase 0c surface only — Phase 2 wires the UI.)
 */
export async function clearWorkspaceLabels(): Promise<{ ok: boolean; error?: string }> {
  const workspace = await getActiveWorkspace();
  if (!workspace) return { ok: false, error: 'No active workspace' };
  if (workspace.role !== 'admin') return { ok: false, error: 'Admin role required' };
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase.from('workspace_labels').delete().eq('workspace_id', workspace.id);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/settings');
  return { ok: true };
}
