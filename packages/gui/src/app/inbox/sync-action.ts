'use server';

import { revalidatePath } from 'next/cache';
import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { SupabaseStoreAdapter } from '@/lib/adapters/supabase-store';
import { loadWorkspaceConfig } from '@/lib/load-workspace-config';

// ─────────────────────────────────────────────────────────────────────
// Sync & Digest — the global "pull from GitHub" action shared by the
// Inbox and Issues page headers.
//
// Replaces the deleted dashboard/sync-action.ts (removed in the Phase D
// /dashboard retirement) but drops the Realtime broadcast streaming —
// the page just shows a spinner while the action runs and revalidates
// when it returns. Re-add the channel pattern when initial syncs of
// large repos start feeling too silent.
// ─────────────────────────────────────────────────────────────────────

export interface SyncResult {
  ok: boolean;
  error?: string;
  issuesFetched?: number;
  issuesCreated?: number;
  issuesUpdated?: number;
  digestsCreated?: number;
  commentsFetched?: number;
  prsUpdated?: number;
  /** Set when the per-call digest cap was hit — more issues remain undigested. */
  truncated?: boolean;
  /** Seconds the caller should wait before retrying (set on a cooldown rejection). */
  retryAfter?: number;
}

// Server-side rate limit: refuse a fresh sync within this window of the last
// one, and collapse concurrent calls (two tabs / rapid clicks) to a single
// run. Every sync is real Anthropic spend, so we gate it at the source rather
// than trusting the client's disabled button. See migration 0029.
const SYNC_COOLDOWN_SECONDS = 30;

// Cap on digests generated per click. Onboarding a huge repo shouldn't bill
// Claude for thousands of digests in one shot; the UI surfaces `truncated` so
// the user can sync again to drain the rest.
const MAX_DIGESTS_PER_SYNC = 200;

