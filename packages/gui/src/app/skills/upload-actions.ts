'use server';

import { revalidatePath } from 'next/cache';
import { parseSkillMarkdown } from '@cezar/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import type { Database } from '@/lib/supabase/types';

/**
 * Issue #262 (PR 3) — disk uploads as a skill source.
 *
 * The upload modal posts either a `files` FormData (drag-and-drop) or a
 * `{ name, body }` paste payload. Both flows go through `parseSkillMarkdown`
 * (shared with `discoverSkills`) so the YAML frontmatter rules stay identical
 * between dispatch-on-disk and disk uploads.
 */

export type ActionResult<T = {}> = (T & { ok: true }) | { ok: false; error: string };

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/i;
const MAX_BODY_BYTES = 100 * 1024;

export interface UploadFailure {
  filename: string;
  error: string;
}

export interface UploadFilesSummary {
  added: number;
  replaced: number;
  failed: UploadFailure[];
}

/**
 * Revalidate every surface that consumes uploaded skills:
 *   - `/skills` (list)
 *   - `/skills/[name]` (detail page — stale across tabs after re-upload)
 *   - `/workflows` layout (covers the dynamic `/workflows/[id]` editor whose
 *     `listAvailableSkills` picker now folds uploaded skills in)
 */
function revalidateUploadSurfaces(name?: string) {
  revalidatePath('/skills');
  if (name) revalidatePath(`/skills/${encodeURIComponent(name)}`);
  revalidatePath('/workflows', 'layout');
}

/**
 * First-install seed for `workspace_skill_states` so a freshly uploaded skill
 * shows up in the workflow picker and the dispatch catalog immediately —
 * without this the runtime would default-off for any workspace that's already
 * been seeded (the common case), and the admin would have to toggle the new
 * skill on at `/skills` before it does anything.
 *
 * `ignoreDuplicates: true` makes this seed-only: replacing a file the admin had
 * *disabled* preserves that choice instead of silently re-enabling it. This
 * matches the skills.sh refresh behaviour (`enableSkillsShSkillState`) — both
 * sources now preserve admin intent on re-sync (see issue #307).
 */
async function enableUploadedSkillState(
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
      pinned_source: 'disk',
      created_by: userId,
      updated_by: userId,
    },
    { onConflict: 'workspace_id,skill_name', ignoreDuplicates: true },
  );
}

/**
 * Accepts a FormData with one or more `file` entries (each a `.md` upload),
 * parses YAML frontmatter, and upserts into `uploaded_skills`. Errors per file
 * are returned in the summary so the user can fix the bad ones without losing
 * the good ones.
 */
export async function uploadSkillsFromFiles(
  formData: FormData,
): Promise<ActionResult<UploadFilesSummary>> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: 'Not authenticated' };
  const workspace = await getActiveWorkspace();
  if (!workspace) return { ok: false, error: 'No workspace selected' };
  if (workspace.role !== 'admin') {
    return { ok: false, error: 'Only admins can upload skills' };
  }

  const files = formData.getAll('files').filter((entry): entry is File => entry instanceof File);
  if (files.length === 0) return { ok: false, error: 'no files provided' };

  const supabase = createSupabaseAdminClient();

  const summary: UploadFilesSummary = { added: 0, replaced: 0, failed: [] };
  // Look up existing names once so we can report `added` vs. `replaced`
  // without round-tripping per upload.
  const { data: existingRows } = await supabase
    .from('uploaded_skills')
    .select('name')
    .eq('workspace_id', workspace.id);
  const existingNames = new Set((existingRows ?? []).map((r) => r.name));

  // Track names already upserted in THIS batch so a second file with the same
  // resolved name doesn't silently clobber the first (and we surface a
  // 'duplicate within batch' failure on the second file).
  const batchNames = new Set<string>();
  const upsertedNames: string[] = [];

  for (const file of files) {
    const filename = file.name || 'untitled.md';
    if (file.size > MAX_BODY_BYTES) {
      summary.failed.push({ filename, error: `body exceeds ${MAX_BODY_BYTES / 1024}KB limit` });
      continue;
    }
    let raw: string;
    try {
      raw = await file.text();
    } catch (err) {
      summary.failed.push({
        filename,
        error: `read failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    const fallbackName = filename.replace(/\.md$/i, '');
    const parsed = parseSkillMarkdown(raw, fallbackName);
    if (!parsed.name) {
      summary.failed.push({
        filename,
        error: 'no `name` in frontmatter and filename was unusable',
      });
      continue;
    }
    if (!NAME_PATTERN.test(parsed.name)) {
      summary.failed.push({
        filename,
        error: `name "${parsed.name}" must be alphanumeric + \`-\`/\`_\` (max 63 chars)`,
      });
      continue;
    }
    if (!parsed.body.trim()) {
      summary.failed.push({ filename, error: 'body is empty' });
      continue;
    }
    // After-parse byte-size check: frontmatter is stripped but the body still
    // needs to fit. `Buffer.byteLength` measures real UTF-8 bytes — `.length`
    // would let multi-byte glyphs (emoji, CJK) blow past the cap.
    if (Buffer.byteLength(parsed.body, 'utf8') > MAX_BODY_BYTES) {
      summary.failed.push({ filename, error: `body exceeds ${MAX_BODY_BYTES / 1024}KB limit` });
      continue;
    }
    if (batchNames.has(parsed.name)) {
      summary.failed.push({
        filename,
        error: `duplicate of "${parsed.name}" already in this batch — only the first file was uploaded`,
      });
      continue;
    }
    batchNames.add(parsed.name);

    const wasExisting = existingNames.has(parsed.name);
    const { error: upsertError } = await supabase.from('uploaded_skills').upsert(
      {
        workspace_id: workspace.id,
        name: parsed.name,
        body: parsed.body,
        description: parsed.description ?? null,
        suggested_stages: parsed.suggestedStages,
        uploaded_by: user.id,
        updated_by: user.id,
      },
      { onConflict: 'workspace_id,name' },
    );
    if (upsertError) {
      summary.failed.push({ filename, error: upsertError.message });
      continue;
    }
    await enableUploadedSkillState(supabase, workspace.id, parsed.name, user.id);
    upsertedNames.push(parsed.name);
    if (wasExisting) summary.replaced += 1;
    else {
      summary.added += 1;
      existingNames.add(parsed.name);
    }
  }

  revalidateUploadSurfaces();
  for (const name of upsertedNames) {
    revalidatePath(`/skills/${encodeURIComponent(name)}`);
  }
  return { ok: true, ...summary };
}

