import type { SupabaseClient } from '@supabase/supabase-js';
import type { Skill, WorkflowBinding, WorkspaceWorkflowSettings } from '@cezar/core';
import { DEFAULT_WORKSPACE_WORKFLOW_SETTINGS } from '@cezar/core';
import { filterActiveSkills, getSkillActivationContext } from './skill-state';
import type { Database, WorkflowBackend } from './supabase/types';

const VALID_BACKENDS: WorkflowBackend[] = ['anthropic-api', 'claude-cli', 'codex-cli'];

/**
 * The subset of `workspaces` columns the workflow loaders read. When a caller
 * has already fetched the row (e.g. `executeWorkflowJob`), it can thread it
 * down so the loaders skip a redundant `SELECT … FROM workspaces`.
 */
export type WorkspaceWorkflowRow = Pick<
  Database['public']['Tables']['workspaces']['Row'],
  'auto_triage_enabled' | 'autofix_enabled' | 'separate_comment_per_step'
>;

/**
 * Loads the workspace's `workflow_bindings` rows (for this repo, plus the
 * repo-agnostic null-repo rows) as core `WorkflowBinding`s. Rows that set
 * nothing (skill/backend/model all null AND extra_tools empty) are dropped —
 * an empty binding is identical to "no binding", so it shouldn't shadow the
 * built-in default. The core orchestrator (Phase 1a) consumes these.
 */
export async function loadWorkflowBindings(
  workspaceId: string,
  supabase: SupabaseClient<Database>,
  repo?: string,
): Promise<WorkflowBinding[]> {
  let query = supabase
    .from('workflow_bindings')
    .select('repo, step_id, skill_name, backend, model, extra_tools')
    .eq('workspace_id', workspaceId);

  // null repo = applies to all repos; or an exact repo match.
  query = repo ? query.or(`repo.is.null,repo.eq.${repo}`) : query.is('repo', null);

  const { data, error } = await query;
  if (error || !data) return [];

  const bindings: WorkflowBinding[] = [];
  for (const row of data) {
    const extraTools = Array.isArray(row.extra_tools)
      ? (row.extra_tools as unknown[]).filter((t): t is string => typeof t === 'string')
      : [];
    const backend =
      typeof row.backend === 'string' && (VALID_BACKENDS as string[]).includes(row.backend)
        ? (row.backend as WorkflowBackend)
        : null;
    const skillName = row.skill_name ?? null;
    const model = row.model ?? null;
    // "use default" — nothing set: no row needed.
    if (!skillName && !backend && !model && extraTools.length === 0) continue;
    bindings.push({ stepId: row.step_id, skillName, backend, model, extraTools });
  }
  return bindings;
}

/**
 * Reads the three workflow toggle columns off the `workspaces` row, defaulting
 * via core. Pass `prefetched` to reuse an already-loaded row and skip the
 * `SELECT`.
 */
export async function loadWorkflowSettings(
  workspaceId: string,
  supabase: SupabaseClient<Database>,
  prefetched?: WorkspaceWorkflowRow | null,
): Promise<WorkspaceWorkflowSettings> {
  let data: WorkspaceWorkflowRow | null;
  if (prefetched !== undefined) {
    data = prefetched;
  } else {
    ({ data } = await supabase
      .from('workspaces')
      .select('auto_triage_enabled, autofix_enabled, separate_comment_per_step')
      .eq('id', workspaceId)
      .single());
  }

  if (!data) return { ...DEFAULT_WORKSPACE_WORKFLOW_SETTINGS };
  return {
    autoTriageEnabled: data.auto_triage_enabled ?? DEFAULT_WORKSPACE_WORKFLOW_SETTINGS.autoTriageEnabled,
    autofixEnabled: data.autofix_enabled ?? DEFAULT_WORKSPACE_WORKFLOW_SETTINGS.autofixEnabled,
    separateCommentPerStep:
      data.separate_comment_per_step ?? DEFAULT_WORKSPACE_WORKFLOW_SETTINGS.separateCommentPerStep,
  };
}

/**
 * Issue #262 — discover the workspace's full skill catalog, then narrow it to
 * the skills the user has marked active in `workspace_skill_states`. The
 * returned list is what the orchestrator/engine see at run time — disabled
 * skills are silently dropped (even when an old binding still references them).
 *
 * Returns `undefined` on discovery or DB failure (NOT an empty array) so the
 * orchestrator's `opts.skills ?? discoverSkillsSafe(...)` fallback fires and
 * the per-issue event stream sees a real failure log instead of a silent
 * zero-skill run.
 *
 * PR 2: also folds in cached external repo catalogs from `external_repo_skills`.
 * External rows hydrate from the DB only (body inline), so dispatch never
 * needs a clone of the external repo.
 */