export async function syncAndDigest(): Promise<SyncResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: 'Not authenticated' };
  const workspace = await getActiveWorkspace();
  if (!workspace) return { ok: false, error: 'No workspace selected' };
  if (workspace.role !== 'admin') return { ok: false, error: 'Only admins can sync' };

  const core = await import('@cezar/core');
  let token = user.githubToken || process.env.GITHUB_TOKEN || '';
  if (core.GitHubAppService.isConfigured()) {
    try {
      token = await new core.GitHubAppService().getInstallationToken(workspace.repoOwner);
    } catch (err) {
      console.warn('[syncAndDigest] GitHub App token failed, falling back to OAuth:', err);
    }
  }
  if (!token) return { ok: false, error: 'No GitHub token — sign out and back in to sync' };

  const supabase = createSupabaseAdminClient();

  // ── Rate limit + concurrency guard ──
  // claim_sync_slot atomically stamps workspaces.last_synced_at = now() and
  // returns true iff the previous sync is older than the cooldown. Concurrent
  // callers both run the UPDATE but only the first to commit matches the
  // predicate, so exactly one wins — the rest get `false` and bail before any
  // GitHub fetch or LLM call. Done before any paid work so spam is free.
  const { data: claimed, error: claimErr } = await supabase.rpc('claim_sync_slot', {
    wid: workspace.id,
    p_cooldown_seconds: SYNC_COOLDOWN_SECONDS,
  });
  if (claimErr) {
    return { ok: false, error: `Sync gate failed: ${claimErr.message}` };
  }
  if (!claimed) {
    return {
      ok: false,
      error: 'Synced moments ago — wait a few seconds before retrying.',
      retryAfter: SYNC_COOLDOWN_SECONDS,
    };
  }

  const adapter = new SupabaseStoreAdapter(supabase, workspace.id);

  // The store may be empty for a newly-connected workspace; tolerate that
  // by seeding an empty store rather than failing the sync.
  let store: Awaited<ReturnType<typeof core.IssueStore.fromPort>>;
  try {
    store = await core.IssueStore.fromPort(adapter);
  } catch {
    store = await core.IssueStore.fromPort({
      async load() {
        return {
          meta: {
            owner: workspace.repoOwner,
            repo: workspace.repoName,
            lastSyncedAt: null,
            totalFetched: 0,
            version: 1 as const,
            orgMembers: [],
            orgMembersFetchedAt: null,
          },
          issues: [],
        };
      },
      async save(data) {
        await adapter.save(data);
      },
    });
  }

  let config: Awaited<ReturnType<typeof loadWorkspaceConfig>>;
  try {
    config = await loadWorkspaceConfig(workspace.id, supabase, {
      githubToken: token,
      repoOwner: workspace.repoOwner,
      repoName: workspace.repoName,
    });
  } catch (err) {
    return { ok: false, error: `Config load failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const github = new core.GitHubService(config);

  // ── 1. Fetch issues (incremental when possible) ──
  let issuesFetched = 0;
  let issuesCreated = 0;
  let issuesUpdated = 0;
  try {
    const meta = store.getMeta();
    const issues = meta.lastSyncedAt
      ? await github.fetchIssuesSince(meta.lastSyncedAt, false)
      : await github.fetchAllIssues(false);
    issuesFetched = issues.length;
    for (const issue of issues) {
      const r = store.upsertIssue(issue);
      if (r.action === 'created') issuesCreated += 1;
      if (r.action === 'updated') issuesUpdated += 1;
    }
    store.updateMeta({
      lastSyncedAt: new Date().toISOString(),
      totalFetched: issues.length,
    });
    await store.save();
  } catch (err) {
    return { ok: false, error: `Issue fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // ── 2. Generate digests for issues that don't have one yet ──
  let digestsCreated = 0;
  let truncated = false;
  try {
    const allNeedDigest = store.getIssues({ hasDigest: false });
    // Cap the LLM spend per click; surface `truncated` so the UI can prompt
    // another sync to drain the remainder.
    truncated = allNeedDigest.length > MAX_DIGESTS_PER_SYNC;
    const needDigest = truncated ? allNeedDigest.slice(0, MAX_DIGESTS_PER_SYNC) : allNeedDigest;
    if (needDigest.length > 0) {
      const llm = new core.LLMService(config);
      const issueData = needDigest.map((i) => ({ number: i.number, title: i.title, body: i.body }));
      const results = await llm.generateDigests(issueData, config.sync.digestBatchSize);
      for (const [number, digest] of results) {
        store.setDigest(number, digest);
      }
      digestsCreated = results.size;
      await store.save();
    }
  } catch (err) {
    // Digest failure shouldn't abort the whole sync — log via the return
    // envelope and let the user retry. Comments + PR pull are still useful.
    console.warn('[syncAndDigest] digest pass failed:', err);
  }

  // ── 3. Fetch comments for open issues that need them ──
  let commentsFetched = 0;
  try {
    const needComments = store
      .getIssues({ state: 'open' })
      .filter((i) => !i.commentsFetchedAt && i.commentCount > 0);
    if (needComments.length > 0) {
      const commentMap = await github.fetchCommentsForIssues(needComments.map((i) => i.number));
      for (const [num, comments] of commentMap) {
        store.setComments(num, comments);
      }
      commentsFetched = commentMap.size;
      await store.save();
    }
  } catch (err) {
    console.warn('[syncAndDigest] comments pass failed:', err);
  }

  // ── 4. Refresh open PRs into the pull_requests table ──
  let prsUpdated = 0;
  try {
    const openPrs = await github.listOpenPullRequests();
    if (openPrs.length > 0) {
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
      if (!error) prsUpdated = openPrs.length;
    }
  } catch (err) {
    console.warn('[syncAndDigest] PR sync failed:', err);
  }

  revalidatePath('/inbox');
  revalidatePath('/issues');
  revalidatePath('/prs');

  return {
    ok: true,
    issuesFetched,
    issuesCreated,
    issuesUpdated,
    digestsCreated,
    commentsFetched,
    prsUpdated,
    truncated,
  };
}