export interface UploadFromTextInput {
  /** Optional — when omitted, must be present in the markdown's frontmatter. */
  name?: string;
  body: string;
}

/**
 * Paste-from-textarea fallback. Mirrors the per-file branch of
 * `uploadSkillsFromFiles` but expects a single payload and returns a clearer
 * error when the name can't be resolved.
 */
export async function uploadSkillFromText(
  input: UploadFromTextInput,
): Promise<ActionResult<{ name: string; replaced: boolean }>> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: 'Not authenticated' };
  const workspace = await getActiveWorkspace();
  if (!workspace) return { ok: false, error: 'No workspace selected' };
  if (workspace.role !== 'admin') {
    return { ok: false, error: 'Only admins can upload skills' };
  }

  if (!input.body || !input.body.trim()) return { ok: false, error: 'body is empty' };
  // Use UTF-8 byte length — `.length` counts code units, so a body packed with
  // 4-byte glyphs could be 4× the intended size before tripping the cap.
  if (Buffer.byteLength(input.body, 'utf8') > MAX_BODY_BYTES) {
    return { ok: false, error: `body exceeds ${MAX_BODY_BYTES / 1024}KB limit` };
  }

  const parsed = parseSkillMarkdown(input.body, input.name?.trim() || undefined);
  if (!parsed.name) {
    return {
      ok: false,
      error: 'name is required — set `name:` in frontmatter or fill the Name field',
    };
  }
  if (!NAME_PATTERN.test(parsed.name)) {
    return { ok: false, error: 'name must be alphanumeric + `-`/`_` (max 63 chars)' };
  }
  if (!parsed.body.trim()) return { ok: false, error: 'body is empty' };
  if (Buffer.byteLength(parsed.body, 'utf8') > MAX_BODY_BYTES) {
    return { ok: false, error: `body exceeds ${MAX_BODY_BYTES / 1024}KB limit` };
  }

  const supabase = createSupabaseAdminClient();
  const { data: existing } = await supabase
    .from('uploaded_skills')
    .select('id')
    .eq('workspace_id', workspace.id)
    .eq('name', parsed.name)
    .maybeSingle<{ id: string }>();

  const { error: upsertError } = await supabase.from('uploaded_skills').upsert(
    {
      workspace_id: workspace.id,
      name: parsed.name,
      body: parsed.body,
      description: parsed.description ?? null,
      suggested_stages: parsed.suggestedStages,
      uploaded_by: user.id,
      updated_by: user.id,
    },
    { onConflict: 'workspace_id,name' },
  );
  if (upsertError) return { ok: false, error: upsertError.message };
  await enableUploadedSkillState(supabase, workspace.id, parsed.name, user.id);

  revalidateUploadSurfaces(parsed.name);
  return { ok: true, name: parsed.name, replaced: existing !== null };
}

export async function removeUploadedSkill(name: string): Promise<ActionResult> {
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
  revalidateUploadSurfaces(name);
  return { ok: true };
}
