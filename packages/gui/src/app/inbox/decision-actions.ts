'use server';

import { revalidatePath } from 'next/cache';
import * as core from '@cezar/core';
import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { loadWorkspaceConfig } from '@/lib/load-workspace-config';

export interface DecisionResult {
  ok: boolean;
  /** Per-row outcome when called in bulk; populated even on partial success. */
  results?: Array<{ id: string; ok: boolean; error?: string }>;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────────────
async function requireAdminWorkspace() {
  const user = await getSessionUser();
  if (!user) return { error: 'Not authenticated' as const };
  const workspace = await getActiveWorkspace();
  if (!workspace) return { error: 'No workspace selected' as const };
  if (workspace.role !== 'admin') return { error: 'Only admins can decide on findings' as const };
  return { user, workspace };
}

// ─────────────────────────────────────────────────────────────────────
// Row shape we care about
// ─────────────────────────────────────────────────────────────────────
interface DecisionRow {
  id: string;
  workspace_id: string;
  effect: string;
  effect_args: unknown;
  target_kind: 'issue' | 'pr';
  issue_number: number | null;
  pr_number: number | null;
  status: string;
}

async function loadPendingRow(id: string, workspaceId: string): Promise<DecisionRow | null> {
  const supabase = createSupabaseAdminClient();
  const { data } = await supabase
    .from('pending_decisions')
    .select('id, workspace_id, effect, effect_args, target_kind, issue_number, pr_number, status')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle<DecisionRow>();
  return data ?? null;
}

// ─────────────────────────────────────────────────────────────────────
// Lazy effect-context builder — shared by accept() callers.
// Acquiring a GitHub token + building GitHubService is non-trivial, so we
// memoise it per-invocation (constructed once for a batch of accepts).
// ─────────────────────────────────────────────────────────────────────
async function buildEffectContext(
  workspace: {
    id: string;
    repoOwner: string;
    repoName: string;
  },
  user: { githubToken?: string | null },
) {
  let githubToken: string | null = null;
  if (core.GitHubAppService.isConfigured()) {
    try {
      githubToken = await new core.GitHubAppService().getInstallationToken(workspace.repoOwner);
    } catch {
      // fall through to OAuth
    }
  }
  if (!githubToken) githubToken = user.githubToken || process.env.GITHUB_TOKEN || null;
  if (!githubToken) {
    throw new Error('No GitHub token — sign out and back in to re-auth');
  }

  const supabase = createSupabaseAdminClient();
  const config = await loadWorkspaceConfig(workspace.id, supabase, {
    githubToken,
    repoOwner: workspace.repoOwner,
    repoName: workspace.repoName,
  });

  const github = new core.GitHubService(config);
  return { github, supabase };
}

// ─────────────────────────────────────────────────────────────────────
// acceptDecision — re-fires the captured effect through EFFECT_REGISTRY.
// ─────────────────────────────────────────────────────────────────────
export async function acceptDecision(id: string): Promise<DecisionResult> {
  const result = await acceptDecisionsImpl([id]);
  if (result.ok) return { ok: true, results: result.results };
  // A per-row failure leaves the impl's top-level `error` unset — lift the
  // row's message so the single-accept toast shows the real cause instead
  // of "unknown".
  const first = result.results?.[0];
  return {
    ok: false,
    error: result.error ?? first?.error ?? 'accept failed',
    results: result.results,
  };
}

export async function acceptDecisions(ids: string[]): Promise<DecisionResult> {
  return acceptDecisionsImpl(ids);
}

async function acceptDecisionsImpl(ids: string[]): Promise<DecisionResult> {
  if (ids.length === 0) return { ok: true, results: [] };
  const auth = await requireAdminWorkspace();
  if ('error' in auth) return { ok: false, error: auth.error };
  const { user, workspace } = auth;

  // Build the effect context once for the whole batch.
  let ctx: { github: core.GitHubService; supabase: ReturnType<typeof createSupabaseAdminClient> };
  try {
    ctx = await buildEffectContext(workspace, user);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const supabase = ctx.supabase;
  const perRow: Array<{ id: string; ok: boolean; error?: string }> = [];

  for (const id of ids) {
    const row = await loadPendingRow(id, workspace.id);
    if (!row) {
      perRow.push({ id, ok: false, error: 'not found' });
      continue;
    }
    if (row.status !== 'pending') {
      perRow.push({ id, ok: false, error: `already ${row.status}` });
      continue;
    }
    const targetNumber = row.target_kind === 'issue' ? row.issue_number : row.pr_number;
    if (targetNumber == null) {
      perRow.push({ id, ok: false, error: 'row missing target_number' });
      continue;
    }

    // Cheap mutex — only one accept can transition pending → accepted.
    // If a sibling tab already won, we bail before executing the effect.
    const { data: claimed, error: claimErr } = await supabase
      .from('pending_decisions')
      .update({
        status: 'accepted',
        decided_at: new Date().toISOString(),
        decided_by: user.id,
        apply_error: null,
      })
      .eq('id', id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();
    if (claimErr || !claimed) {
      perRow.push({ id, ok: false, error: claimErr?.message ?? 'lost race to another accept' });
      continue;
    }

    try {
      const effectCtx: core.EffectContext = {
        github: ctx.github,
        targetNumber,
        supabase,
        // Effects that write workspace-scoped rows (suggest-workflow's flow
        // job enqueue) need the workspace id on accept too.
        workspaceId: workspace.id,
      };
      await core.executeEffect(
        { effect: row.effect as core.EffectName, args: row.effect_args },
        effectCtx,
      );
      perRow.push({ id, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Roll the row back to pending with the apply_error set so the user
      // can retry or dismiss. Don't lose the apply_error if the rollback
      // itself fails.
      await supabase
        .from('pending_decisions')
        .update({
          status: 'pending',
          decided_at: null,
          decided_by: null,
          apply_error: message,
        })
        .eq('id', id);
      perRow.push({ id, ok: false, error: message });
    }
  }

  revalidatePath('/inbox');
  return { ok: perRow.every((r) => r.ok), results: perRow };
}

// ─────────────────────────────────────────────────────────────────────
// dismissDecision — marks rows without executing the effect.
// ─────────────────────────────────────────────────────────────────────
export async function dismissDecision(id: string, reason?: string): Promise<DecisionResult> {
  return dismissDecisions([id], reason);
}

export async function dismissDecisions(ids: string[], reason?: string): Promise<DecisionResult> {
  if (ids.length === 0) return { ok: true, results: [] };
  const auth = await requireAdminWorkspace();
  if ('error' in auth) return { ok: false, error: auth.error };
  const { user, workspace } = auth;

  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from('pending_decisions')
    .update({
      status: 'dismissed',
      decided_at: new Date().toISOString(),
      decided_by: user.id,
      decided_reason: reason ?? null,
    })
    .in('id', ids)
    .eq('workspace_id', workspace.id)
    .eq('status', 'pending');

  revalidatePath('/inbox');
  if (error) return { ok: false, error: error.message };
  return { ok: true, results: ids.map((id) => ({ id, ok: true })) };
}

// ─────────────────────────────────────────────────────────────────────
// snoozeDecision — hides a pending row until `expires_at` passes.
// Status stays `pending` so the runner-side semantics (race-free accept,
// dismiss vs. accept distinction) remain identical; only the loader
// excludes rows whose `expires_at` is set and still in the future.
// ─────────────────────────────────────────────────────────────────────
export async function snoozeDecision(id: string, hours = 24): Promise<DecisionResult> {
  return snoozeDecisions([id], hours);
}

export async function snoozeDecisions(ids: string[], hours = 24): Promise<DecisionResult> {
  if (ids.length === 0) return { ok: true, results: [] };
  const auth = await requireAdminWorkspace();
  if ('error' in auth) return { ok: false, error: auth.error };
  const { workspace } = auth;

  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from('pending_decisions')
    .update({ expires_at: expiresAt })
    .in('id', ids)
    .eq('workspace_id', workspace.id)
    .eq('status', 'pending');

  revalidatePath('/inbox');
  if (error) return { ok: false, error: error.message };
  return { ok: true, results: ids.map((id) => ({ id, ok: true })) };
}
