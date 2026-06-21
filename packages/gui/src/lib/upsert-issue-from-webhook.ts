import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/types';

/** The slice of a GitHub `issues` webhook payload's `issue` object we use. */
export interface WebhookIssue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels?: Array<{ name: string } | string> | null;
  assignees?: Array<{ login: string }> | null;
  user?: { login: string } | null;
  html_url: string;
  comments?: number | null;
  created_at: string;
  updated_at: string;
}

function labelNames(labels: WebhookIssue['labels']): string[] {
  if (!labels) return [];
  return labels.map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean);
}

/**
 * Phase 5 — upsert a single issue from a GitHub App `issues` webhook into the
 * workspace's issue store, so the `triage` job that follows has data to work
 * with. Mirrors the row shape `SupabaseStoreAdapter` / `api/cron/sync`
 * write; on conflict it merges title/body/labels/state/etc. but does NOT touch
 * `digest`/`analysis` (those are owned by the pipeline). `content_hash` is
 * computed the same way `GitHubService` does so the store's change-detection
 * keeps working.
 *
 * We deliberately write only the columns the webhook payload authoritatively
 * carries. In particular:
 *  - `reactions` is never written here — the webhook `issue` object has no
 *    reaction count, so the periodic `api/cron/sync` reconcile owns it.
 *    (Previously this was hardcoded to `0`, zeroing the synced value on every
 *    `edited` delivery.)
 *  - `comment_count` is only written when the payload actually includes the
 *    `comments` field. On events like `issues.assigned` it can be absent, and
 *    `?? 0` would otherwise regress the synced count back to `0`.
 * On the initial INSERT of a brand-new issue these columns fall back to their
 * schema defaults (`0`), which `sync` then reconciles to real values.
 */
export async function upsertIssueFromWebhook(
  adminSupabase: SupabaseClient<Database>,
  workspaceId: string,
  issue: WebhookIssue,
): Promise<void> {
  const core = await import('@cezar/core');
  const title = issue.title ?? '';
  const body = issue.body ?? '';
  // Mirrors api/cron/sync's row shape — we intentionally omit `digest` /
  // `analysis` so an `edited` upsert doesn't clobber pipeline-owned data
  // (PostgREST `ON CONFLICT DO UPDATE` only sets the columns present here).
  const row: Record<string, unknown> = {
    workspace_id: workspaceId,
    number: issue.number,
    title,
    body,
    state: issue.state,
    labels: labelNames(issue.labels),
    assignees: (issue.assignees ?? []).map((a) => a.login),
    author: issue.user?.login ?? '',
    html_url: issue.html_url,
    content_hash: core.contentHash(title, body),
  };
  // Only write `comment_count` when the payload actually carries it; otherwise
  // an event that omits `comments` would clobber the synced value with `0`.
  if (issue.comments != null) row.comment_count = issue.comments;
  const { error } = await adminSupabase
    .from('issues')
    .upsert(row as Database['public']['Tables']['issues']['Insert'], {
      onConflict: 'workspace_id,number',
    });
  if (error) throw new Error(`issue upsert failed: ${error.message}`);
}
