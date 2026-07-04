import { redirect } from 'next/navigation';
import { createSupabaseAdminClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { getActiveWorkspace } from '@/lib/workspace';
import type { Database, RunnerUtilization } from '@/lib/supabase/types';
import { PageContainer } from '@/components/ui/page-container';
import { RunnersWorkersTable, type RunnerWorkerRow } from './runners-workers-table';

type RunnerRow = Database['public']['Tables']['runners']['Row'];
type AgentRunRow = Database['public']['Tables']['agent_runs']['Row'];

const ONLINE_WINDOW_MS = 2 * 60_000;
const STALE_WINDOW_MS = 30 * 60_000;

/** Derive a display status from the last heartbeat. Mirrors the same heuristic
 *  used on /settings/runners so a runner that disappears reads "stale" / "offline"
 *  even before the heartbeat ever flipped the stored enum. */
function displayStatus(lastHeartbeatAt: string | null): 'online' | 'stale' | 'offline' {
  if (!lastHeartbeatAt) return 'offline';
  const age = Date.now() - new Date(lastHeartbeatAt).getTime();
  if (Number.isNaN(age)) return 'offline';
  if (age <= ONLINE_WINDOW_MS) return 'online';
  if (age <= STALE_WINDOW_MS) return 'stale';
  return 'offline';
}

/**
 * Phase 5 — `/cockpit/runners` workers page. Lists every runner serving this
 * workspace (own + managed/global) with status, last heartbeat, utilization
 * (from `runners.utilization`), GitHub identity mode (Phase 4), and a
 * lightweight p50/p95 step latency over the last 24h.
 *
 * The latency computation is intentionally trivial — a single SELECT of step
 * durations grouped by runner, percentile math done in JS. If a workspace
 * had 100k+ steps/day per runner this would want PG `percentile_cont` instead,
 * but for normal operator-grade traffic the JS path is fine and avoids
 * shipping yet another RPC.
 */
export default async function CockpitRunnersPage() {
  const workspace = await getActiveWorkspace();
  if (!workspace) redirect('/workspaces');

  // We use an admin client to read managed (workspace_id IS NULL) runners
  // alongside this workspace's own runners — same pattern as /settings/runners.
  const admin = createSupabaseAdminClient();
  const supabase = await createSupabaseServerClient();

  const [{ data: ownRows }, { data: managedRows }] = await Promise.all([
    admin
      .from('runners')
      .select(
        'id, workspace_id, name, kind, backends, status, last_heartbeat_at, created_at, github_inherit_host, github_installation_id, utilization',
      )
      .eq('workspace_id', workspace.id)
      .order('created_at', { ascending: true })
      .returns<RunnerRow[]>(),
    admin
      .from('runners')
      .select(
        'id, workspace_id, name, kind, backends, status, last_heartbeat_at, created_at, github_inherit_host, github_installation_id, utilization',
      )
      .is('workspace_id', null)
      .order('created_at', { ascending: true })
      .returns<RunnerRow[]>(),
  ]);

  const allRunners = [...(ownRows ?? []), ...(managedRows ?? [])];

  // Last-24h step latency per runner. We only pull `started_at`, `finished_at`,
  // and `runner_id` so even a busy workspace stays under the default Supabase
  // row cap. p50/p95 are computed in JS — trivial for operator-grade traffic.
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: latencyRows } = await supabase
    .from('agent_runs')
    .select('runner_id, started_at, finished_at')
    .eq('workspace_id', workspace.id)
    .not('runner_id', 'is', null)
    .not('finished_at', 'is', null)
    .gte('started_at', since24h)
    .returns<Pick<AgentRunRow, 'runner_id' | 'started_at' | 'finished_at'>[]>();

  const latencyByRunner = computeLatencyPercentiles(latencyRows ?? []);

  const rows: RunnerWorkerRow[] = allRunners.map((r) => {
    const utilization = r.utilization as RunnerUtilization | null;
    const latency = latencyByRunner.get(r.id) ?? { p50Ms: null, p95Ms: null, sampleCount: 0 };
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      managed: r.workspace_id == null,
      backends: Array.isArray(r.backends) ? r.backends : [],
      displayStatus: displayStatus(r.last_heartbeat_at),
      lastHeartbeatAt: r.last_heartbeat_at,
      utilization,
      // Phase 4 — render the identity mode the runner would use on its next
      // claim. Precedence (inherit_host wins) matches the claim route.
      ghIdentity: r.github_inherit_host
        ? 'inherit-host'
        : r.github_installation_id != null
          ? `install:${r.github_installation_id}`
          : 'workspace',
      p50Ms: latency.p50Ms,
      p95Ms: latency.p95Ms,
      sampleCount: latency.sampleCount,
    };
  });

  return (
    <PageContainer>
      <header className="mb-6 border-b border-border pb-5">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Runners</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Workers serving this workspace. Self-hosted runners appear when they heartbeat in; managed
          entries handle the anthropic-api path through the dispatch cron.
        </p>
      </header>
      <RunnersWorkersTable rows={rows} workspaceId={workspace.id} />
    </PageContainer>
  );
}

/**
 * Group durations (ms) by runner and return p50/p95 + sample count. Empty
 * groups are omitted (the caller defaults missing runners to `{ p50: null, p95: null }`).
 * Percentile math: nearest-rank — fine for an operator-facing approximation.
 */
function computeLatencyPercentiles(
  rows: Pick<AgentRunRow, 'runner_id' | 'started_at' | 'finished_at'>[],
): Map<string, { p50Ms: number; p95Ms: number; sampleCount: number }> {
  const buckets = new Map<string, number[]>();
  for (const row of rows) {
    if (!row.runner_id || !row.started_at || !row.finished_at) continue;
    const start = new Date(row.started_at).getTime();
    const end = new Date(row.finished_at).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    const ms = end - start;
    const bucket = buckets.get(row.runner_id) ?? [];
    bucket.push(ms);
    buckets.set(row.runner_id, bucket);
  }
  const out = new Map<string, { p50Ms: number; p95Ms: number; sampleCount: number }>();
  for (const [runnerId, samples] of buckets) {
    samples.sort((a, b) => a - b);
    const p50Idx = Math.max(0, Math.ceil(samples.length * 0.5) - 1);
    const p95Idx = Math.max(0, Math.ceil(samples.length * 0.95) - 1);
    out.set(runnerId, {
      p50Ms: samples[p50Idx],
      p95Ms: samples[p95Idx],
      sampleCount: samples.length,
    });
  }
  return out;
}
