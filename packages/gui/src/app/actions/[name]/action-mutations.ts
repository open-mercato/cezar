'use server';

import { revalidatePath } from 'next/cache';
import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import {
  isAcceptanceMode,
  isActionModel,
  validateConfidenceConfig,
  type AcceptanceMode,
  type ActionModel,
  type ConfidenceConfig,
} from './acceptance-types';

export interface ActionPayload {
  description: string | null;
  systemPrompt: string;
  skillRefs: string[];
  target: 'issue' | 'pr';
  triggers: string[];
  /** null → tool-use mode; non-null array → declared mode. */
  effects: string[] | null;
  /** JSON-encoded schema; empty string clears the field. */
  outputSchema: string;
  model: ActionModel;
  acceptanceMode: AcceptanceMode;
  confidenceConfig: ConfidenceConfig;
}

export interface SaveActionResult {
  ok: boolean;
  error?: string;
  updatedAt?: string;
  enabled?: boolean;
}

export interface SkillSuggestion {
  name: string;
  description: string | null;
  source: 'built-in' | 'repo' | 'override';
}

async function requireAdminWorkspace() {
  const user = await getSessionUser();
  if (!user) return { error: 'Not authenticated' as const };
  const workspace = await getActiveWorkspace();
  if (!workspace) return { error: 'No workspace selected' as const };
  if (workspace.role !== 'admin') return { error: 'Only admins can edit actions' as const };
  return { user, workspace };
}

function revalidateAction(name: string) {
  revalidatePath('/actions');
  revalidatePath(`/actions/${encodeURIComponent(name)}`);
}

interface ResolvedRow {
  id: string;
  kind: 'built-in' | 'user';
  enabled: boolean;
}

async function loadCurrentRows(workspaceId: string, name: string): Promise<{ user: ResolvedRow | null; builtin: ResolvedRow | null }> {
  const supabase = createSupabaseAdminClient();
  const { data } = await supabase
    .from('actions')
    .select('id, kind, enabled')
    .eq('workspace_id', workspaceId)
    .eq('name', name);
  const rows = (data ?? []) as ResolvedRow[];
  return {
    user: rows.find((r) => r.kind === 'user') ?? null,
    builtin: rows.find((r) => r.kind === 'built-in') ?? null,
  };
}

