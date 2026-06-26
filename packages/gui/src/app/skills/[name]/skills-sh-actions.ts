'use server';

import { revalidatePath } from 'next/cache';
import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import {
  refreshSkillsShSkill as refreshById,
  removeSkillsShSkill as removeById,
} from '../skills-sh-actions';

/**
 * Issue #262 (PR 4) — convenience wrappers around the id-keyed actions that
 * the detail page reaches by skill name. Resolves `name → id` against the
 * active workspace, then delegates to the canonical action.
 */

export type ActionResult<T = {}> = (T & { ok: true }) | { ok: false; error: string };

/**
 * Gate the name→id resolver on the same admin role that the underlying
 * id-keyed actions require. Without this an authenticated non-admin member
 * could probe the existence of skills.sh imports by name (the resolver runs
 * the admin client which bypasses RLS) before being told they don't have
 * permission.
 */
async function resolveIdByName(name: string): Promise<{ id: string } | { error: string }> {
  const user = await getSessionUser();
  if (!user) return { error: 'Not authenticated' };
  const workspace = await getActiveWorkspace();
  if (!workspace) return { error: 'No workspace selected' };
  if (workspace.role !== 'admin') {
    return { error: 'Only admins can manage skills.sh imports' };
  }
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from('skills_sh_skills')
    .select('id')
    .eq('workspace_id', workspace.id)
    .eq('name', name)
    .maybeSingle<{ id: string }>();
  if (error) return { error: error.message };
  if (!data) return { error: 'skills.sh skill not found for this name' };
  return { id: data.id };
}

export async function refreshSkillsShSkillByName(
  name: string,
): Promise<ActionResult<{ changed: boolean }>> {
  const resolved = await resolveIdByName(name);
  if ('error' in resolved) return { ok: false, error: resolved.error };
  const result = await refreshById(resolved.id);
  if (!result.ok) return result;
  // refreshById already covers `/skills`, `/skills/[name]`, and the
  // `/workflows` layout; we re-revalidate the detail route under the
  // caller-supplied name in case the admin sat on an old URL.
  revalidatePath(`/skills/${encodeURIComponent(name)}`);
  return { ok: true, changed: result.changed };
}

export async function removeSkillsShSkillByName(name: string): Promise<ActionResult> {
  const resolved = await resolveIdByName(name);
  if ('error' in resolved) return { ok: false, error: resolved.error };
  const result = await removeById(resolved.id);
  if (!result.ok) return result;
  // Mirror the surface set the id-keyed action revalidates, plus the
  // detail route under the caller-supplied name.
  revalidatePath(`/skills/${encodeURIComponent(name)}`);
  return { ok: true };
}
