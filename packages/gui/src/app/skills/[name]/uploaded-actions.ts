'use server';

import { revalidatePath } from 'next/cache';
import { parseSkillMarkdown } from '@cezar/core';
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

function revalidateAfterMutation(name: string) {
  revalidatePath('/skills');
  revalidatePath(`/skills/${encodeURIComponent(name)}`);
  revalidatePath('/workflows', 'layout');
}

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
  // Reject empty/whitespace-only body — an admin who Ctrl+A-deletes the editor
  // would otherwise autosave `body=''` and the workflow engine would silently
  // run the next dispatch with an empty prompt.
  if (!body.trim()) return { ok: false, error: 'body is empty' };
  // Byte-length, not `.length` — multi-byte glyphs would otherwise pass under
  // a 4× larger payload than the constant implies.
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    return { ok: false, error: `body exceeds ${MAX_BODY_BYTES / 1024}KB limit` };
  }

  // Re-parse the frontmatter so derived columns stay in sync with the body.
  // Without this, editing `description:` or `cezar-stages:` in the editor
  // leaves the catalog row showing the old values forever — the workflow
  // picker / list page read `description` and `suggested_stages` directly.
  const parsed = parseSkillMarkdown(body, name);
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from('uploaded_skills')
    .update({
      body,
      description: parsed.description ?? null,
      suggested_stages: parsed.suggestedStages,
      updated_by: user.id,
    })
    .eq('workspace_id', workspace.id)
    .eq('name', name)
    .select('updated_at')
    .maybeSingle<{ updated_at: string }>();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: 'uploaded skill not found' };

  revalidateAfterMutation(name);
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

  revalidateAfterMutation(name);
  return { ok: true };
}
