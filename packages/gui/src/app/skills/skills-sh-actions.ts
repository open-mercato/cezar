'use server';

import { revalidatePath } from 'next/cache';
import { parseSkillMarkdown } from '@cezar/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import type { Database } from '@/lib/supabase/types';
import {
  fetchSkillsShSkill,
  parseSkillsShIdentifier,
  SkillsShAuthError,
  SkillsShNotConfiguredError,
  SkillsShNotFoundError,
  SkillsShPayloadTooLargeError,
  SkillsShTimeoutError,
  type SkillsShSkill,
} from '@/lib/skills-sh-api';

/**
 * Issue #262 (PR 4) — install / refresh / remove for skills.sh imports.
 *
 * The API gives us a skill record with its body inline; we persist it into
 * `skills_sh_skills` so dispatch reads bodies from the DB without ever
 * touching skills.sh at run time. Refresh compares the API's `contentHash`
 * to short-circuit when nothing changed.
 */

export type ActionResult<T = {}> = (T & { ok: true }) | { ok: false; error: string };

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/i;
const MAX_BODY_BYTES = 100 * 1024;

interface InstallSummary {
  slug: string;
  name: string;
  replaced: boolean;
}

function describeError(err: unknown): string {
  if (err instanceof SkillsShNotConfiguredError) {
    return 'skills.sh requires SKILLS_SH_TOKEN in env';
  }
  if (err instanceof SkillsShAuthError) {
    return 'skills.sh rejected the token — refresh SKILLS_SH_TOKEN';
  }
  if (err instanceof SkillsShNotFoundError) {
    return err.message;
  }
  if (err instanceof SkillsShTimeoutError || err instanceof SkillsShPayloadTooLargeError) {
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Revalidate every surface that consumes the skills.sh catalog:
 *   - `/skills` list
 *   - `/skills/[name]` detail page
 *   - `/workflows` layout (covers the dynamic `/workflows/[id]` editor whose
 *     `listAvailableSkills` picker now folds in skills.sh imports)
 */
function revalidateSkillsShSurfaces(name?: string) {
  revalidatePath('/skills');
  if (name) revalidatePath(`/skills/${encodeURIComponent(name)}`);
  revalidatePath('/workflows', 'layout');
}

/**
 * Match Postgres unique_violation (23505) to a friendly message. The table
 * declares unique constraints on BOTH (workspace_id, source_slug) AND
 * (workspace_id, name); persistSkill resolves conflicts on source_slug only,
 * so a cross-slug name collision still surfaces as a raw 23505.
 */
function describeUpsertError(err: { code?: string; message?: string }, finalName: string): string {
  if (err.code === '23505' && err.message?.includes('workspace_id_name')) {
    return `a skill named "${finalName}" is already imported from a different skills.sh source — remove the existing one first`;
  }
  return err.message ?? 'database upsert failed';
}

/**
 * First-install seed for `workspace_skill_states` so a freshly imported
 * skills.sh skill is immediately visible in the workflow picker and dispatch.
 * Skipped on Refresh — `existed === true` means the admin already chose an
 * enabled/disabled state at some point, which we must preserve.
 */
async function enableSkillsShSkillState(
  supabase: SupabaseClient<Database>,
  workspaceId: string,
  skillName: string,
  userId: string,
) {
  await supabase.from('workspace_skill_states').upsert(
    {
      workspace_id: workspaceId,
      skill_name: skillName,
      enabled: true,
      pinned_source: 'skills-sh',
      created_by: userId,
      updated_by: userId,
    },
    { onConflict: 'workspace_id,skill_name', ignoreDuplicates: true },
  );
}

async function persistSkill(
  workspaceId: string,
  userId: string,
  slug: string,
  api: SkillsShSkill,
  supabase: SupabaseClient<Database>,
): Promise<ActionResult<InstallSummary>> {
  // Pull `cezar-stages` and a friendlier name out of the body's frontmatter,
  // falling back to the API's name if the body has none.
  const parsed = parseSkillMarkdown(api.body, api.name);
  const finalName = (parsed.name ?? api.name).trim();
  if (!NAME_PATTERN.test(finalName)) {
    return {
      ok: false,
      error: `name "${finalName}" must be alphanumeric + \`-\`/\`_\` (max 63 chars)`,
    };
  }
  // Belt-and-braces against a compromised / oversized registry response —
  // mirrors the PR3 cap on disk uploads. Buffer.byteLength counts UTF-8
  // bytes, not UTF-16 code units, so multi-byte glyphs can't slip past.
  if (Buffer.byteLength(api.body, 'utf8') > MAX_BODY_BYTES) {
    return {
      ok: false,
      error: `skill body exceeds ${MAX_BODY_BYTES / 1024}KB — skills.sh payload too large`,
    };
  }

  const { data: existing } = await supabase
    .from('skills_sh_skills')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('source_slug', slug)
    .maybeSingle<{ id: string }>();

  const { error } = await supabase.from('skills_sh_skills').upsert(
    {
      workspace_id: workspaceId,
      source_slug: slug,
      name: finalName,
      body: api.body,
      description: parsed.description ?? api.description ?? null,
      suggested_stages: parsed.suggestedStages,
      content_hash: api.contentHash,
      install_url: api.installUrl,
      last_synced_at: new Date().toISOString(),
      last_sync_error: null,
      imported_by: userId,
    },
    { onConflict: 'workspace_id,source_slug' },
  );
  if (error) return { ok: false, error: describeUpsertError(error, finalName) };

  // Only seed the activation row on first install. On Refresh we must
  // preserve whatever enabled/disabled state the admin set in the meantime.
  if (!existing) {
    await enableSkillsShSkillState(supabase, workspaceId, finalName, userId);
  }

  return { ok: true, slug, name: finalName, replaced: existing !== null };
}

export async function addSkillsShSkill(input: {
  identifier: string;
}): Promise<ActionResult<InstallSummary>> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: 'Not authenticated' };
  const workspace = await getActiveWorkspace();
  if (!workspace) return { ok: false, error: 'No workspace selected' };
  if (workspace.role !== 'admin') {
    return { ok: false, error: 'Only admins can install skills.sh skills' };
  }
  const slug = parseSkillsShIdentifier(input.identifier);
  if (!slug) {
    return { ok: false, error: 'invalid identifier — expected `source/slug` or skills.sh URL' };
  }

  let api: SkillsShSkill;
  try {
    api = await fetchSkillsShSkill(slug);
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }

  const supabase = createSupabaseAdminClient();
  const persisted = await persistSkill(workspace.id, user.id, slug, api, supabase);
  if (persisted.ok) revalidateSkillsShSurfaces(persisted.name);
  return persisted;
}

