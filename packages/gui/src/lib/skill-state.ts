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

/**
 * Batch lookup keyed by skill name. Missing rows mean "no state recorded".
 * Throws on a DB error so callers can either tolerate it (page render: catch
 * and fall through to the default-on rule, which is still a safe surface)
 * or surface it (the workflow dispatcher: drop back to the legacy
 * `discoverSkillsSafe` path so the per-issue event stream sees the failure
 * instead of silently running with zero skills).
 */
export async function getWorkspaceSkillStates(
  workspaceId: string,
  supabase: SupabaseClient<Database>,
): Promise<Map<string, SkillState>> {
  const { data, error } = await supabase
    .from('workspace_skill_states')
    .select('skill_name, enabled, pinned_source')
    .eq('workspace_id', workspaceId);
  if (error) {
    throw new Error(`workspace_skill_states fetch failed: ${error.message}`);
  }
  const out = new Map<string, SkillState>();
  for (const row of data ?? []) {
    out.set(row.skill_name, {
      enabled: row.enabled,
      pinnedSource: (row.pinned_source as SkillSource | null) ?? null,
    });
  }
  return out;
}

/**
 * Fetch everything the activation predicates need in one round-trip: the per-
 * skill state map AND the workspace's `skill_states_seeded` flag. Three call
 * sites (`/skills` page, `listAvailableSkills`, `loadActiveSkillCatalog`) used
 * to pair these two queries by hand — collapsing them removes the duplication
 * and keeps the "what's the default-on rule" logic in one place.
 *
 * `error` is populated when either query failed. Pages tolerate it (the empty
 * states + seeded=false combo falls through to the default-on rule, which is
 * the safe surface). The workflow dispatcher checks it and bails to the
 * legacy `discoverSkillsSafe` fallback so a transient DB blip doesn't turn
 * into a silent zero-skill autofix run.
 */
export async function getSkillActivationContext(
  workspaceId: string,
  supabase: SupabaseClient<Database>,
): Promise<{ states: Map<string, SkillState>; seeded: boolean; error: string | null }> {
  try {
    const [states, { data }] = await Promise.all([
      getWorkspaceSkillStates(workspaceId, supabase),
      supabase
        .from('workspaces')
        .select('skill_states_seeded')
        .eq('id', workspaceId)
        .maybeSingle<{ skill_states_seeded: boolean }>(),
    ]);
    return { states, seeded: data?.skill_states_seeded ?? false, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[skill-state] activation context fetch failed:', message);
    return { states: new Map(), seeded: false, error: message };
  }
}

/** Admin-only — flip the enabled flag for a single skill. Caller revalidates UI paths. */
export async function setSkillEnabled(
  workspaceId: string,
  skillName: string,
  enabled: boolean,
  supabase: SupabaseClient<Database>,
  userId: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Split insert vs update so `created_by` is set only on the first insert —
  // a single `.upsert()` would `ON CONFLICT DO UPDATE SET created_by = …` and
  // overwrite the audit field with the last toggler on every flip.
  const update = await supabase
    .from('workspace_skill_states')
    .update({ enabled, updated_by: userId })
    .eq('workspace_id', workspaceId)
    .eq('skill_name', skillName)
    .select('id')
    .maybeSingle();
  if (update.error) return { ok: false, error: update.error.message };
  if (update.data) return { ok: true };

  const insert = await supabase.from('workspace_skill_states').insert({
    workspace_id: workspaceId,
    skill_name: skillName,
    enabled,
    created_by: userId,
    updated_by: userId,
  });
  if (insert.error) {
    // 23505 = unique_violation: a parallel insert won the race — retry as update.
    if (insert.error.code === '23505') {
      const retry = await supabase
        .from('workspace_skill_states')
        .update({ enabled, updated_by: userId })
        .eq('workspace_id', workspaceId)
        .eq('skill_name', skillName);
      if (retry.error) return { ok: false, error: retry.error.message };
      return { ok: true };
    }
    return { ok: false, error: insert.error.message };
  }
  return { ok: true };
}

/**
 * Sources the workspace implicitly consents to: shipped built-ins, skills the
 * user authored inside their own repo, and skills they uploaded directly
 * (PR 3). Sources requiring explicit opt-in (external-repo, skills-sh) stay
 * off until a row says otherwise — those are adversarial-by-default.
 */
const DEFAULT_ON_SOURCES = new Set<SkillSource>(['built-in', 'workspace-repo', 'disk']);

/**
 * Canonical "default-on" rule for skills without an explicit state row: the
 * implicit-consent sources default-on until the workspace has been seeded.
 * Lifted to its own helper so the page picker, the runtime filter, and the
 * workflow picker can't drift the way they did in #270 review finding #1.
 */
export function isSkillDefaultActive(source: SkillSource, workspaceSeeded: boolean): boolean {
  return !workspaceSeeded && DEFAULT_ON_SOURCES.has(source);
}

/**
 * Full activation predicate: a recorded `enabled` value wins; otherwise apply
 * the default-on rule. Used by `filterActiveSkills` (runtime) and
 * `listAvailableSkills` (workflow picker) — same answer in both places.
 */
export function isSkillActive(
  state: SkillState | undefined,
  source: SkillSource,
  workspaceSeeded: boolean,
): boolean {
  if (state) return state.enabled;
  return isSkillDefaultActive(source, workspaceSeeded);
}

/**
 * Filter a catalog down to the workspace's *active* skills. Used by the
 * workflow executor and the skill picker — keeps disabled skills from leaking
 * into runs even if a binding still references them.
 */
export function filterActiveSkills(
  catalog: Skill[],
  states: Map<string, SkillState>,
  workspaceSeeded: boolean,
): Skill[] {
  return catalog.filter((skill) =>
    isSkillActive(states.get(skill.name), skill.source, workspaceSeeded),
  );
}

/**
 * One-shot seed for fresh workspaces: writes an `enabled=true` row for every
 * implicit-consent skill (built-in + workspace-repo) currently in the
 * catalog, then marks the workspace as seeded so the lazy default doesn't
 * keep re-enabling skills the user later disabled.
 *
 * Idempotent: a workspace already marked seeded is a no-op. The param only
 * needs `name` + `source` — the body/path of each skill is irrelevant here,
 * so callers don't have to fabricate empty `Skill` objects.
 */
export async function seedBuiltinSkillStatesIfNeeded(
  workspaceId: string,
  workspaceSeeded: boolean,
  catalog: Array<{ name: string; source: SkillSource }>,
  supabase: SupabaseClient<Database>,
): Promise<{ seeded: boolean }> {
  if (workspaceSeeded) return { seeded: false };
  const defaults = catalog.filter((s) => DEFAULT_ON_SOURCES.has(s.source));
  // Skip the flag flip when the catalog carries no default-on skills — a
  // stale `repo_skills` row (or a pre-`source` rebuild whose entries all
  // normalize to a non-default source) would otherwise lock the workspace
  // into a "seeded" state with zero default-on skills. Next page load will
  // reach here again once the canonical sources are discovered.
  if (defaults.length === 0) return { seeded: false };
  const rows = defaults.map((s) => ({
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
    console.warn('[skill-state] default skill seed failed:', insertError.message);
    return { seeded: false };
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
