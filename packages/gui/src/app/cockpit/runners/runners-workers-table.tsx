'use client';

import { useEffect, useState } from 'react';
import { createSupabaseBrowserClient } from '@/lib/supabase/browser';
import { timeAgo } from '@/lib/time-ago';
import { cn } from '@/components/ui/cn';
import { EntityCard, MetaRow, MetaItem } from '@/components/ui/data-card-list';
import type { RunnerKind, RunnerUtilization } from '@/lib/supabase/types';

export interface RunnerWorkerRow {
  id: string;
  name: string;
  kind: RunnerKind;
  managed: boolean;
  backends: string[];
  displayStatus: 'online' | 'stale' | 'offline';
  lastHeartbeatAt: string | null;
  utilization: RunnerUtilization | null;
  ghIdentity: string;
  p50Ms: number | null;
  p95Ms: number | null;
  sampleCount: number;
}

/**
 * Phase 5 — workers table on `/cockpit/runners`. Server component supplies the
 * initial snapshot; this subscribes to Supabase Realtime on the `runners` table
 * so heartbeat-driven changes (status, last_heartbeat_at, utilization) flow in
 * without a refresh. Latency columns are NOT realtime — they require a
 * page-level query to recompute, so they refresh on navigate (good enough for
 * an operator-grade view).
 */