export async function refreshSkillsShSkill(
  id: string,
): Promise<ActionResult<{ slug: string; changed: boolean }>> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: 'Not authenticated' };
  const workspace = await getActiveWorkspace();
  if (!workspace) return { ok: false, error: 'No workspace selected' };
  if (workspace.role !== 'admin') {
    return { ok: false, error: 'Only admins can refresh skills.sh skills' };
  }

  const supabase = createSupabaseAdminClient();
  const { data: row, error: loadError } = await supabase
    .from('skills_sh_skills')
    .select('source_slug, content_hash, name')
    .eq('id', id)
    .eq('workspace_id', workspace.id)
    .single();
  if (loadError || !row) return { ok: false, error: loadError?.message ?? 'skill not found' };

  let api: SkillsShSkill;
  try {
    api = await fetchSkillsShSkill(row.source_slug);
  } catch (err) {
    const message = describeError(err);
    await supabase
      .from('skills_sh_skills')
      .update({ last_sync_error: message })
      .eq('id', id)
      .eq('workspace_id', workspace.id);
    return { ok: false, error: message };
  }

  const sameHash =
    api.contentHash !== null && row.content_hash !== null && api.contentHash === row.content_hash;
  if (sameHash) {
    await supabase
      .from('skills_sh_skills')
      .update({ last_synced_at: new Date().toISOString(), last_sync_error: null })
      .eq('id', id)
      .eq('workspace_id', workspace.id);
    revalidateSkillsShSurfaces(row.name);
    return { ok: true, slug: row.source_slug, changed: false };
  }

  const persisted = await persistSkill(workspace.id, user.id, row.source_slug, api, supabase);
  if (!persisted.ok) return persisted;
  // Surface both the old and the new name (rename case) so revalidatePath
  // hits the right detail route after an upstream rename.
  revalidateSkillsShSurfaces(persisted.name);
  if (persisted.name !== row.name) {
    revalidatePath(`/skills/${encodeURIComponent(row.name)}`);
  }
  return { ok: true, slug: row.source_slug, changed: true };
}

export async function removeSkillsShSkill(id: string): Promise<ActionResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: 'Not authenticated' };
  const workspace = await getActiveWorkspace();
  if (!workspace) return { ok: false, error: 'No workspace selected' };
  if (workspace.role !== 'admin') {
    return { ok: false, error: 'Only admins can remove skills.sh imports' };
  }

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from('skills_sh_skills')
    .delete()
    .eq('id', id)
    .eq('workspace_id', workspace.id)
    .select('name')
    .maybeSingle<{ name: string }>();
  if (error) return { ok: false, error: error.message };
  // Stale id or cross-workspace target: predicate matched zero rows. Surface
  // as a real error so the UI doesn't show 'removed' on a silent no-op.
  if (!data) return { ok: false, error: 'skills.sh import not found' };

  revalidateSkillsShSurfaces(data.name);
  return { ok: true };
}
