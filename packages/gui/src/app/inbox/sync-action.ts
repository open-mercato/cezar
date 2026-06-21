'use server';

import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import {
  STALE_SYNC_MS,
  buildSyncContext,
  runSyncPhases,
  writeSyncStatus,
} from '@/lib/sync/run-workspace-sync';
import type { Database } from '@/lib/supabase/types';

// ─────────────────────────────────────────────────────────────────────
// Sync & Digest — the global "pull from GitHub" action shared by the
// Inbox and Issues page headers.
//
// The four phases (fetch issues → digest → fetch comments → refresh PRs)
// are external-API-bound and can take 30s–2min. Running them inline in the
// server action used to block the whole UI (Next.js serializes server
// actions, so navigations + router.refresh() queued behind it). Instead we
// now do a fast in-request kickoff (auth + a row flip) and run the phases as
// a detached background task that writes its progress into `sync_status`.
// The client subscribes to that row over Realtime to show live progress and
// refreshes when it lands on 'done'/'error'. The app is a long-lived Node
// container (output: 'standalone', Docker/Dokploy), so a non-awaited promise
// keeps running safely after the action returns.
//
// The actual phase pipeline lives in the shared `lib/sync/run-workspace-sync`
// module so a cron/job worker can run the identical sync.
// ─────────────────────────────────────────────────────────────────────

export interface SyncResult {
  /** True once the background sync has been kicked off (not when it finishes). */
  ok: boolean;
  error?: string;
}

type SyncStatusRow = Database['public']['Tables']['sync_status']['Row'];

export async function syncAndDigest(): Promise<SyncResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: 'Not authenticated' };
  const workspace = await getActiveWorkspace();
  if (!workspace) return { ok: false, error: 'No workspace selected' };
  if (workspace.role !== 'admin') return { ok: false, error: 'Only admins can sync' };

  const supabase = createSupabaseAdminClient();

  // ── Concurrency guard: refuse to start a second sync while one is live. ──
  // A `syncing` row older than STALE_SYNC_MS is considered abandoned and is
  // allowed to be overwritten.
  const { data: existing } = await supabase
    .from('sync_status')
    .select('status, updated_at')
    .eq('workspace_id', workspace.id)
    .maybeSingle<Pick<SyncStatusRow, 'status' | 'updated_at'>>();
  if (existing?.status === 'syncing') {
    const age = Date.now() - new Date(existing.updated_at).getTime();
    if (age < STALE_SYNC_MS) {
      return { ok: false, error: 'Sync already in progress' };
    }
  }

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

  let ctx: Awaited<ReturnType<typeof buildSyncContext>>;
  try {
    ctx = await buildSyncContext({
      supabase,
      workspaceId: workspace.id,
      repoOwner: workspace.repoOwner,
      repoName: workspace.repoName,
      token,
    });
  } catch (err) {
    return {
      ok: false,
      error: `Config load failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // ── Flip the row to 'syncing' before we return, so the client sees the
  //    spinner immediately and the concurrency guard above is armed. ──
  await writeSyncStatus(supabase, workspace.id, {
    status: 'syncing',
    phase: 'issues',
    message: 'Fetching issues…',
    counts: {},
    error: null,
    started_at: new Date().toISOString(),
    finished_at: null,
  });

  // ── Run the four phases in the background; do NOT await. ──
  // "Sync now" is a metadata refresh: digests follow the workspace's digest
  // policy (auto cadence / manual / off), not forced. The dedicated
  // `generateDigestsNow` action is the explicit "spend now" path.
  void runSyncPhases({
    supabase,
    workspaceId: workspace.id,
    store: ctx.store,
    github: ctx.github,
    config: ctx.config,
    digestPolicy: ctx.digestPolicy,
  }).catch(async (err) => {
    console.error('[syncAndDigest] background sync crashed:', err);
    await writeSyncStatus(supabase, workspace.id, {
      status: 'error',
      phase: null,
      error: err instanceof Error ? err.message : String(err),
      finished_at: new Date().toISOString(),
    });
  });

  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────
// Generate digests now — the on-demand "spend now" action (spec §5).
//
// For `manual`/`off` digest workspaces, this is how an admin produces AI
// summaries on demand. It runs the SAME background sync pipeline as
// `syncAndDigest` but with `forceDigests: true`, so phase 2 runs regardless of
// the workspace's digest mode/cadence. Metadata phases run too (cheap), keeping
// everything fresh. Admin-only; writes `sync_status` exactly like the normal
// path, so the existing indicator reflects progress.
// ─────────────────────────────────────────────────────────────────────
export async function generateDigestsNow(): Promise<SyncResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: 'Not authenticated' };
  const workspace = await getActiveWorkspace();
  if (!workspace) return { ok: false, error: 'No workspace selected' };
  if (workspace.role !== 'admin') return { ok: false, error: 'Only admins can generate digests' };

  const supabase = createSupabaseAdminClient();

  // Same concurrency guard as syncAndDigest — refuse to start while a sync is
  // live (a fresh `syncing` row), since both write the same `sync_status`.
  const { data: existing } = await supabase
    .from('sync_status')
    .select('status, updated_at')
    .eq('workspace_id', workspace.id)
    .maybeSingle<Pick<SyncStatusRow, 'status' | 'updated_at'>>();
  if (existing?.status === 'syncing') {
    const age = Date.now() - new Date(existing.updated_at).getTime();
    if (age < STALE_SYNC_MS) {
      return { ok: false, error: 'Sync already in progress' };
    }
  }

  const core = await import('@cezar/core');
  let token = user.githubToken || process.env.GITHUB_TOKEN || '';
  if (core.GitHubAppService.isConfigured()) {
    try {
      token = await new core.GitHubAppService().getInstallationToken(workspace.repoOwner);
    } catch (err) {
      console.warn('[generateDigestsNow] GitHub App token failed, falling back to OAuth:', err);
    }
  }
  if (!token) return { ok: false, error: 'No GitHub token — sign out and back in to sync' };

  let ctx: Awaited<ReturnType<typeof buildSyncContext>>;
  try {
    ctx = await buildSyncContext({
      supabase,
      workspaceId: workspace.id,
      repoOwner: workspace.repoOwner,
      repoName: workspace.repoName,
      token,
    });
  } catch (err) {
    return {
      ok: false,
      error: `Config load failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  await writeSyncStatus(supabase, workspace.id, {
    status: 'syncing',
    phase: 'issues',
    message: 'Fetching issues…',
    counts: {},
    error: null,
    started_at: new Date().toISOString(),
    finished_at: null,
  });

  // forceDigests: true ⇒ phase 2 runs whatever the workspace's digest mode is.
  void runSyncPhases({
    supabase,
    workspaceId: workspace.id,
    store: ctx.store,
    github: ctx.github,
    config: ctx.config,
    digestPolicy: ctx.digestPolicy,
    forceDigests: true,
  }).catch(async (err) => {
    console.error('[generateDigestsNow] background sync crashed:', err);
    await writeSyncStatus(supabase, workspace.id, {
      status: 'error',
      phase: null,
      error: err instanceof Error ? err.message : String(err),
      finished_at: new Date().toISOString(),
    });
  });

  return { ok: true };
}
