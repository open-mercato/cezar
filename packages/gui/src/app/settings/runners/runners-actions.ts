'use server';

import { randomBytes } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getActiveWorkspace } from '@/lib/workspace';
import { hashRunnerToken, invalidateRunnerAuth } from '@/app/api/runner/_auth';

/** Backends a *self-hosted* runner may advertise. */
const VALID_BACKENDS = ['claude-cli', 'codex-cli', 'anthropic-api'] as const;
type SelfHostedBackend = (typeof VALID_BACKENDS)[number];

export interface RunnerActionState {
  ok?: boolean;
  error?: string;
  /** The raw bearer token — travels only in this one response, never stored/logged. */
  token?: string;
  runnerId?: string;
  /** The backends the new runner was registered with (for the paste-ready command). */
  backends?: string[];
}

/**
 * Register a new self-hosted runner. Generates a high-entropy bearer token,
 * stores only its SHA-256 hash (the exact hash `api/runner/_auth.ts` checks),
 * and returns the raw token once so the operator can copy it. Admin-only.
 */
export async function registerRunner(
  _prev: RunnerActionState,
  formData: FormData,
): Promise<RunnerActionState> {
  const workspace = await getActiveWorkspace();
  if (!workspace) return { error: 'No workspace selected' };
  if (workspace.role !== 'admin') return { error: 'Only admins can register runners' };

  const name = (formData.get('name') as string | null)?.trim() ?? '';
  if (!name) return { error: 'Runner name is required' };
  if (name.length > 80) return { error: 'Runner name is too long (max 80 chars)' };

  // `backends` arrives as repeated form fields (checkboxes).
  const backends = formData
    .getAll('backends')
    .map((b) => String(b).trim())
    .filter((b): b is SelfHostedBackend => (VALID_BACKENDS as readonly string[]).includes(b));
  if (backends.length === 0) return { error: 'Pick at least one backend' };

  const token = randomBytes(32).toString('hex');
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('runners')
    .insert({
      workspace_id: workspace.id,
      name,
      kind: 'self-hosted',
      backends,
      models: [],
      token_hash: hashRunnerToken(token),
      status: 'offline',
    })
    .select('id')
    .single();
  if (error) return { error: error.message };

  revalidatePath('/settings/runners');
  return { ok: true, token, runnerId: data.id as string, backends };
}

/** Revoke (delete) a workspace-scoped runner. Admin-only. */
export async function revokeRunner(
  _prev: RunnerActionState,
  formData: FormData,
): Promise<RunnerActionState> {
  const workspace = await getActiveWorkspace();
  if (!workspace) return { error: 'No workspace selected' };
  if (workspace.role !== 'admin') return { error: 'Only admins can revoke runners' };

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
