import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from './supabase/types';

const KB_LIMIT = 100;

/**
 * Context-provider map handed to `runAction` / `runTriagePass` — resolved by
 * the core runner against each action's `contextRefs` (so providers are only
 * queried when an action actually declares the ref).
 *
 * `open-issues`: the open-issue knowledge base for the dedupe half of
 * `auto-triage` — open issues from the workspace's `issues` table that are
 * lower-numbered than the target (matching the dedupe rule that the original
 * is the lower-numbered issue), newest first, capped at 100. Summaries prefer
 * the cached digest summary and fall back to the issue body.
 */
export function buildOpenIssuesContextProviders(
  supabase: SupabaseClient<Database>,
  workspaceId: string,
  targetNumber: number,
): Record<string, () => Promise<string>> {
  return {
    'open-issues': async () => {
      const core = await import('@cezar/core');
      const { data, error } = await supabase
        .from('issues')
        .select('number, title, body, digest')
        .eq('workspace_id', workspaceId)
        .eq('state', 'open')
        .lt('number', targetNumber)
        .order('number', { ascending: false })
        .limit(KB_LIMIT);
      if (error) throw new Error(`open-issues context query failed: ${error.message}`);
      return core.formatOpenIssuesKb(
        (data ?? []).map((row) => ({
          number: row.number,
          title: row.title,
          summary: digestSummary(row.digest) ?? row.body,
        })),
        { cap: KB_LIMIT },
      );
    },
  };
}

/**
 * Pull a non-empty `summary` string out of a cached issue digest blob. Returns
 * `null` for absent / non-object / array / missing / blank summaries so callers
 * can fall back to the raw issue body. Exported for unit testing.
 */
export function digestSummary(digest: Json | null): string | null {
  if (digest && typeof digest === 'object' && !Array.isArray(digest)) {
    const summary = (digest as { summary?: unknown }).summary;
    if (typeof summary === 'string' && summary.trim().length > 0) return summary;
  }
  return null;
}
