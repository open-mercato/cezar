import { NextResponse } from 'next/server';
import { authRunner } from '../_auth';
import type { Database, RunnerStatus, RunnerUtilization } from '@/lib/supabase/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface HeartbeatBody {
  status?: RunnerStatus;
  /** Legacy field — kept for older runners; the daemon now also sends
   *  `inflightJobIds`. Either is acceptable. */
  currentJobIds?: string[];
  /** Phase 3: ids of jobs the runner currently has in flight. The route
   *  bulk-renews their leases via `renew_claim_leases` and returns the ids
   *  it was actually able to renew — anything missing means the runner has
   *  lost the claim and should abort that job. */
  inflightJobIds?: string[];
  /** Phase 4 (migration 0026) — runner self-describes its GitHub identity
   *  mode. The route upserts these onto the `runners` row so the next claim
   *  picks the right minter without admin-GUI setup. Precedence: when
   *  `githubInheritHost` is true, `githubInstallationId` is ignored. */
  githubInheritHost?: boolean;
  githubInstallationId?: number | null;
  /** Phase 5 (migration 0027) — runner-reported load snapshot. Written
   *  verbatim onto `runners.utilization` JSONB. Older daemons omit this
   *  entirely; the column stays NULL until the runner upgrades. */
  utilization?: RunnerUtilization;
}

interface HeartbeatRpcRow {
  cancel_job_ids: string[] | null;
  pause_run_ids: string[] | null;
}

interface RenewRow {
  renewed_id: string;
}

/**
 * POST /api/runner/heartbeat  { status?, inflightJobIds? }
 *
 * Refreshes the runner's `last_heartbeat_at`/`status`, renews leases for the
 * in-flight job ids the runner reports, and tells it which of its jobs/runs
 * the operator has asked to cancel/pause (the runner has no other channel
 * for that). The lease renewal replaces the old 3-minute runner-offline
 * blind window — see migration 0025.
 *
 * Implemented as two RPCs: `runner_heartbeat` (one round-trip; cancel/pause
 * signals) + `renew_claim_leases` (one round-trip; bulk lease bump). Both
 * use the service-role admin client.
 */
export async function POST(req: Request) {
  const auth = await authRunner(req);
  if (auth instanceof NextResponse) return auth;
  const { runner, admin } = auth;

  let body: HeartbeatBody = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }
  const status: RunnerStatus = body.status ?? 'online';
  const inflight = body.inflightJobIds ?? body.currentJobIds ?? [];

  const { data, error } = await admin.rpc('runner_heartbeat', {
    p_runner_id: runner.id,
    p_status: status,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Trust-boundary guard (issue #80): `github_installation_id` is consumed by
  // `/jobs` to mint an installation access token against ANY id the central
  // App can reach. A runner must not be able to pivot to an arbitrary
  // installation by self-reporting one on its own heartbeat. So:
  //   • workspace-scoped runner → the requested id must equal its own
  //     workspace's recorded `installation_id` (set by the GitHub App
  //     `installation` webhook). Clearing (null) is always allowed.
  //   • managed runner (no workspace_id) → refuse heartbeat-driven sets
  //     entirely; a managed runner's install must be flipped in the admin GUI.
  if (body.githubInstallationId !== undefined && body.githubInstallationId !== null) {
    if (runner.workspace_id == null) {
      return NextResponse.json(
        { error: 'managed runners cannot self-set github_installation_id; configure it in the admin GUI' },
        { status: 403 },
      );
    }
    const { data: ws, error: wsErr } = await admin
      .from('workspaces')
      .select('installation_id')
      .eq('id', runner.workspace_id)
      .maybeSingle();
    if (wsErr) return NextResponse.json({ error: wsErr.message }, { status: 500 });
    // `workspaces.installation_id` is text; the runner reports a number.
    if (!ws?.installation_id || String(body.githubInstallationId) !== ws.installation_id) {
      return NextResponse.json(
        { error: 'github_installation_id does not match this runner\'s workspace installation' },
        { status: 403 },
      );
    }
  }

  // Phase 4 (migration 0026) — runner self-describes its GitHub identity.
  // Phase 5 (migration 0027) — runner reports its utilization snapshot.
  // Only update fields the runner actually sent, so older daemons (and
  // admin-GUI-configured runners) aren't clobbered. The route never echoes
  // the identity back; the claim route reads `runners.*` fresh per claim.
  // Utilization is a snapshot (overwritten in place — no time-series).
  if (
    body.githubInheritHost !== undefined ||
    body.githubInstallationId !== undefined ||
    body.utilization !== undefined
  ) {
    const patch: Database['public']['Tables']['runners']['Update'] = {};
    if (body.githubInheritHost !== undefined) {
      patch.github_inherit_host = body.githubInheritHost;
    }
    if (body.githubInstallationId !== undefined) {
      // null clears the per-runner install; a number sets it (validated above
      // to match the runner's workspace installation). The claim route
      // enforces precedence (inherit_host wins).
      patch.github_installation_id = body.githubInstallationId;
    }
    if (body.utilization !== undefined) {
      // Snapshot overwrite — no merging. The runner samples right before the
      // POST so the value here is the freshest one. Older daemons don't send
      // this; their column stays NULL (the cockpit handles NULL as "no data").
      patch.utilization = body.utilization;
    }
    const identityChanged =
      patch.github_inherit_host !== runner.github_inherit_host ||
      patch.github_installation_id !== runner.github_installation_id;
    // Always write if utilization is present (the snapshot is fresh each
    // heartbeat); otherwise only if the identity actually changed.
    if (identityChanged || body.utilization !== undefined) {
      const { error: upErr } = await admin.from('runners').update(patch).eq('id', runner.id);
      if (upErr) {
        console.error('[runner-api] runner upsert failed:', upErr.message);
      }
    }
  }

  // PostgREST returns `setof record` functions as an array of rows.
  const row = (Array.isArray(data) ? data[0] : data) as HeartbeatRpcRow | null | undefined;
  const cancelJobIds = row?.cancel_job_ids ?? [];
  const pauseRunIds  = row?.pause_run_ids  ?? [];

  // Bulk-renew leases. Only renews rows still claimed_by_runner = this runner
  // AND status ∈ ('claimed','running') — so a watchdog-reclaimed job won't be
  // re-leased back. The runner uses the diff (sent vs. renewed) to detect
  // lost claims and abort those jobs.
  let renewedJobIds: string[] = [];
  if (inflight.length > 0) {
    const { data: rows, error: renewErr } = await admin.rpc('renew_claim_leases', {
      p_runner_id: runner.id,
      p_job_ids: inflight,
    });
    if (renewErr) {
      console.error('[runner-api] renew_claim_leases failed:', renewErr.message);
    } else {
      renewedJobIds = ((rows ?? []) as RenewRow[]).map((r) => r.renewed_id);
    }
  }

  // Phase 5 — echo the runner's own UUID so the daemon can stamp `runnerId`
  // on `step-start` events without an extra round-trip. Older daemons ignore
  // unrecognized fields, so this is backward-compatible.
  return NextResponse.json({ ok: true, cancelJobIds, pauseRunIds, renewedJobIds, runnerId: runner.id });
}