export function RunnersWorkersTable({
  rows: initialRows,
  workspaceId,
}: {
  rows: RunnerWorkerRow[];
  workspaceId: string;
}) {
  const [rows, setRows] = useState<RunnerWorkerRow[]>(initialRows);

  // Realtime on the runners table. Filtered to this workspace + global
  // (workspace_id IS NULL) — Supabase Realtime doesn't support OR filters in
  // a single subscription, so we subscribe twice on the same channel.
  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    const channel = supabase
      .channel(`cockpit-runners-${workspaceId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'runners',
          filter: `workspace_id=eq.${workspaceId}`,
        },
        (msg) => applyUpdate(msg.new as RunnerDbShape, setRows),
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'runners', filter: 'workspace_id=is.null' },
        (msg) => applyUpdate(msg.new as RunnerDbShape, setRows),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [workspaceId]);

  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-bg-elevated p-8 text-center text-sm text-fg-muted">
        No runners registered yet. See{' '}
        <a href="/settings/runners" className="text-accent hover:underline">
          Settings → Runners
        </a>{' '}
        to register one.
      </div>
    );
  }

  return (
    <>
      <div className="hidden overflow-x-auto rounded-md border border-border bg-bg-elevated md:block">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border bg-bg text-xs uppercase tracking-wider text-fg-subtle">
            <tr>
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Backends</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Heartbeat</th>
              <th className="px-4 py-2 font-medium">Utilization</th>
              <th className="px-4 py-2 font-medium">GitHub identity</th>
              <th
                className="px-4 py-2 font-medium"
                title="50th / 95th percentile step duration over the last 24h"
              >
                p50 / p95 (24h)
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <RunnerRow key={r.id} row={r} />
            ))}
          </tbody>
        </table>
      </div>

      {/* Phone: stacked cards (P1). */}
      <div className="space-y-3 md:hidden">
        {rows.map((r) => (
          <RunnerCard key={r.id} row={r} />
        ))}
      </div>
    </>
  );
}

function RunnerCard({ row }: { row: RunnerWorkerRow }) {
  const u = row.utilization;
  return (
    <EntityCard
      title={
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-fg">{row.name}</span>
          {row.managed && (
            <span className="rounded border border-border bg-bg px-1.5 py-0.5 font-mono text-[11px] text-fg-muted">
              managed
            </span>
          )}
          <span className="font-mono text-[11px] text-fg-subtle">{row.id.slice(0, 8)}…</span>
        </div>
      }
      badge={<StatusBadge status={row.displayStatus} />}
    >
      <MetaRow>
        <MetaItem label="Backends">
          <span className="flex flex-wrap gap-1">
            {(row.managed ? ['anthropic-api'] : row.backends).map((b) => (
              <span
                key={b}
                className="rounded border border-border bg-bg px-1.5 py-0.5 font-mono text-[11px] text-fg-muted"
              >
                {b}
              </span>
            ))}
          </span>
        </MetaItem>
      </MetaRow>
      <MetaRow>
        <MetaItem label="Heartbeat">
          {row.lastHeartbeatAt ? (
            timeAgo(row.lastHeartbeatAt)
          ) : (
            <span className="text-fg-subtle">never</span>
          )}
        </MetaItem>
        <MetaItem label="Identity">
          <span className="font-mono">{row.ghIdentity}</span>
        </MetaItem>
      </MetaRow>
      <div className="text-xs">
        <span className="font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-outline">
          Utilization
        </span>
        <div className="mt-0.5 text-on-surface">
          {u ? <UtilizationCell utilization={u} /> : <span className="text-fg-subtle">—</span>}
        </div>
      </div>
      <MetaRow>
        <MetaItem label="p50 / p95 (24h)">
          {row.sampleCount === 0 ? (
            <span className="text-fg-subtle">no samples</span>
          ) : (
            <span title={`${row.sampleCount} step${row.sampleCount === 1 ? '' : 's'} in 24h`}>
              {formatMs(row.p50Ms)} <span className="text-fg-subtle">/</span> {formatMs(row.p95Ms)}
            </span>
          )}
        </MetaItem>
      </MetaRow>
    </EntityCard>
  );
}

function RunnerRow({ row }: { row: RunnerWorkerRow }) {
  const u = row.utilization;
  return (
    <tr className="hover:bg-bg-subtle/50">
      <td className="px-4 py-2 align-top">
        <div className="flex items-center gap-2">
          <span className="font-medium text-fg">{row.name}</span>
          {row.managed && (
            <span className="rounded border border-border bg-bg px-1.5 py-0.5 font-mono text-[10px] text-fg-muted">
              managed
            </span>
          )}
        </div>
        <div className="mt-0.5 font-mono text-[10px] text-fg-subtle">{row.id.slice(0, 8)}…</div>
      </td>
      <td className="px-4 py-2 align-top">
        <div className="flex flex-wrap gap-1">
          {(row.managed ? ['anthropic-api'] : row.backends).map((b) => (
            <span
              key={b}
              className="rounded border border-border bg-bg px-1.5 py-0.5 font-mono text-[10px] text-fg-muted"
            >
              {b}
            </span>
          ))}
        </div>
      </td>
      <td className="px-4 py-2 align-top">
        <StatusBadge status={row.displayStatus} />
      </td>
      <td className="px-4 py-2 align-top text-xs text-fg-muted">
        {row.lastHeartbeatAt ? (
          timeAgo(row.lastHeartbeatAt)
        ) : (
          <span className="text-fg-subtle">never</span>
        )}
      </td>
      <td className="px-4 py-2 align-top text-xs text-fg-muted">
        {u ? <UtilizationCell utilization={u} /> : <span className="text-fg-subtle">—</span>}
      </td>
      <td className="px-4 py-2 align-top text-xs">
        <span className="font-mono text-fg-muted">{row.ghIdentity}</span>
      </td>
      <td className="px-4 py-2 align-top text-xs text-fg-muted">
        {row.sampleCount === 0 ? (
          <span className="text-fg-subtle">no samples</span>
        ) : (
          <span title={`${row.sampleCount} step${row.sampleCount === 1 ? '' : 's'} in 24h`}>
            {formatMs(row.p50Ms)} <span className="text-fg-subtle">/</span> {formatMs(row.p95Ms)}
          </span>
        )}
      </td>
    </tr>
  );
}

function UtilizationCell({ utilization }: { utilization: RunnerUtilization }) {
  const pct =
    utilization.capacity > 0 ? Math.round((utilization.inflight / utilization.capacity) * 100) : 0;
  const freePct =
    utilization.totalMemMb > 0
      ? Math.round((utilization.freeMemMb / utilization.totalMemMb) * 100)
      : 0;
  return (
    <div className="space-y-0.5">
      <div>
        <span className="text-fg">{utilization.inflight}</span>
        <span className="text-fg-subtle"> / {utilization.capacity}</span>
        <span className="ml-1 text-fg-subtle">({pct}%)</span>
      </div>
      <div className="text-fg-subtle">
        load {utilization.cpuLoad.toFixed(2)} · free {freePct}% ({formatMb(utilization.freeMemMb)})
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: 'online' | 'stale' | 'offline' }) {
  const colors: Record<typeof status, string> = {
    online: 'bg-accent/20 text-accent',
    stale: 'bg-amber-500/20 text-amber-400',
    offline: 'bg-fg-subtle/20 text-fg-subtle',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider',
        colors[status],
      )}
    >
      <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-current" />
      {status}
    </span>
  );
}

function formatMs(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function formatMb(mb: number): string {
  if (mb < 1024) return `${mb} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

// ─── realtime helpers ────────────────────────────────────────────────────

interface RunnerDbShape {
  id: string;
  name?: string;
  status?: 'online' | 'offline' | 'draining';
  last_heartbeat_at?: string | null;
  utilization?: RunnerUtilization | null;
  github_inherit_host?: boolean;
  github_installation_id?: number | null;
}

const ONLINE_WINDOW_MS = 2 * 60_000;
const STALE_WINDOW_MS = 30 * 60_000;

function applyUpdate(
  next: RunnerDbShape,
  setRows: React.Dispatch<React.SetStateAction<RunnerWorkerRow[]>>,
): void {
  setRows((prev) => {
    const idx = prev.findIndex((r) => r.id === next.id);
    if (idx === -1) return prev;
    const heartbeat = next.last_heartbeat_at ?? prev[idx].lastHeartbeatAt;
    const merged: RunnerWorkerRow = {
      ...prev[idx],
      name: next.name ?? prev[idx].name,
      lastHeartbeatAt: heartbeat,
      utilization: next.utilization === undefined ? prev[idx].utilization : next.utilization,
      displayStatus: deriveDisplayStatus(heartbeat),
      ghIdentity: next.github_inherit_host
        ? 'inherit-host'
        : next.github_installation_id != null
          ? `install:${next.github_installation_id}`
          : prev[idx].ghIdentity,
    };
    const out = prev.slice();
    out[idx] = merged;
    return out;
  });
}

function deriveDisplayStatus(lastHeartbeatAt: string | null): 'online' | 'stale' | 'offline' {
  if (!lastHeartbeatAt) return 'offline';
  const age = Date.now() - new Date(lastHeartbeatAt).getTime();
  if (Number.isNaN(age)) return 'offline';
  if (age <= ONLINE_WINDOW_MS) return 'online';
  if (age <= STALE_WINDOW_MS) return 'stale';
  return 'offline';
}
