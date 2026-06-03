'use client';

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/browser';
import { cn } from '@/components/ui/cn';
import { timeAgo, humanizeTokens } from '@/lib/time-ago';
import type { Database, DbWorkflowRunStatus, WorkspaceRole } from '@/lib/supabase/types';
import {
  RunStatusBadge,
  isTerminalRunStatus,
  stepLabel,
  githubUrlForRun,
  runRefLabel,
} from './cockpit-ui';
import { pauseRun, resumeRun, cancelRun, cancelRuns, retryRun, deleteRun, deleteRuns } from './actions';
import { EnqueueRunButton } from './enqueue-run-button';
import type { CockpitCounts } from './page';

type WorkflowRunRow = Database['public']['Tables']['workflow_runs']['Row'];

const STATUS_PILLS: DbWorkflowRunStatus[] = ['running', 'paused', 'queued', 'failed', 'succeeded', 'cancelled'];
const WORKFLOW_OPTIONS = ['autofix', 'ci-followup', 'triage'] as const;

// Keep the realtime list in step with the server-side `.limit(100)` cap.
const REALTIME_ROW_CAP = 100;

interface Props {
  workspaceId: string;
  repoOwner: string;
  repoName: string;
  role: WorkspaceRole;
  initialRuns: WorkflowRunRow[];
  counts: CockpitCounts;
  repoOptions: string[];
  filters: {
    statuses: DbWorkflowRunStatus[];
    workflow: string | null;
    repo: string | null;
  };
}

