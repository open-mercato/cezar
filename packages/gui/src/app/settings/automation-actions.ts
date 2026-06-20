'use server';

import { revalidatePath } from 'next/cache';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getActiveWorkspace } from '@/lib/workspace';

export interface SaveAutomationState {
  ok?: boolean;
  error?: string;
}

/** Allowed automatic-sync cadences (minutes); floored at 5 (the cron tick). */
const SYNC_INTERVAL_MIN = 5;
const SYNC_INTERVAL_MAX = 1440;

/** Allowed digest cadences (minutes); floored at 15 — digests are LLM spend, so
 *  the minimum is coarser than the metadata-sync floor. */
const DIGEST_INTERVAL_MIN = 15;
const DIGEST_INTERVAL_MAX = 1440;

const DIGEST_MODES = ['auto', 'manual', 'off'] as const;

/**
 * The automation toggles on `workspaces`:
 *   - `auto_triage_enabled` — run the triage workflow on new/edited issues.
 *   - `autofix_enabled` — when a triage run routes to `autofix` (and the bug
 *     confidence clears the threshold), open a draft PR automatically.
 *   - `separate_comment_per_step` — render each workflow step as its own comment
 *     instead of one living comment.
 *   - `action_auto_comment` — post a summary comment after each action.
 *   - `sync_mode` / `sync_interval_minutes` — auto vs. manual GitHub sync and,
 *     for auto, the minimum gap between automatic syncs.
 *   - `digest_mode` / `digest_interval_minutes` — AI-digest cadence (spec §5),
 *     decoupled from metadata sync: auto (own cadence) / manual (on-demand) /
 *     off. Cheap metadata sync stays on `sync_interval_minutes` regardless.
 * Admin-only.
 */
export async function saveAutomationToggles(
  _prev: SaveAutomationState,
  formData: FormData,
): Promise<SaveAutomationState> {
  const workspace = await getActiveWorkspace();
  if (!workspace) return { error: 'No workspace selected' };
  if (workspace.role !== 'admin') return { error: 'Only admins can change automation settings' };

  const bool = (key: string): boolean => formData.get(key) === 'on' || formData.get(key) === 'true';

  const update: Record<string, unknown> = {
    auto_triage_enabled: bool('autoTriageEnabled'),
    autofix_enabled: bool('autofixEnabled'),
    separate_comment_per_step: bool('separateCommentPerStep'),
    action_auto_comment: bool('actionAutoComment'),
    sync_mode: bool('syncAuto') ? 'auto' : 'manual',
  };

  // The interval field is only rendered in auto mode; when present, clamp it to
  // the allowed range. When absent (manual), leave the stored value untouched.
  const rawInterval = formData.get('syncIntervalMinutes');
  if (rawInterval != null) {
    const parsed = Number(rawInterval);
    if (Number.isFinite(parsed)) {
      update.sync_interval_minutes = Math.min(
        SYNC_INTERVAL_MAX,
        Math.max(SYNC_INTERVAL_MIN, Math.round(parsed)),
      );
    }
  }

  // ── AI-digest cadence (spec §5) ──
  const rawDigestMode = formData.get('digestMode');
  if (
    typeof rawDigestMode === 'string' &&
    (DIGEST_MODES as readonly string[]).includes(rawDigestMode)
  ) {
    update.digest_mode = rawDigestMode;
  }
  // The digest-interval field is only rendered in `auto` mode; clamp when
  // present, leave the stored value untouched when hidden (manual/off) — mirrors
  // the sync_interval_minutes handling above.
  const rawDigestInterval = formData.get('digestIntervalMinutes');
  if (rawDigestInterval != null) {
    const parsed = Number(rawDigestInterval);
    if (Number.isFinite(parsed)) {
      update.digest_interval_minutes = Math.min(
        DIGEST_INTERVAL_MAX,
        Math.max(DIGEST_INTERVAL_MIN, Math.round(parsed)),
      );
    }
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from('workspaces').update(update).eq('id', workspace.id);
  if (error) return { error: error.message };

  revalidatePath('/settings');
  return { ok: true };
}