function parseOutputSchema(raw: string): { ok: true; value: Record<string, unknown> | null } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed === null) return { ok: true, value: null };
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'output_schema must be a JSON object' };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (err) {
    return { ok: false, error: `Invalid JSON in output_schema: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Full-payload save. When the existing row is `kind='built-in'`, we never
 * mutate it — instead we insert (or update) a sibling `kind='user'` row that
 * shadows the built-in. Pure user actions update in place.
 */
export async function saveAction(
  name: string,
  payload: ActionPayload,
  options: { enable?: boolean } = {},
): Promise<SaveActionResult> {
  const auth = await requireAdminWorkspace();
  if ('error' in auth) return { ok: false, error: auth.error };
  const { user, workspace } = auth;

  const schemaParse = parseOutputSchema(payload.outputSchema);
  if (!schemaParse.ok) return { ok: false, error: schemaParse.error };

  if (!isActionModel(payload.model)) return { ok: false, error: 'Unknown model' };
  if (!isAcceptanceMode(payload.acceptanceMode)) return { ok: false, error: 'Unknown acceptance mode' };
  const confidenceParse = validateConfidenceConfig(payload.acceptanceMode, payload.confidenceConfig);
  if (!confidenceParse.ok) return { ok: false, error: confidenceParse.error };

  const supabase = createSupabaseAdminClient();
  const current = await loadCurrentRows(workspace.id, name);

  // When the caller omits `enable`, preserve the current effective enabled
  // state instead of force-writing `true` — otherwise editing any field would
  // silently re-enable a disabled action.
  const currentEnabled = current.user?.enabled ?? current.builtin?.enabled ?? true;

  const baseFields = {
    description: payload.description ?? null,
    system_prompt: payload.systemPrompt,
    skill_refs: payload.skillRefs,
    target: payload.target,
    triggers: payload.triggers,
    effects: payload.effects,
    output_schema: schemaParse.value,
    enabled: options.enable ?? currentEnabled,
    updated_by: user.id,
    model: payload.model,
    acceptance_mode: payload.acceptanceMode,
    confidence_config: confidenceParse.value,
  };

  if (current.user) {
    const { data, error } = await supabase
      .from('actions')
      .update(baseFields)
      .eq('id', current.user.id)
      .select('updated_at, enabled')
      .single();
    if (error) return { ok: false, error: error.message };
    revalidateAction(name);
    return { ok: true, updatedAt: data?.updated_at ?? undefined, enabled: data?.enabled ?? baseFields.enabled };
  }

  // No user row yet — insert one. If a built-in exists with this name, mark
  // the new user row as a replacement so the UI can show provenance.
  const { data, error } = await supabase
    .from('actions')
    .insert({
      workspace_id: workspace.id,
      name,
      kind: 'user',
      replaces_built_in: current.builtin ? name : null,
      created_by: user.id,
      ...baseFields,
    })
    .select('updated_at, enabled')
    .single();
  if (error) return { ok: false, error: error.message };
  revalidateAction(name);
  return { ok: true, updatedAt: data?.updated_at ?? undefined, enabled: data?.enabled ?? baseFields.enabled };
}

/**
 * Body-only autosave for the system prompt. Same as `saveAction` but only
 * touches `system_prompt`, and creates a user override carrying the current
 * metadata from the built-in (when one exists) so the new row is functional
 * on its own.
 */
export async function autosaveActionPrompt(
  name: string,
  systemPrompt: string,
): Promise<SaveActionResult> {
  const auth = await requireAdminWorkspace();
  if ('error' in auth) return { ok: false, error: auth.error };
  const { user, workspace } = auth;

  const supabase = createSupabaseAdminClient();
  const current = await loadCurrentRows(workspace.id, name);

  if (current.user) {
    const { data, error } = await supabase
      .from('actions')
      .update({ system_prompt: systemPrompt, updated_by: user.id })
      .eq('id', current.user.id)
      .select('updated_at, enabled')
      .single();
    if (error) return { ok: false, error: error.message };
    revalidateAction(name);
    return { ok: true, updatedAt: data?.updated_at ?? undefined, enabled: data?.enabled ?? true };
  }

  // Need to clone the built-in into a user row before mutating.
  if (!current.builtin) {
    return { ok: false, error: `No action named ${name} in this workspace` };
  }
  const { data: source, error: sourceErr } = await supabase
    .from('actions')
    .select(
      'description, skill_refs, target, triggers, effects, output_schema, enabled, model, acceptance_mode, confidence_config',
    )
    .eq('id', current.builtin.id)
    .single();
  if (sourceErr || !source) {
    return { ok: false, error: sourceErr?.message ?? 'Could not load built-in to override' };
  }

  const { data, error } = await supabase
    .from('actions')
    .insert({
      workspace_id: workspace.id,
      name,
      kind: 'user',
      replaces_built_in: name,
      description: source.description,
      system_prompt: systemPrompt,
      skill_refs: source.skill_refs,
      target: source.target,
      triggers: source.triggers,
      effects: source.effects,
      output_schema: source.output_schema,
      enabled: source.enabled,
      model: source.model,
      acceptance_mode: source.acceptance_mode,
      confidence_config: source.confidence_config,
      created_by: user.id,
      updated_by: user.id,
    })
    .select('updated_at, enabled')
    .single();
  if (error) return { ok: false, error: error.message };
  revalidateAction(name);
  return { ok: true, updatedAt: data?.updated_at ?? undefined, enabled: data?.enabled ?? true };
}

/**
 * Toggle the action's enabled state. Mirrors `saveAction`'s built-in policy:
 * disabling/enabling a built-in clones it into a user row first.
 */
export async function setActionEnabled(
  name: string,
  enabled: boolean,
): Promise<SaveActionResult> {
  const auth = await requireAdminWorkspace();
  if ('error' in auth) return { ok: false, error: auth.error };
  const { user, workspace } = auth;

  const supabase = createSupabaseAdminClient();
  const current = await loadCurrentRows(workspace.id, name);

  if (current.user) {
    const { data, error } = await supabase
      .from('actions')
      .update({ enabled, updated_by: user.id })
      .eq('id', current.user.id)
      .select('updated_at, enabled')
      .single();
    if (error) return { ok: false, error: error.message };
    revalidateAction(name);
    return { ok: true, updatedAt: data?.updated_at ?? undefined, enabled: data?.enabled ?? enabled };
  }

  if (!current.builtin) {
    return { ok: false, error: `No action named ${name} in this workspace` };
  }
  const { data: source, error: sourceErr } = await supabase
    .from('actions')
    .select(
      'description, system_prompt, skill_refs, target, triggers, effects, output_schema, model, acceptance_mode, confidence_config',
    )
    .eq('id', current.builtin.id)
    .single();
  if (sourceErr || !source) {
    return { ok: false, error: sourceErr?.message ?? 'Could not load built-in to override' };
  }

  const { data, error } = await supabase
    .from('actions')
    .insert({
      workspace_id: workspace.id,
      name,
      kind: 'user',
      replaces_built_in: name,
      description: source.description,
      system_prompt: source.system_prompt,
      skill_refs: source.skill_refs,
      target: source.target,
      triggers: source.triggers,
      effects: source.effects,
      output_schema: source.output_schema,
      enabled,
      model: source.model,
      acceptance_mode: source.acceptance_mode,
      confidence_config: source.confidence_config,
      created_by: user.id,
      updated_by: user.id,
    })
    .select('updated_at, enabled')
    .single();
  if (error) return { ok: false, error: error.message };
  revalidateAction(name);
  return { ok: true, updatedAt: data?.updated_at ?? undefined, enabled: data?.enabled ?? enabled };
}

/**
 * Delete the user row for this action name. Built-in rows can never be
 * deleted — running this against a built-in-only action errors out.
 */
export async function deleteAction(name: string): Promise<SaveActionResult> {
  const auth = await requireAdminWorkspace();
  if ('error' in auth) return { ok: false, error: auth.error };
  const { workspace } = auth;

  const supabase = createSupabaseAdminClient();
  const current = await loadCurrentRows(workspace.id, name);
  if (!current.user) {
    return { ok: false, error: 'No user override exists for this action' };
  }
  const { error } = await supabase
    .from('actions')
    .delete()
    .eq('id', current.user.id);
  if (error) return { ok: false, error: error.message };
  revalidateAction(name);
  return { ok: true };
}

/**
 * Point `workspaces.auto_triage_action_id` at the supplied action, or null
 * to clear the assignment. Caller is responsible for picking an
 * `issue`-targeted action when setting.
 */
export async function setAutoTriage(actionId: string | null): Promise<SaveActionResult> {
  const auth = await requireAdminWorkspace();
  if ('error' in auth) return { ok: false, error: auth.error };
  const { workspace } = auth;

  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from('workspaces')
    .update({ auto_triage_action_id: actionId })
    .eq('id', workspace.id);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/actions');
  revalidatePath('/settings');
  return { ok: true };
}

export async function clearAutoTriage(): Promise<SaveActionResult> {
  return setAutoTriage(null);
}

interface SourceActionFields {
  description: string | null;
  system_prompt: string;
  skill_refs: unknown;
  target: 'issue' | 'pr';
  triggers: unknown;
  effects: unknown;
  output_schema: unknown;
  model: string;
  acceptance_mode: string;
  confidence_config: unknown;
}

/**
 * Create a `kind='user'` sibling of a built-in action, copying all editable
 * fields and tagging the new row with `replaces_built_in = name`. Fails if
 * no built-in exists for the name, or if a user override already does.
 * Returns the new row's name (same as the built-in) so the caller can
 * navigate to its detail page.
 */
export async function overrideBuiltInAction(
  name: string,
): Promise<SaveActionResult & { slug?: string }> {
  const auth = await requireAdminWorkspace();
  if ('error' in auth) return { ok: false, error: auth.error };
  const { user, workspace } = auth;

  const supabase = createSupabaseAdminClient();
  const current = await loadCurrentRows(workspace.id, name);
  if (!current.builtin) return { ok: false, error: `No built-in action named ${name}` };
  if (current.user) return { ok: false, error: 'A user override already exists for this action' };

  const { data: source, error: sourceErr } = await supabase
    .from('actions')
    .select('description, system_prompt, skill_refs, target, triggers, effects, output_schema, model, acceptance_mode, confidence_config')
    .eq('id', current.builtin.id)
    .single<SourceActionFields>();
  if (sourceErr || !source) {
    return { ok: false, error: sourceErr?.message ?? 'Could not load built-in to override' };
  }

  const { data, error } = await supabase
    .from('actions')
    .insert({
      workspace_id: workspace.id,
      name,
      kind: 'user',
      replaces_built_in: name,
      description: source.description,
      system_prompt: source.system_prompt,
      skill_refs: source.skill_refs as never,
      target: source.target,
      triggers: source.triggers as never,
      effects: source.effects as never,
      output_schema: source.output_schema as never,
      enabled: true,
      model: source.model,
      acceptance_mode: source.acceptance_mode,
      confidence_config: source.confidence_config as never,
      created_by: user.id,
      updated_by: user.id,
    })
    .select('updated_at')
    .single();
  if (error) return { ok: false, error: error.message };
  revalidateAction(name);
  return { ok: true, updatedAt: data?.updated_at ?? undefined, slug: name };
}

/**
 * Delete the user override row for a built-in, restoring the built-in's
 * stored configuration as the live row.
 */
export async function resetBuiltInToDefault(name: string): Promise<SaveActionResult> {
  const auth = await requireAdminWorkspace();
  if ('error' in auth) return { ok: false, error: auth.error };
  const { workspace } = auth;

  const supabase = createSupabaseAdminClient();
  const current = await loadCurrentRows(workspace.id, name);
  if (!current.user) return { ok: false, error: 'No user override exists for this action' };
  if (!current.builtin) return { ok: false, error: 'No built-in to restore — use Delete instead' };

  const { error } = await supabase
    .from('actions')
    .delete()
    .eq('id', current.user.id);
  if (error) return { ok: false, error: error.message };
  revalidateAction(name);
  return { ok: true };
}

/**
 * Clone an action (built-in or user) as a fresh `kind='user'` row with a
 * `-copy[-N]` suffix that doesn't collide with the existing user rows.
 * Returns the new row's name so the caller can navigate to its detail page.
 */
export async function duplicateAction(name: string): Promise<SaveActionResult & { newName?: string }> {
  const auth = await requireAdminWorkspace();
  if ('error' in auth) return { ok: false, error: auth.error };
  const { user, workspace } = auth;

  const supabase = createSupabaseAdminClient();
  const current = await loadCurrentRows(workspace.id, name);
  const sourceRow = current.user ?? current.builtin;
  if (!sourceRow) return { ok: false, error: `No action named ${name} in this workspace` };

  const { data: source, error: sourceErr } = await supabase
    .from('actions')
    .select('description, system_prompt, skill_refs, target, triggers, effects, output_schema, model, acceptance_mode, confidence_config')
    .eq('id', sourceRow.id)
    .single<SourceActionFields>();
  if (sourceErr || !source) {
    return { ok: false, error: sourceErr?.message ?? 'Could not load source action to duplicate' };
  }

  const { data: existing } = await supabase
    .from('actions')
    .select('name, kind')
    .eq('workspace_id', workspace.id)
    .like('name', `${name}-copy%`);
  const takenUserNames = new Set(
    (existing ?? [])
      .filter((r) => r.kind === 'user')
      .map((r) => r.name as string),
  );

  let candidate = `${name}-copy`;
  let suffix = 2;
  while (takenUserNames.has(candidate)) {
    candidate = `${name}-copy-${suffix}`;
    suffix += 1;
  }

  const { error } = await supabase
    .from('actions')
    .insert({
      workspace_id: workspace.id,
      name: candidate,
      kind: 'user',
      replaces_built_in: null,
      description: source.description,
      system_prompt: source.system_prompt,
      skill_refs: source.skill_refs as never,
      target: source.target,
      triggers: source.triggers as never,
      effects: source.effects as never,
      output_schema: source.output_schema as never,
      enabled: true,
      model: source.model,
      acceptance_mode: source.acceptance_mode,
      confidence_config: source.confidence_config as never,
      created_by: user.id,
      updated_by: user.id,
    });
  if (error) return { ok: false, error: error.message };
  revalidatePath('/actions');
  revalidatePath(`/actions/${encodeURIComponent(candidate)}`);
  return { ok: true, newName: candidate };
}

/**
 * Lightweight autocomplete over the workspace's cached skill catalog.
 */
export async function searchSkills(query: string): Promise<SkillSuggestion[]> {
  const q = query.trim().toLowerCase();
  const workspace = await getActiveWorkspace();
  if (!workspace) return [];

  const supabase = createSupabaseAdminClient();
  const { data } = await supabase
    .from('repo_skills')
    .select('skills')
    .eq('workspace_id', workspace.id)
    .eq('repo', workspace.repoName)
    .maybeSingle<{ skills: unknown }>();

  const arr = Array.isArray(data?.skills) ? (data!.skills as Array<Record<string, unknown>>) : [];
  const items: SkillSuggestion[] = arr
    .map((s) => {
      const name = typeof s.name === 'string' ? s.name : null;
      if (!name) return null;
      const description = typeof s.description === 'string' ? s.description : null;
      const source = (s.source as SkillSuggestion['source']) ?? 'built-in';
      return { name, description, source };
    })
    .filter((s): s is SkillSuggestion => s !== null);

  if (q.length === 0) return items.slice(0, 20);
  return items
    .filter((s) => `${s.name} ${s.description ?? ''}`.toLowerCase().includes(q))
    .slice(0, 20);
}