export function CockpitList({
  workspaceId,
  repoOwner,
  repoName,
  role,
  initialRuns,
  counts,
  repoOptions,
  filters,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [runs, setRuns] = useState<WorkflowRunRow[]>(initialRuns);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const canControl = role !== 'viewer';

  // Keep local rows in sync when the server re-renders with new filters/data.
  useEffect(() => {
    setRuns(initialRuns);
    setSelected(new Set());
  }, [initialRuns]);

  // Does an incoming row still belong in the list given the active filter bar?
  const matchesFilters = useCallback(
    (r: WorkflowRunRow) =>
      (filters.statuses.length === 0 || filters.statuses.includes(r.status)) &&
      (!filters.workflow || r.workflow === filters.workflow) &&
      (!filters.repo || r.repo === filters.repo),
    [filters.statuses, filters.workflow, filters.repo],
  );

  // ── Realtime: postgres_changes on workflow_runs, scoped to this workspace ──
  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    const channel = supabase
      .channel(`cockpit-runs-${workspaceId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'workflow_runs', filter: `workspace_id=eq.${workspaceId}` },
        (msg) => {
          if (msg.eventType === 'DELETE') {
            const oldId = (msg.old as { id?: string })?.id;
            if (oldId) setRuns((prev) => prev.filter((r) => r.id !== oldId));
            return;
          }
          const row = msg.new as WorkflowRunRow;
          setRuns((prev) => {
            const idx = prev.findIndex((r) => r.id === row.id);
            if (idx === -1) {
              // A brand-new run — prepend only if it matches the active filter,
              // then trim to keep parity with the server-side limit.
              return matchesFilters(row) ? [row, ...prev].slice(0, REALTIME_ROW_CAP) : prev;
            }
            // An update — drop the row if it no longer matches the filter
            // (e.g. status changed out of scope), otherwise merge in place.
            if (!matchesFilters(row)) {
              return prev.filter((_, i) => i !== idx);
            }
            const next = prev.slice();
            next[idx] = { ...next[idx], ...row };
            return next;
          });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [workspaceId, matchesFilters]);

  // ── Filter-bar query-string updates ──
  const setParam = useCallback(
    (key: string, value: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value == null || value === '') params.delete(key);
      else params.set(key, value);
      const qs = params.toString();
      router.push(qs ? `/cockpit?${qs}` : '/cockpit');
    },
    [router, searchParams],
  );

  const toggleStatus = useCallback(
    (s: DbWorkflowRunStatus) => {
      const cur = new Set(filters.statuses);
      if (cur.has(s)) cur.delete(s);
      else cur.add(s);
      setParam('status', Array.from(cur).join(','));
    },
    [filters.statuses, setParam],
  );

  const run = useCallback(
    (fn: () => Promise<{ ok?: boolean; error?: string }>) => {
      setErr(null);
      startTransition(async () => {
        const res = await fn();
        if (res?.error) setErr(res.error);
        else router.refresh();
      });
    },
    [router],
  );

  const allVisibleIds = useMemo(() => runs.map((r) => r.id), [runs]);
  const allSelected = allVisibleIds.length > 0 && allVisibleIds.every((id) => selected.has(id));
  const toggleAll = () => {
    setSelected((prev) => (allSelected ? new Set() : new Set(allVisibleIds)));
  };
  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const cancellableSelected = useMemo(
    () =>
      Array.from(selected).filter((id) => {
        const r = runs.find((x) => x.id === id);
        return r && ['queued', 'running', 'paused'].includes(r.status);
      }),
    [selected, runs],
  );
  const deletableSelected = useMemo(
    () =>
      Array.from(selected).filter((id) => {
        const r = runs.find((x) => x.id === id);
        return r && ['succeeded', 'failed', 'cancelled'].includes(r.status);
      }),
    [selected, runs],
  );

  return (
    <div className="px-8 py-6">
      <header className="mb-6 border-b border-border pb-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Cockpit</h1>
            <p className="mt-1 text-sm text-fg-muted">Agent workflow runs — autofix, CI follow-up, triage.</p>
          </div>
          <EnqueueRunButton disabled={role === 'viewer'} />
        </div>
        <div className="mt-4 flex items-center gap-6 text-sm">
          <Count label="Running" value={counts.running} tone={counts.running > 0 ? 'blue' : 'muted'} />
          <Count label="Paused" value={counts.paused} tone={counts.paused > 0 ? 'amber' : 'muted'} />
          <Count label="Queued" value={counts.queued} tone="muted" />
          <Count label="Failed (24h)" value={counts.failedLast24h} tone={counts.failedLast24h > 0 ? 'danger' : 'muted'} />
        </div>
      </header>

      {/* Filter bar */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {STATUS_PILLS.map((s) => {
          const on = filters.statuses.includes(s);
          return (
            <button
              key={s}
              onClick={() => toggleStatus(s)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium uppercase transition-colors',
                on ? 'border-accent/50 bg-bg-subtle text-fg' : 'border-border text-fg-muted hover:bg-bg-subtle',
              )}
            >
              {s}
            </button>
          );
        })}
        <select
          value={filters.workflow ?? ''}
          onChange={(e) => setParam('workflow', e.target.value || null)}
          className="rounded-md border border-border bg-bg-elevated px-2 py-1 text-xs text-fg"
        >
          <option value="">All workflows</option>
          {WORKFLOW_OPTIONS.map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
        </select>
        {repoOptions.length > 0 && (
          <select
            value={filters.repo ?? ''}
            onChange={(e) => setParam('repo', e.target.value || null)}
            className="rounded-md border border-border bg-bg-elevated px-2 py-1 text-xs text-fg"
          >
            <option value="">All repos</option>
            {repoOptions.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        )}
        {(filters.statuses.length > 0 || filters.workflow || filters.repo) && (
          <button onClick={() => router.push('/cockpit')} className="text-xs text-fg-subtle hover:text-fg underline">
            clear
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          {canControl && cancellableSelected.length > 0 && (
            <button
              disabled={pending}
              onClick={() => run(() => cancelRuns(cancellableSelected))}
              className="rounded-md border border-danger/40 px-3 py-1 text-xs text-danger hover:bg-danger/10 disabled:opacity-50"
            >
              Cancel selected ({cancellableSelected.length})
            </button>
          )}
          {canControl && deletableSelected.length > 0 && (
            <button
              disabled={pending}
              onClick={() => {
                if (!window.confirm(`Delete ${deletableSelected.length} run record(s)? Step history and events go with it.`)) return;
                run(() => deleteRuns(deletableSelected));
              }}
              className="rounded-md border border-danger/40 px-3 py-1 text-xs text-danger hover:bg-danger/10 disabled:opacity-50"
            >
              Delete selected ({deletableSelected.length})
            </button>
          )}
        </div>
      </div>

      {err && (
        <div className="mb-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{err}</div>
      )}

      {runs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-bg-elevated p-8 text-center text-sm text-fg-muted">
          No agent runs yet. Runs appear here when you launch a workflow on an issue or auto-triage queues one.
          <div className="mt-2 text-xs text-fg-subtle">
            The workflow engine is gated behind a workspace setting until it&apos;s rolled out.
          </div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-bg-elevated text-xs uppercase text-fg-subtle">
              <tr>
                <th className="w-8 px-3 py-2">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" />
                </th>
                <th className="px-3 py-2 text-left font-medium">Issue / PR</th>
                <th className="px-3 py-2 text-left font-medium">Workflow</th>
                <th className="px-3 py-2 text-left font-medium">Current step</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Tokens</th>
                <th className="px-3 py-2 text-left font-medium">Age</th>
                <th className="px-3 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const gh = githubUrlForRun(r, repoOwner, repoName);
                const startedish = r.started_at ?? r.created_at;
                return (
                  <tr key={r.id} className="border-t border-border hover:bg-bg-subtle/40">
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selected.has(r.id)}
                        onChange={() => toggleOne(r.id)}
                        aria-label={`Select run ${r.id}`}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <Link href={`/cockpit/${r.id}`} className="font-medium text-fg hover:text-accent">
                          {runRefLabel(r)}
                        </Link>
                        {gh && (
                          <a
                            href={gh}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs text-fg-subtle hover:text-accent"
                            onClick={(e) => e.stopPropagation()}
                          >
                            ↗
                          </a>
                        )}
                      </div>
                      {r.repo && <div className="text-xs text-fg-subtle">{r.repo}</div>}
                    </td>
                    <td className="px-3 py-2 text-fg-muted">{r.workflow}</td>
                    <td className="px-3 py-2 text-fg-muted">{stepLabel(r.current_step_id)}</td>
                    <td className="px-3 py-2">
                      <RunStatusBadge status={r.status} />
                      {r.pause_requested && r.status === 'running' && (
                        <span className="ml-1 text-xs text-amber-400" title="Pause requested — will stop at the next step boundary">
                          ⏸ pending
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-fg-muted">{humanizeTokens(r.tokens_used)}</td>
                    <td className="px-3 py-2 text-xs text-fg-subtle">{timeAgo(startedish)}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1">
                        <RowActions run={r} canControl={canControl} pending={pending} run_={run} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RowActions({
  run,
  canControl,
  pending,
  run_,
}: {
  run: WorkflowRunRow;
  canControl: boolean;
  pending: boolean;
  run_: (fn: () => Promise<{ ok?: boolean; error?: string }>) => void;
}) {
  if (!canControl) return <span className="text-xs text-fg-subtle">—</span>;
  const terminal = isTerminalRunStatus(run.status);
  const showPause = run.status === 'running' && !run.pause_requested;
  const showResume = run.status === 'paused';
  const showCancel = ['running', 'paused', 'queued'].includes(run.status);
  const showRetry = run.status === 'failed' || run.status === 'cancelled';
  const showDelete = terminal;

  return (
    <>
      {showPause && (
        <BtnAction label="Pause" onClick={() => run_(() => pauseRun(run.id))} disabled={pending} />
      )}
      {showResume && (
        <BtnAction
          label="Resume"
          title="Clears the pause flag and re-queues — it continues once a runner picks it up (Phase 3c wires the dispatcher)."
          onClick={() => run_(() => resumeRun(run.id))}
          disabled={pending}
        />
      )}
      {showCancel && (
        <BtnAction
          label="Cancel"
          danger
          title="Marks the run cancelled. A step already executing finishes; the engine stops at the next boundary (Phase 3c adds a hard cancel check)."
          onClick={() => run_(() => cancelRun(run.id))}
          disabled={pending}
        />
      )}
      {showRetry && (
        <BtnAction
          label="Retry"
          title="Queues a new job — runs once a runner is available (Phase 3c/4)."
          onClick={() => run_(() => retryRun(run.id))}
          disabled={pending}
        />
      )}
      {showDelete && (
        <BtnAction
          label="Delete"
          danger
          title="Permanently removes this run and its step history and events."
          onClick={() => {
            if (!window.confirm('Delete this run record? Step history and events go with it.')) return;
            run_(() => deleteRun(run.id));
          }}
          disabled={pending}
        />
      )}
    </>
  );
}

function BtnAction({
  label,
  onClick,
  disabled,
  danger,
  title,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'rounded-md border px-2 py-0.5 text-xs transition-colors disabled:opacity-50',
        danger
          ? 'border-danger/40 text-danger hover:bg-danger/10'
          : 'border-border text-fg-muted hover:bg-bg-subtle hover:text-fg',
      )}
    >
      {label}
    </button>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone: 'blue' | 'amber' | 'danger' | 'muted' }) {
  const colors = { blue: 'text-blue-400', amber: 'text-amber-400', danger: 'text-danger', muted: 'text-fg' };
  return (
    <div className="flex items-baseline gap-1.5">
      <span className={cn('text-lg font-semibold', colors[tone])}>{value}</span>
      <span className="text-xs text-fg-subtle">{label}</span>
    </div>
  );
}
