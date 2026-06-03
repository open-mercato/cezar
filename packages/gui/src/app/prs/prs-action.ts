'use server';

import { revalidatePath } from 'next/cache';
import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';

export interface SyncPrsResult {
  ok: boolean;
  error?: string;
  count?: number;
  /** True when the sync cap was hit — the full `prs-sync` cron backfills the rest. */
  capped?: boolean;
}

// Hard cap on the GitHub round-trip from the interactive server action: 500
// open PRs (~5 pages of 100). Busy repos can't block the route handler
// indefinitely (or time the action out); the background `prs-sync` cron does
// the uncapped walk. listOpenPullRequests stops fetching once the cap is hit.
const MAX_SYNC_ITEMS = 500;

/**
 * On-demand counterpart to the `prs-sync` cron — fetches open PRs from
 * GitHub and upserts them into `pull_requests` for the active workspace.
 * Prefers a GitHub App installation token (§3.9), falling back to the
 * caller's per-user OAuth token. Admin-only (matches the skills sync).
 */
export async function syncPullRequests(): Promise<SyncPrsResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: 'Not authenticated' };
  const workspace = await getActiveWorkspace();
  if (!workspace) return { ok: false, error: 'No workspace selected' };
  if (workspace.role !== 'admin') return { ok: false, error: 'Only admins can sync PRs' };

  const core = await import('@cezar/core');
  let token = user.githubToken || process.env.GITHUB_TOKEN || '';
  if (core.GitHubAppService.isConfigured()) {
    try {
      token = await new core.GitHubAppService().getInstallationToken(workspace.repoOwner);
    } catch (err) {
      console.warn('[syncPullRequests] GitHub App token failed, falling back to OAuth:', err);
    }
  }
  if (!token) return { ok: false, error: 'No GitHub token — sign out and back in to sync' };

  let openPrs: Awaited<ReturnType<InstanceType<typeof core.GitHubService>['listOpenPullRequests']>>;
  try {
    const github = new core.GitHubService({
      github: { owner: workspace.repoOwner, repo: workspace.repoName, token },
    } as never);
    openPrs = await github.listOpenPullRequests(MAX_SYNC_ITEMS);
  } catch (err) {
    return { ok: false, error: `GitHub fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Hitting the cap means more PRs exist than we walked — flag it so the UI
  // can tell the user the cron will backfill the remainder.
  const capped = openPrs.length >= MAX_SYNC_ITEMS;

  if (openPrs.length === 0) {
    revalidatePath('/prs');
    return { ok: true, count: 0 };
  }

  const supabase = createSupabaseAdminClient();
  const rows = openPrs.map((p) => ({
    workspace_id: workspace.id,
    number: p.number,
    title: p.title,
    body: p.body,
    state: p.state,
    draft: p.draft,
    labels: p.labels,
    author: p.author,
    html_url: p.htmlUrl,
    head_sha: p.headSha,
    head_ref: p.headRef,
    base_ref: p.baseRef,
    pr_created_at: p.createdAt,
    pr_updated_at: p.updatedAt,
  }));

  const { error } = await supabase
    .from('pull_requests')
    .upsert(rows, { onConflict: 'workspace_id,number' });
  if (error) return { ok: false, error: `Upsert failed: ${error.message}` };

  revalidatePath('/prs');
  return { ok: true, count: openPrs.length, capped };
}
