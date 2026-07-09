'use server';

import { randomBytes } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getActiveWorkspace } from '@/lib/workspace';
import { hashRunnerToken, invalidateRunnerAuth } from '@/app/api/runner/_auth';

export interface RunnerActionState {
  ok?: boolean;
  error?: string;
}

export interface JoinTokenActionState {
  ok?: boolean;
  error?: string;
  /** The raw join token — travels only in this one response, never stored/logged. */
  token?: string;
  joinTokenId?: string;
}

/**
 * Mint a join token — the ONLY way to register a runner. Any workspace
 * member mints tokens for themselves; runners registered through a token are
 * owned by its creator, and job routing sends that user's requested jobs to
 * their runners only. The token is reusable across devices until revoked;
 * only its SHA-256 hash is stored (the exact hash `/api/runner/register`
 * looks up).
 */
export async function mintJoinToken(
  _prev: JoinTokenActionState,
  formData: FormData,
): Promise<JoinTokenActionState> {
  const workspace = await getActiveWorkspace();
  if (!workspace) return { error: 'No workspace selected' };

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated' };

  const label = (formData.get('label') as string | null)?.trim() ?? '';
  if (label.length > 80) return { error: 'Label is too long (max 80 chars)' };

  // The GitHub login (users sign in via GitHub OAuth) — denormalized onto the
  // token so the runners list can show "owner" without an auth-admin lookup.
  const login =
    (typeof user.user_metadata?.user_name === 'string' && user.user_metadata.user_name) ||
    user.email ||
    '';

  const token = randomBytes(32).toString('hex');
  const { data, error } = await supabase
    .from('runner_join_tokens')
    .insert({
      workspace_id: workspace.id,
      created_by: user.id,
      created_by_login: login,
      label,
      token_hash: hashRunnerToken(token),
    })
    .select('id')
    .single();
  if (error) return { error: error.message };

  revalidatePath('/settings/runners');
  return { ok: true, token, joinTokenId: data.id as string };
}

/**
 * Revoke a join token: it can no longer register runners. Runners already
 * registered through it keep working (revoke those individually below).
 * RLS limits this to the token's creator or a workspace admin.
 */
export async function revokeJoinToken(
  _prev: JoinTokenActionState,
  formData: FormData,
): Promise<JoinTokenActionState> {
  const workspace = await getActiveWorkspace();
  if (!workspace) return { error: 'No workspace selected' };

  const id = (formData.get('joinTokenId') as string | null)?.trim() ?? '';
  if (!id) return { error: 'Missing join token id' };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from('runner_join_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id)
    .eq('workspace_id', workspace.id);
  if (error) return { error: error.message };

  revalidatePath('/settings/runners');
  return { ok: true };
}

/** Revoke (delete) a workspace-scoped runner. Admins revoke any; owners
 *  revoke their own (RLS enforces both — runners_admin_write from 0008 plus
 *  runners_owner_delete from the join-token migration). */
export async function revokeRunner(
  _prev: RunnerActionState,
  formData: FormData,
): Promise<RunnerActionState> {
  const workspace = await getActiveWorkspace();
  if (!workspace) return { error: 'No workspace selected' };

  const id = (formData.get('runnerId') as string | null)?.trim() ?? '';
  if (!id) return { error: 'Missing runner id' };

  const supabase = await createSupabaseServerClient();
  // Grab the token hash before deleting so we can drop it from the in-process
  // runner-auth cache — without this the revoked token keeps authenticating
  // for up to RUNNER_AUTH_TTL_MS (issue #80). Best-effort across runtimes.
  const { data: row } = await supabase
    .from('runners')
    .select('token_hash')
    .eq('id', id)
    .eq('workspace_id', workspace.id)
    .maybeSingle();
  const { error } = await supabase
    .from('runners')
    .delete()
    .eq('id', id)
    .eq('workspace_id', workspace.id);
  if (error) return { error: error.message };
  if (row?.token_hash) invalidateRunnerAuth(row.token_hash);

  revalidatePath('/settings/runners');
  return { ok: true };
}
