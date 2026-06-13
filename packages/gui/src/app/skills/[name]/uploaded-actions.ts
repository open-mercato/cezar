'use server';

import { revalidatePath } from 'next/cache';
import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';

/**
 * Issue #262 (PR 3) — autosave + delete for uploaded (disk) skills.
 *
 * Disk skills are first-class catalog entries: their bodies live in the
 * `uploaded_skills.body` column, the skill detail page edits that directly.
 * No "fork upstream first" handshake like the override editor — uploaded
 * skills *are* the canonical version.
 */

export type ActionResult<T = {}> = (T & { ok: true }) | { ok: false; error: string };

const MAX_BODY_BYTES = 100 * 1024;

export async function autosaveUploadedSkillBody(
  name: string,
  body: string,
): Promise<ActionResult<{ updatedAt: string }>> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: 'Not authenticated' };
  const workspace = await getActiveWorkspace();
  if (!workspace) return { ok: false, error: 'No workspace selected' };
  if (workspace.role !== 'admin') {
    return { ok: false, error: 'Only admins can edit uploaded skills' };
  }
  if (!name.trim()) return { ok: false, error: 'name is required' };
  if (body.length > MAX_BODY_BYTES) {
    return { ok: false, error: `body exceeds ${MAX_BODY_BYTES / 1024}KB limit` };
  }

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from('uploaded_skills')
    .update({ body, updated_by: user.id })
    .eq('workspace_id', workspace.id)
    .eq('name', name)
    .select('updated_at')
    .maybeSingle<{ updated_at: string }>();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: 'uploaded skill not found' };

  revalidatePath('/skills');
  revalidatePath(`/skills/${encodeURIComponent(name)}`);
  return { ok: true, updatedAt: data.updated_at };
}

export async function deleteUploadedSkill(name: string): Promise<ActionResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: 'Not authenticated' };
  const workspace = await getActiveWorkspace();
  if (!workspace) return { ok: false, error: 'No workspace selected' };
  if (workspace.role !== 'admin') {
    return { ok: false, error: 'Only admins can remove uploaded skills' };
  }
  if (!name.trim()) return { ok: false, error: 'name is required' };

  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from('uploaded_skills')
    .delete()
    .eq('workspace_id', workspace.id)
    .eq('name', name);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/skills');
  return { ok: true };
}
