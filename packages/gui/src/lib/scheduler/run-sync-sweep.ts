// Pure-function body of the /api/cron/sync route — shared between the HTTP
// handler (auth-gated) and the in-process scheduler.
//
// Enqueues ONE deduped `sync` job per workspace. The dispatch worker claims it
// and runs the shared sync engine (issues + PRs + digests + comments). Unlike
// the triage sweep this is NOT gated by `auto_triage_enabled` — every connected
// repo needs a synced /issues and /prs page regardless of whether it opted into
// automated work.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/types';

type WorkspaceRow = {
  id: string;
  repo_owner: string;
  repo_name: string;
  sync_mode: 'auto' | 'manual';
  sync_interval_minutes: number;
};

export interface SyncSweepResult {
  enqueued: number;
  workspaces: number;
  error?: string;
}

export async function runSyncSweep(supabase: SupabaseClient<Database>): Promise<SyncSweepResult> {
  const MAX_WORKSPACES_PER_TICK = Number(process.env.CEZAR_SYNC_MAX_WORKSPACES) || 25;

  const { data: workspaces, error } = await supabase
    .from('workspaces')
    .select('id, repo_owner, repo_name, sync_mode, sync_interval_minutes')
    .limit(MAX_WORKSPACES_PER_TICK);
  if (error) {
    console.error('[sync-sweep] workspace query failed:', error.message);
    return { enqueued: 0, workspaces: 0, error: error.message };
  }
  if (!workspaces || workspaces.length === 0) return { enqueued: 0, workspaces: 0 };

  let totalEnqueued = 0;
  for (const ws of workspaces as WorkspaceRow[]) {
    try {
      totalEnqueued += await sweepOne(ws, supabase);
    } catch (err) {
      console.error(
        `[sync-sweep] workspace ${ws.id} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { enqueued: totalEnqueued, workspaces: workspaces.length };
}

async function sweepOne(ws: WorkspaceRow, supabase: SupabaseClient<Database>): Promise<number> {
  // Manual-mode workspaces never auto-enqueue; they sync only via the header
  // "sync now" control (which calls `syncAndDigest` directly, not this sweep).
  if (ws.sync_mode === 'manual') return 0;

  // Fast-path dedupe: skip if an open sync job already exists for this
  // workspace. The partial unique index `jobs_sync_open_uniq` (migration 0037)
  // is the real guard — a lost race surfaces as a 23505 we swallow below.
  const { data: open } = await supabase
    .from('jobs')
    .select('id')
    .eq('workspace_id', ws.id)
    .eq('kind', 'sync')
    .in('status', ['queued', 'claimed', 'running'])
    .limit(1);
  if (open && open.length > 0) return 0;

  // Interval gate: skip if the last sync finished less than the workspace's
  // configured cadence ago. A sync in progress is already excluded by the
  // open-job check above, so `finished_at` is the right anchor (fall back to
  // `started_at`/`updated_at` for rows written before a sync first completed).
  const intervalMs = Math.max(5, ws.sync_interval_minutes || 15) * 60_000;
  const { data: status } = await supabase
    .from('sync_status')
    .select('started_at, finished_at, updated_at')
    .eq('workspace_id', ws.id)
    .maybeSingle();
  if (status) {
    const last = status.finished_at ?? status.started_at ?? status.updated_at;
    if (last && Date.now() - new Date(last).getTime() < intervalMs) return 0;
  }

  const { error } = await supabase.from('jobs').insert({
    workspace_id: ws.id,
    repo: `${ws.repo_owner}/${ws.repo_name}`,
    kind: 'sync',
    issue_number: null,
    pr_number: null,
    priority: 5,
    status: 'queued',
    max_attempts: 1,
    payload: { trigger: 'cron' },
  });
  if (error) {
    // A concurrent sweep tick already enqueued a sync job for this workspace;
    // the partial unique index rejects the duplicate with 23505 — benign no-op.
    if (error.code !== '23505' && !/duplicate key/i.test(error.message)) {
      console.error(`[sync-sweep] enqueue failed for ws ${ws.id}:`, error.message);
    }
    return 0;
  }
  return 1;
}
