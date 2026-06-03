import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Cap per-tick work so one oversized repo can't blow the cron timeout.
const MAX_WORKSPACES_PER_TICK = 10;
// Per-workspace wall-clock budget — one slow GitHub API call (or its retry
// window) must not hold the whole tick hostage.
const PER_WORKSPACE_TIMEOUT_MS = 20_000;
// Bound how many issues a single tick pulls into memory so a mega-repo with
// thousands of open issues can't OOM/timeout the cron.
const MAX_ISSUES_PER_TICK = 1_000;

type Workspace = {
  id: string;
  repo_owner: string;
  repo_name: string;
};

// Reject (without unwinding the underlying work) once `ms` elapses so one
// stuck GitHub call can't pin the request.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

/**
 * GitHub → store reconcile cron. The webhook receiver covers new-issue events
 * in real time; this cron is the backfill + missed-delivery safety net (and
 * the only way an existing-issue backlog reaches the store at all).
 *
 * Pulls open issues, upserts them into the `issues` table. Per-workspace
 * gated by `auto_triage_enabled` (same flag as the triage-sweep poll). The
 * dispatcher + triage workflow then take over from there.
 */
export async function GET(req: Request) {
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${expected}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const supabase = createSupabaseAdminClient();

  const { data: workspaces, error } = await supabase
    .from('workspaces')
    .select('id, repo_owner, repo_name')
    .eq('auto_triage_enabled', true)
    .limit(MAX_WORKSPACES_PER_TICK);

  if (error) {
    console.error('[issue-sync] workspace query failed:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!workspaces || workspaces.length === 0) {
    return NextResponse.json({ processed: 0 });
  }

  const core = await import('@cezar/core');
  const results = await Promise.all(
    (workspaces as Workspace[]).map(async (ws) => {
      try {
        return await withTimeout(
          syncOne(ws, supabase, core),
          PER_WORKSPACE_TIMEOUT_MS,
          'issue sync',
        );
      } catch (err) {
        // Log the full error server-side; never echo raw GitHub/Octokit error
        // text to the caller (it can carry tokens or other internals).
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[issue-sync] workspace ${ws.id} failed:`, msg);
        return { workspaceId: ws.id, ok: false, error: 'sync_failed' };
      }
    }),
  );

  return NextResponse.json({ processed: workspaces.length, results });
}

async function syncOne(
  ws: Workspace,
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  core: typeof import('@cezar/core'),
): Promise<{ workspaceId: string; ok: true; issues: number }> {
  const token = await resolveWorkspaceToken(ws.id, supabase);
  if (!token) throw new Error('no github token available for workspace');

  const github = new core.GitHubService({
    github: { owner: ws.repo_owner, repo: ws.repo_name, token },
  } as any);

  const openIssues = await github.fetchAllIssues(false, MAX_ISSUES_PER_TICK);

  if (openIssues.length > 0) {
    const rows = openIssues.map(i => ({
      workspace_id: ws.id,
      number: i.number,
      title: i.title,
      body: i.body,
      state: i.state,
      labels: i.labels,
      assignees: i.assignees,
      author: i.author,
      html_url: i.htmlUrl,
      content_hash: i.contentHash,
      comment_count: i.commentCount,
      reactions: i.reactions,
    }));
    const { error: upsertErr } = await supabase
      .from('issues')
      .upsert(rows as any, { onConflict: 'workspace_id,number' });
    if (upsertErr) throw new Error(`issues upsert failed: ${upsertErr.message}`);
  }

  return {
    workspaceId: ws.id,
    ok: true,
    issues: openIssues.length,
  };
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
    const ids = admins.map(a => a.user_id);
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
