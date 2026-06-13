import type { SupabaseClient } from '@supabase/supabase-js';
import type { Skill, SkillSource } from '@cezar/core';
import type { Database } from './supabase/types';

/**
 * Issue #262 (PR 1) — per-(workspace, skill) enabled flag.
 *
 * Lives in `workspace_skill_states` (migration 0044). Independent of
 * `skill_overrides`: an override only carries body+metadata, while a state row
 * decides whether the skill shows up in workflow pickers and triage runs at
 * all. The two tables are joined name-side at consumer level — see
 * `getActiveSkills` below.
 */
export interface SkillState {
  enabled: boolean;
  pinnedSource: SkillSource | null;
}

/** Batch lookup keyed by skill name. Missing rows mean "no state recorded". */
export async function getWorkspaceSkillStates(
  workspaceId: string,
  supabase: SupabaseClient<Database>,
): Promise<Map<string, SkillState>> {
  const { data, error } = await supabase
    .from('workspace_skill_states')
    .select('skill_name, enabled, pinned_source')
    .eq('workspace_id', workspaceId);
  if (error || !data) return new Map();
  const out = new Map<string, SkillState>();
  for (const row of data) {
    out.set(row.skill_name, {
      enabled: row.enabled,
      pinnedSource: (row.pinned_source as SkillSource | null) ?? null,
    });
  }
  return out;
}

/** Admin-only — flip the enabled flag for a single skill. Caller revalidates UI paths. */
export async function setSkillEnabled(
  workspaceId: string,
  skillName: string,
  enabled: boolean,
  supabase: SupabaseClient<Database>,
  userId: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase
    .from('workspace_skill_states')
    .upsert(
      {
        workspace_id: workspaceId,
        skill_name: skillName,
        enabled,
        updated_by: userId,
        // `created_by` only on the very first insert. Postgres ignores it on
        // conflicts but we still want it populated when the row is brand new.
        created_by: userId,
      },
      { onConflict: 'workspace_id,skill_name' },
    );
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Filter a catalog down to the workspace's *active* skills. Used by the
 * workflow executor and the skill picker — keeps disabled skills from leaking
 * into runs even if a binding still references them.
 *
 * A skill is active when either:
 *   - there is a `workspace_skill_states` row for it with `enabled=true`, or
 *   - the workspace is fresh (`skill_states_seeded=false`) AND the skill is a
 *     built-in (the default-on policy for never-touched workspaces).
 */
export function filterActiveSkills(
  catalog: Skill[],
  states: Map<string, SkillState>,
  workspaceSeeded: boolean,
): Skill[] {
  return catalog.filter((skill) => {
    const state = states.get(skill.name);
    if (state) return state.enabled;
    // Unrecorded skill: only built-ins are "on by default" — and only until the
    // workspace has been seeded. After seeding, an unrecorded skill is silently
    // disabled (the user explicitly cleared its row).
    if (!workspaceSeeded && skill.source === 'built-in') return true;
    return false;
  });
}

/**
 * One-shot seed for fresh workspaces: writes an `enabled=true` row for every
 * built-in skill, then marks the workspace as seeded so the lazy default
 * doesn't keep re-enabling skills the user later disabled.
 *
 * Idempotent: a workspace already marked seeded is a no-op. Caller passes the
 * full discovered catalog so we don't re-import core here for path resolution.
 */
export async function seedBuiltinSkillStatesIfNeeded(
  workspaceId: string,
  workspaceSeeded: boolean,
  catalog: Skill[],
  supabase: SupabaseClient<Database>,
): Promise<{ seeded: boolean }> {
  if (workspaceSeeded) return { seeded: false };
  const builtins = catalog.filter((s) => s.source === 'built-in');
  if (builtins.length > 0) {
    const rows = builtins.map((s) => ({
      workspace_id: workspaceId,
      skill_name: s.name,
      enabled: true,
    }));
    // Don't clobber a state the user may have already written (race with toggle).
    const { error: insertError } = await supabase
      .from('workspace_skill_states')
      .upsert(rows, { onConflict: 'workspace_id,skill_name', ignoreDuplicates: true });
    if (insertError) {
      // Surfacing this here would block the page render for a non-fatal seed; log instead.
      console.warn('[skill-state] built-in seed failed:', insertError.message);
      return { seeded: false };
    }
  }
  const { error: flagError } = await supabase
    .from('workspaces')
    .update({ skill_states_seeded: true })
    .eq('id', workspaceId);
  if (flagError) {
    console.warn('[skill-state] flagging skill_states_seeded failed:', flagError.message);
    return { seeded: false };
  }
  return { seeded: true };
}
