import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { requireCronSecret } from '@/lib/scheduler/cron-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Cap per-tick work so one oversized repo can't blow the cron timeout.
const MAX_WORKSPACES_PER_TICK = 10;

type Workspace = {
  id: string;
  repo_owner: string;
  repo_name: string;
};

/**
 * GitHub → store reconcile cron for pull requests. Sibling of `issue-sync`.
 * The webhook receiver upserts on `pull_request` events in real time; this
 * cron is the backfill + missed-delivery safety net.
 *
 * Pulls open PRs via Octokit and upserts them into the `pull_requests` table.
 * Per-workspace gated by the same `auto_triage_enabled` flag — repos opted
 * out of automated work still get a /prs page, so we sync regardless of that
 * flag and require only that a workspace exists.
 */
export async function GET(req: Request) {
  const unauthorized = requireCronSecret(req);
  if (unauthorized) return unauthorized;

  const supabase = createSupabaseAdminClient();

  const { data: workspaces, error } = await supabase
    .from('workspaces')
    .select('id, repo_owner, repo_name')
    .limit(MAX_WORKSPACES_PER_TICK);

  if (error) {
    console.error('[prs-sync] workspace query failed:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!workspaces || workspaces.length === 0) {
    return NextResponse.json({ processed: 0 });
  }

  const core = await import('@cezar/core');
  const results = await Promise.all(
    (workspaces as Workspace[]).map(async (ws) => {
      try {
        return await syncOne(ws, supabase, core);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[prs-sync] workspace ${ws.id} failed:`, msg);
        return { workspaceId: ws.id, ok: false, error: msg };
      }
    }),
  );

  return NextResponse.json({ processed: workspaces.length, results });
}

async function syncOne(
  ws: Workspace,
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  core: typeof import('@cezar/core'),
): Promise<{ workspaceId: string; ok: true; prs: number }> {
  const token = await resolveWorkspaceToken(ws.id, supabase);
  if (!token) throw new Error('no github token available for workspace');

  const github = new core.GitHubService({
    github: { owner: ws.repo_owner, repo: ws.repo_name, token },
  } as never);

  const openPrs = await github.listOpenPullRequests();

  if (openPrs.length > 0) {
    const rows = openPrs.map((p) => ({
      workspace_id: ws.id,
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
    const { error: upsertErr } = await supabase
      .from('pull_requests')
      .upsert(rows, { onConflict: 'workspace_id,number' });
    if (upsertErr) throw new Error(`pull_requests upsert failed: ${upsertErr.message}`);
  }

  return { workspaceId: ws.id, ok: true, prs: openPrs.length };
}

// Picks a workable GitHub token for the workspace: walk admins, return the
// first one whose provider_token is stored. Falls back to the env-level
// GITHUB_TOKEN so single-tenant self-hosted deployments still work.
async function resolveWorkspaceToken(
  workspaceId: string,
  supabase: ReturnType<typeof createSupabaseAdminClient>,
): Promise<string | null> {
  const { data: admins } = await supabase
    .from('workspace_members')
    .select('user_id')
    .eq('workspace_id', workspaceId)
    .eq('role', 'admin');

  if (admins && admins.length > 0) {
    const ids = admins.map((a) => a.user_id);
    const { data: tokens } = await supabase
      .from('user_github_tokens')
      .select('provider_token')
      .in('user_id', ids)
      .limit(1);
    const token = tokens?.[0]?.provider_token;
    if (token) return token;
  }

  return process.env.GITHUB_TOKEN || null;
}