export async function loadActiveSkillCatalog(
  workspaceId: string,
  repoRoot: string | null | undefined,
  skillsDir: string,
  supabase: SupabaseClient<Database>,
): Promise<Skill[] | undefined> {
  const core = await import('@cezar/core');
  let catalog: Skill[];
  try {
    catalog = repoRoot
      ? await core.discoverSkills(repoRoot, skillsDir)
      : await core.discoverBuiltinSkills();
  } catch (err) {
    console.warn('[workflow-config] discoverSkills failed:', err instanceof Error ? err.message : err);
    return undefined;
  }

  const [activation, externalSkills, uploadedSkills, skillsShSkills] = await Promise.all([
    getSkillActivationContext(workspaceId, supabase),
    loadExternalRepoSkills(workspaceId, supabase),
    loadUploadedSkills(workspaceId, supabase),
    loadSkillsShSkills(workspaceId, supabase),
  ]);
  if (activation.error) {
    // Surface the failure to the orchestrator so its `??` fallback to
    // `discoverSkillsSafe` fires (per-issue onEvent logging, no silent run).
    return undefined;
  }

  // SKILL_SOURCE_PRIORITY: built-in > workspace-repo > external-repo > disk > skills-sh.
  // The repo-side catalog already covers the first two; external rows go next,
  // then disk uploads, then skills.sh imports last. Each tier dedupes against
  // the names already taken.
  const taken = new Set(catalog.map((s) => s.name));
  for (const s of externalSkills) {
    if (taken.has(s.name)) continue;
    taken.add(s.name);
    catalog.push(s);
  }
  for (const s of uploadedSkills) {
    if (taken.has(s.name)) continue;
    taken.add(s.name);
    catalog.push(s);
  }
  for (const s of skillsShSkills) {
    if (taken.has(s.name)) continue;
    taken.add(s.name);
    catalog.push(s);
  }

  return filterActiveSkills(catalog, activation.states, activation.seeded);
}

interface CachedExternalSkill {
  name?: unknown;
  description?: unknown;
  suggestedStages?: unknown;
  path?: unknown;
  body?: unknown;
}

interface UploadedSkillDbRow {
  name: string;
  body: string;
  description: string | null;
  suggested_stages: unknown;
}

interface SkillsShDbRow {
  name: string;
  body: string;
  description: string | null;
  suggested_stages: unknown;
}

/**
 * Hydrate `skills_sh_skills` into `Skill` objects. Bodies live inline (the
 * skills.sh API returns them with the metadata), so dispatch never has to
 * call the registry at run time.
 */
async function loadSkillsShSkills(
  workspaceId: string,
  supabase: SupabaseClient<Database>,
): Promise<Skill[]> {
  const { data, error } = await supabase
    .from('skills_sh_skills')
    .select('name, body, description, suggested_stages')
    .eq('workspace_id', workspaceId)
    .returns<SkillsShDbRow[]>();
  if (error || !data) return [];
  return data.map<Skill>((row) => ({
    name: row.name,
    description: row.description ?? undefined,
    body: row.body ?? '',
    path: '',
    suggestedStages: Array.isArray(row.suggested_stages)
      ? (row.suggested_stages as unknown[]).filter((x): x is string => typeof x === 'string')
      : [],
    source: 'skills-sh',
  }));
}

/**
 * Hydrate `uploaded_skills` into `Skill` objects. Bodies live inline in this
 * table — no on-disk clone is ever consulted for disk skills.
 */
async function loadUploadedSkills(
  workspaceId: string,
  supabase: SupabaseClient<Database>,
): Promise<Skill[]> {
  const { data, error } = await supabase
    .from('uploaded_skills')
    .select('name, body, description, suggested_stages')
    .eq('workspace_id', workspaceId)
    .returns<UploadedSkillDbRow[]>();
  if (error || !data) return [];
  return data.map<Skill>((row) => ({
    name: row.name,
    description: row.description ?? undefined,
    body: row.body ?? '',
    path: '',
    suggestedStages: Array.isArray(row.suggested_stages)
      ? (row.suggested_stages as unknown[]).filter((x): x is string => typeof x === 'string')
      : [],
    source: 'disk',
  }));
}

/**
 * Hydrate the `external_repo_skills.skills` jsonb into proper `Skill` objects.
 * Filters out any cached row whose source has since been removed (RLS-joined
 * via the `skill_sources.workspace_id` predicate). Bodies live inline, so the
 * engine doesn't need an on-disk clone of the external repo.
 */
async function loadExternalRepoSkills(
  workspaceId: string,
  supabase: SupabaseClient<Database>,
): Promise<Skill[]> {
  const { data: sourceRows } = await supabase
    .from('skill_sources')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('kind', 'external-repo');
  if (!sourceRows || sourceRows.length === 0) return [];

  const sourceIds = sourceRows.map((r) => r.id);
  const { data: cacheRows } = await supabase
    .from('external_repo_skills')
    .select('source_id, skills')
    .in('source_id', sourceIds);
  if (!cacheRows) return [];

  const skills: Skill[] = [];
  const seen = new Set<string>();
  for (const row of cacheRows) {
    if (!Array.isArray(row.skills)) continue;
    for (const raw of row.skills as CachedExternalSkill[]) {
      if (!raw || typeof raw !== 'object') continue;
      const name = typeof raw.name === 'string' ? raw.name : null;
      const body = typeof raw.body === 'string' ? raw.body : null;
      if (!name || body === null) continue;
      // Two sources in the same workspace can ship the same skill name; first
      // hit wins. The /skills surface already disambiguates by source badge.
      if (seen.has(name)) continue;
      seen.add(name);
      skills.push({
        name,
        description: typeof raw.description === 'string' ? raw.description : undefined,
        body,
        path: typeof raw.path === 'string' ? raw.path : '',
        suggestedStages: Array.isArray(raw.suggestedStages)
          ? (raw.suggestedStages as unknown[]).filter((x): x is string => typeof x === 'string')
          : [],
        source: 'external-repo',
      });
    }
  }
  return skills;
}
