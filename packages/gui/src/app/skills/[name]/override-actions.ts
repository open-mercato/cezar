'use server';

import { revalidatePath } from 'next/cache';
import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { readSkillBody } from '@/lib/skill-body';
import { setSkillEnabled as setStateEnabled } from '@/lib/skill-state';

export interface OverridePayload {
  executionMode: string;
  triggers: string[];
  outputs: string[];
  capabilities: string[];
  body: string;
}

export interface SaveOverrideResult {
  ok: boolean;
  error?: string;
  updatedAt?: string;
  enabled?: boolean;
}

/**
 * Internal helpers: every action below repeats the same auth/workspace
 * preamble. Pulling it out keeps the public surface focused.
 */
async function requireAdminWorkspace() {
  const user = await getSessionUser();
  if (!user) return { error: 'Not authenticated' as const };
  const workspace = await getActiveWorkspace();
  if (!workspace) return { error: 'No workspace selected' as const };
  if (workspace.role !== 'admin') return { error: 'Only admins can edit overrides' as const };
  return { user, workspace };
}

function revalidateSkill(name: string) {
  revalidatePath('/skills');
  revalidatePath(`/skills/${encodeURIComponent(name)}`);
}

/**
 * Full-payload save. If the override doesn't exist yet, it's created from the
 * original (cloned) body when the caller didn't pass one — that way "Save"
 * after only changing metadata still produces a faithful copy.
 */
export async function saveSkillOverride(
  skillName: string,
  payload: OverridePayload,
  options: { enable?: boolean } = {},
): Promise<SaveOverrideResult> {
  const auth = await requireAdminWorkspace();
  if ('error' in auth) return { ok: false, error: auth.error };
  const { user, workspace } = auth;

  // If the user submitted an empty body, fall back to the original from the
  // cached clone so we always have *something* to compare against later.
  let body = payload.body;
  if (body === '') {
    const supabase = createSupabaseAdminClient();
    const { data: skillsRow } = await supabase
      .from('repo_skills')
      .select('skills')
      .eq('workspace_id', workspace.id)
      .eq('repo', workspace.repoName)
      .maybeSingle();
    const skills = Array.isArray(skillsRow?.skills) ? (skillsRow!.skills as Array<{ name?: unknown; path?: unknown }>) : [];
    const match = skills.find((s) => typeof s?.name === 'string' && s.name === skillName);
    const path = typeof match?.path === 'string' ? match.path : null;
    if (path) {
      const original = await readSkillBody(workspace.repoOwner, workspace.repoName, path);
      if (original !== null) body = original;
    }
  }

  const supabase = createSupabaseAdminClient();
  const row = {
    workspace_id: workspace.id,
    skill_name: skillName,
    body,
    execution_mode: payload.executionMode,
    triggers: payload.triggers,
    outputs: payload.outputs,
    capabilities: payload.capabilities,
    enabled: options.enable ?? true,
    updated_by: user.id,
  } as const;

  const { data, error } = await supabase
    .from('skill_overrides')
    .upsert(row, { onConflict: 'workspace_id,skill_name' })
    .select('updated_at, enabled')
    .single();

  if (error) return { ok: false, error: error.message };

  // Mirror the override's enabled bit into workspace_skill_states — that
  // table is the runtime source of truth (used by `isSkillActive` /
  // `filterActiveSkills`). Without this mirror, "Save & Enable" on the
  // detail page is a no-op for the workflow runtime and the picker.
  const stateMirror = await setStateEnabled(workspace.id, skillName, row.enabled, supabase, user.id);
  if (!stateMirror.ok) return { ok: false, error: stateMirror.error };

  revalidateSkill(skillName);
  revalidatePath('/workflows');
  return { ok: true, updatedAt: data?.updated_at ?? undefined, enabled: data?.enabled ?? row.enabled };
}

/**
 * Body-only autosave. Updates the body of an *existing* override only.
 *
 * It deliberately does NOT create the override: forking an upstream skill must
 * be an intentional act (the explicit "Save as override" / "Save & Enable"
 * buttons, which carry the full metadata payload). Auto-creating here on the
 * first keystroke would silently flip the skill to OVERRIDE and reset metadata
 * to DB defaults — exactly the surprise the override pattern guards against.
 * Callers gate this on the override already existing; if it somehow doesn't,
 * we no-op with an error rather than insert a default row.
 */
export async function autosaveSkillOverrideBody(
  skillName: string,
  body: string,
): Promise<SaveOverrideResult> {
  const auth = await requireAdminWorkspace();
  if ('error' in auth) return { ok: false, error: auth.error };
  const { user, workspace } = auth;

  const supabase = createSupabaseAdminClient();

  const { data: existing } = await supabase
    .from('skill_overrides')
    .select('id')
    .eq('workspace_id', workspace.id)
    .eq('skill_name', skillName)
    .maybeSingle();

  if (!existing) {
    return { ok: false, error: 'No override to autosave — use "Save as override" first' };
  }

  const { data, error } = await supabase
    .from('skill_overrides')
    .update({ body, updated_by: user.id })
    .eq('id', existing.id)
    .select('updated_at, enabled')
    .single();
  if (error) return { ok: false, error: error.message };
  revalidateSkill(skillName);
  return { ok: true, updatedAt: data?.updated_at ?? undefined, enabled: data?.enabled ?? true };
}

export async function setSkillOverrideEnabled(
  skillName: string,
  enabled: boolean,
): Promise<SaveOverrideResult> {
  const auth = await requireAdminWorkspace();
  if ('error' in auth) return { ok: false, error: auth.error };
  const { user, workspace } = auth;

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from('skill_overrides')
    .update({ enabled, updated_by: user.id })
    .eq('workspace_id', workspace.id)
    .eq('skill_name', skillName)
    .select('updated_at, enabled')
    .single();
  if (error) return { ok: false, error: error.message };

  // Mirror to workspace_skill_states — runtime activation lives there.
  const stateMirror = await setStateEnabled(workspace.id, skillName, enabled, supabase, user.id);
  if (!stateMirror.ok) return { ok: false, error: stateMirror.error };

  revalidateSkill(skillName);
  revalidatePath('/workflows');
  return { ok: true, updatedAt: data?.updated_at ?? undefined, enabled: data?.enabled ?? enabled };
}

/**
 * Reverts to the upstream skill by deleting the override row entirely.
 */
export async function deleteSkillOverride(skillName: string): Promise<SaveOverrideResult> {
  const auth = await requireAdminWorkspace();
  if ('error' in auth) return { ok: false, error: auth.error };
  const { workspace } = auth;

  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from('skill_overrides')
    .delete()
    .eq('workspace_id', workspace.id)
    .eq('skill_name', skillName);
  if (error) return { ok: false, error: error.message };
  revalidateSkill(skillName);
  return { ok: true };
}
