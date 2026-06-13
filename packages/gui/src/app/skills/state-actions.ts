'use server';

import { revalidatePath } from 'next/cache';
import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { setSkillEnabled as setSkillEnabledImpl } from '@/lib/skill-state';

export interface SetSkillEnabledResult {
  ok: boolean;
  error?: string;
  enabled?: boolean;
}

/**
 * Issue #262 — toggle a skill's enabled state for the active workspace.
 *
 * Distinct from `skill_overrides.enabled` (which only existed for skills the
 * user had also forked). This writes/upserts into `workspace_skill_states` so
 * any skill in the catalog can be flipped on or off without first overriding
 * it.
 */
export async function setSkillEnabled(
  skillName: string,
  enabled: boolean,
): Promise<SetSkillEnabledResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: 'Not authenticated' };
  const workspace = await getActiveWorkspace();
  if (!workspace) return { ok: false, error: 'No workspace selected' };
  if (workspace.role !== 'admin') {
    return { ok: false, error: 'Only admins can change skill state' };
  }
  if (!skillName.trim()) return { ok: false, error: 'skillName is required' };

  const supabase = createSupabaseAdminClient();
  const result = await setSkillEnabledImpl(
    workspace.id,
    skillName,
    enabled,
    supabase,
    user.id,
  );
  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath('/skills');
  revalidatePath(`/skills/${encodeURIComponent(skillName)}`);
  revalidatePath('/workflows');
  return { ok: true, enabled };
}
