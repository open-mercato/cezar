'use client';

import { useCallback, useEffect, useRef, useState, useTransition, type ReactNode } from 'react';
import Link from 'next/link';
import { ResponsiveTooltip } from '@/components/ui/responsive-tooltip';
import { useRouter } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/browser';
import { cn } from '@/components/ui/cn';
import { timeAgo, humanizeTokens } from '@/lib/time-ago';
import type { Database, WorkspaceRole } from '@/lib/supabase/types';
import {
  RunStatusBadge,
  StepStatusBadge,
  isTerminalRunStatus,
  stepLabel,
  githubUrlForRun,
  runRefLabel,
} from '../cockpit-ui';
import { pauseRun, resumeRun, cancelRun, deleteRun } from '../actions';

type WorkflowRunRow = Database['public']['Tables']['workflow_runs']['Row'];
type AgentRunRow = Database['public']['Tables']['agent_runs']['Row'];
type AgentRunEventRow = Database['public']['Tables']['agent_run_events']['Row'];

/** Phase 5 — minimal runner info threaded into the step chip on /cockpit/[runId].
 *  Keyed by `runners.id`; populated server-side from the distinct `runner_id`s
 *  seen on this run's steps. Steps with no `runner_id` (cron path) skip the chip. */
export type RunnerLookup = Record<
  string,
  {
    id: string;
    name: string;
    status: string;
    lastHeartbeatAt: string | null;
    ghIdentity: string;
  }
>;

interface Props {
  run: WorkflowRunRow;
  repoOwner: string;
  repoName: string;
  role: WorkspaceRole;
  initialSteps: AgentRunRow[];
  initialEvents: AgentRunEventRow[];
  /** Phase 5 — runner_id → display info for the per-step chip. Empty for runs
   *  with no runner attribution (cron-dispatched anthropic-api). */
  runners?: RunnerLookup;
}

export function RunDetailShell({
  run: initialRun,
  repoOwner,
  repoName,
  role,
  initialSteps,
  initialEvents,
  runners = {},
}: Props) {
  const router = useRouter();
  const [run, setRun] = useState<WorkflowRunRow>(initialRun);
  const [steps, setSteps] = useState<AgentRunRow[]>(initialSteps);
  const [events, setEvents] = useState<AgentRunEventRow[]>(initialEvents);
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const canControl = role !== 'viewer';
  const terminal = isTerminalRunStatus(run.status);

  const feedRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const seenEventIds = useRef(new Set(initialEvents.map((e) => e.id)));
  const [showJump, setShowJump] = useState(false);
  // Phone-only: which pane is visible (the two-pane grid collapses to tabs
  // below `lg`). On `lg+` both panes render and this state is ignored.
  const [mobileTab, setMobileTab] = useState<'steps' | 'log'>('log');

  // ── Realtime: agent_runs + agent_run_events scoped to this workflow_run,
  //    plus workflow_runs to refresh the header. ──
  useEffect(() => {
    if (terminal) return;
    const supabase = createSupabaseBrowserClient();
    const channel = supabase
      .channel(`cockpit-run-${run.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'agent_run_events',
          filter: `workflow_run_id=eq.${run.id}`,
        },
        (msg) => {
          if (msg.eventType !== 'INSERT') return;
          const row = msg.new as AgentRunEventRow;
          if (seenEventIds.current.has(row.id)) return;
          seenEventIds.current.add(row.id);
          setEvents((prev) => [...prev, row]);
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'agent_runs',
          filter: `workflow_run_id=eq.${run.id}`,
        },
        (msg) => {
          if (msg.eventType === 'DELETE') return;
          const row = msg.new as AgentRunRow;
          setSteps((prev) => {
            const idx = prev.findIndex((s) => s.id === row.id);
            if (idx === -1) return [...prev, row];
            const next = prev.slice();
            next[idx] = { ...next[idx], ...row };
            return next;
          });
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'workflow_runs', filter: `id=eq.${run.id}` },
        (msg) => {
          if (msg.eventType === 'DELETE') return;
          setRun((prev) => ({ ...prev, ...(msg.new as WorkflowRunRow) }));
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [run.id, terminal]);

  // Auto-scroll the event log like a terminal, unless the user scrolled up.
  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
      setShowJump(false);
    } else {
      setShowJump(true);
    }
  }, [events.length, mobileTab]);

  const onFeedScroll = () => {
    const el = feedRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    stickToBottom.current = atBottom;
    if (atBottom) setShowJump(false);
  };
  const jumpToBottom = () => {
    const el = feedRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickToBottom.current = true;
    setShowJump(false);
  };

  const act = useCallback(
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

  const gh = githubUrlForRun(run, repoOwner, repoName);
  const showPause = canControl && run.status === 'running' && !run.pause_requested;
  const showResume = canControl && run.status === 'paused';
  const showCancel = canControl && ['running', 'paused', 'queued'].includes(run.status);
  const showDelete = canControl && terminal;

  // Group events by step for the collapsible per-step log; events with no
  // agent_run_id (lifecycle) go into a "run-level" bucket.
  const eventsByStep = new Map<string | null, AgentRunEventRow[]>();
  for (const e of events) {
    const k = e.agent_run_id ?? null;
    if (!eventsByStep.has(k)) eventsByStep.set(k, []);
    eventsByStep.get(k)!.push(e);
  }

  return (
    <div className="flex h-screen h-dvh flex-col">
      {/* Header */}
      <div className="border-b border-border px-4 py-4 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <Link
                href="/cockpit"
                className="-ml-1 inline-flex min-h-11 items-center px-1 text-sm text-fg-subtle hover:text-accent lg:min-h-0 lg:ml-0 lg:px-0"
              >
                ← Cockpit
              </Link>
              <h1 className="text-lg font-semibold">{run.workflow}</h1>
              <RunStatusBadge status={run.status} />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
              {gh ? (
                <a
                  href={gh}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent hover:underline"
                >
                  {runRefLabel(run)} ↗
                </a>
              ) : (
                <span>{runRefLabel(run)}</span>
              )}
              {run.repo && <span>{run.repo}</span>}
              {run.branch && <span>branch: {run.branch}</span>}
              {run.pr_url && (
                <a
                  href={run.pr_url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent hover:underline"
                >
                  PR ↗
                </a>
              )}
              <span>started {timeAgo(run.started_at ?? run.created_at)}</span>
              {run.finished_at && <span>finished {timeAgo(run.finished_at)}</span>}
              <span>{humanizeTokens(run.tokens_used)} tokens</span>
              {run.current_step_id && !terminal && (
                <span>step: {stepLabel(run.current_step_id)}</span>
              )}
            </div>
            {run.reason && <div className="mt-1 text-xs text-fg-subtle">{run.reason}</div>}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {showPause && (
              <HeaderBtn
                label="Pause"
                onClick={() => act(() => pauseRun(run.id))}
                disabled={pending}
              />
            )}
            {showResume && (
              <HeaderBtn
                label="Resume"
                title="Clears the pause flag and re-queues — continues once a runner picks it up (Phase 3c)."
                onClick={() => act(() => resumeRun(run.id))}
                disabled={pending}
              />
            )}
            {showCancel && (
              <HeaderBtn
                label="Cancel"
                danger
                onClick={() => act(() => cancelRun(run.id))}
                disabled={pending}
              />
            )}
            {showDelete && (
              <HeaderBtn
                label="Delete"
                danger
                title="Permanently removes this run and its step history and events."
                onClick={() => {
                  if (
                    !window.confirm('Delete this run record? Step history and events go with it.')
                  )
                    return;
                  setErr(null);
                  startTransition(async () => {
                    const res = await deleteRun(run.id);
                    if (res?.error) setErr(res.error);
                    else router.push('/cockpit');
                  });
                }}
                disabled={pending}
              />
            )}
            {run.pause_requested && run.status === 'running' && (
              <span className="text-xs text-amber-400">⏸ pause pending</span>
            )}
          </div>
        </div>
        {err && (
          <div className="mt-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-1.5 text-xs text-danger">
            {err}
          </div>
        )}
      </div>

      {/* Phone-only segmented control: the two-pane grid below collapses to a
          single full-width scroll region per tab. Hidden on `lg+`, where both
          panes render side-by-side as before. */}
      <div className="flex shrink-0 gap-1 border-b border-border px-4 py-2 lg:hidden">
        <TabBtn active={mobileTab === 'steps'} onClick={() => setMobileTab('steps')}>
          Steps
          {steps.length > 0 && <span className="ml-1.5 text-fg-subtle">{steps.length}</span>}
        </TabBtn>
        <TabBtn active={mobileTab === 'log'} onClick={() => setMobileTab('log')}>
          Event log
          {!terminal && (
            <span className="ml-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent align-middle" />
          )}
        </TabBtn>
      </div>

      {/* Body: step list (left) + event log (right).
          Phone: stacked — exactly one pane shown via the segmented control above.
          `lg`: the original two-pane grid, unchanged. */}
      <div className="flex flex-1 flex-col overflow-hidden lg:grid lg:grid-cols-[minmax(320px,420px)_1fr]">
        {/* Steps */}
        <div
          className={cn(
            'flex-1 overflow-y-auto border-border bg-bg-elevated p-4 lg:flex-none lg:border-r',
            mobileTab === 'steps' ? 'block' : 'hidden lg:block',
          )}
        >
          <div className="mb-3 hidden text-xs font-medium uppercase tracking-wider text-fg-subtle lg:block">
            Steps
          </div>
          {/* TODO(phase-3b): "re-run from step N" (§3.4) needs the Phase-3c dispatcher —
              steps are read-only here for now (the disabled button below is a placeholder). */}
          {steps.length === 0 ? (
            <div className="text-xs text-fg-muted">No steps recorded yet.</div>
          ) : (
            <div className="space-y-2">
              {steps.map((s) => (
                <StepCard
                  key={s.id}
                  step={s}
                  events={eventsByStep.get(s.id) ?? []}
                  runner={s.runner_id ? runners[s.runner_id] : undefined}
                />
              ))}
            </div>
          )}
        </div>

        {/* Event log */}
        <div
          className={cn(
            'relative flex-1 flex-col overflow-hidden',
            mobileTab === 'log' ? 'flex' : 'hidden lg:flex',
          )}
        >
          <div className="hidden border-b border-border px-4 py-2 text-xs font-medium uppercase tracking-wider text-fg-subtle lg:block">
            Event log
            {!terminal && (
              <span className="ml-2 inline-flex items-center gap-1 text-fg-subtle">
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />{' '}
                live
              </span>
            )}
          </div>
          <div
            ref={feedRef}
            onScroll={onFeedScroll}
            className="flex-1 overflow-y-auto p-4 font-mono text-xs"
          >
            {events.length === 0 ? (
              <div className="py-8 text-center text-fg-muted">Waiting for events…</div>
            ) : (
              events.map((e) => <EventLine key={e.id} event={e} />)
            )}
          </div>
          {showJump && (
            <button
              onClick={jumpToBottom}
              className="absolute bottom-[calc(1rem+env(safe-area-inset-bottom))] right-4 inline-flex min-h-11 items-center rounded-full border border-border bg-bg-elevated px-4 text-xs text-fg-muted shadow hover:text-fg lg:min-h-0 lg:px-3 lg:py-1"
            >
              ↓ jump to bottom
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex min-h-11 flex-1 items-center justify-center rounded-md border px-3 text-xs font-medium transition-colors',
        active
          ? 'border-border bg-bg-subtle text-fg'
          : 'border-transparent text-fg-muted hover:bg-bg-subtle/60 hover:text-fg',
      )}
    >
      {children}
    </button>
  );
}

function StepCard({
  step,
  events,
  runner,
}: {
  step: AgentRunRow;
  events: AgentRunEventRow[];
  runner?: RunnerLookup[string];
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-border bg-bg p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-fg">{stepLabel(step.step_id)}</span>
          {step.iteration > 1 && <span className="text-xs text-fg-subtle">×{step.iteration}</span>}
        </div>
        <StepStatusBadge status={step.status} />
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-fg-subtle">
        {step.kind && <span>{step.kind}</span>}
        {(step.backend || step.model) && (
          <span>
            {step.backend ?? '?'}
            {step.model ? ` · ${step.model}` : ''}
          </span>
        )}
        {step.tokens_used > 0 && <span>{humanizeTokens(step.tokens_used)} tok</span>}
        {step.started_at && <span>{timeAgo(step.started_at)}</span>}
        {step.runner_id && <RunnerChip runnerId={step.runner_id} runner={runner} />}
      </div>
      {step.summary && <div className="mt-2 text-xs text-fg-muted">{step.summary}</div>}
      {step.error && <div className="mt-2 text-xs text-danger">{step.error}</div>}
      {events.length > 0 && (
        <div className="mt-2">
          <button
            onClick={() => setOpen((v) => !v)}
            className="text-xs text-fg-subtle hover:text-fg"
          >
            {open ? '▾' : '▸'} {events.length} event{events.length === 1 ? '' : 's'}
          </button>
          {open && (
            <div className="mt-1 max-h-64 overflow-y-auto rounded border border-border/60 bg-bg-elevated p-2 font-mono text-xs">
              {events.map((e) => (
                <EventLine key={e.id} event={e} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function shortInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input.slice(0, 80);
  try {
    const s = JSON.stringify(input);
    return s.length > 80 ? s.slice(0, 80) + '…' : s;
  } catch {
    return '';
  }
}

function EventLine({ event }: { event: AgentRunEventRow }) {
  const p = event.payload as Record<string, unknown> | null;
  switch (event.type) {
    case 'lifecycle':
      return (
        <div className="border-l-2 border-accent/30 py-0.5 pl-2 text-fg-muted">
          {(p?.message as string) ?? JSON.stringify(p)}
        </div>
      );
    case 'step-start':
      return (
        <div className="mt-1 py-0.5 pl-2 font-medium text-fg">
          ▶ {(p?.stepId as string) ?? (p?.step_id as string) ?? 'step'} start
        </div>
      );
    case 'step-end':
      return (
        <div className="py-0.5 pl-2 text-fg-subtle">
          ■ {(p?.stepId as string) ?? (p?.step_id as string) ?? 'step'} end
          {p?.status ? ` (${String(p.status)})` : ''}
        </div>
      );
    case 'agent-text':
      return (
        <div className="py-0.5 pl-2 whitespace-pre-wrap text-fg">{(p?.text as string) ?? ''}</div>
      );
    case 'tool-call':
      return (
        <div className="py-0.5 pl-2 text-fg-muted">
          <span className="text-accent">
            ▸ {(p?.tool as string) ?? (p?.name as string) ?? 'tool'}
          </span>
          <span className="ml-1 text-fg-subtle">({shortInput(p?.input ?? p?.args)})</span>
        </div>
      );
    case 'tool-result':
      return <ToolResultLine payload={p} />;
    case 'note':
      return (
        <div className="my-1 rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-amber-300">
          {(p?.message as string) ?? (p?.text as string) ?? JSON.stringify(p)}
        </div>
      );
    default:
      return null;
  }
}

function ToolResultLine({ payload }: { payload: Record<string, unknown> | null }) {
  const [open, setOpen] = useState(false);
  const isError = Boolean(payload?.isError ?? payload?.is_error);
  const raw =
    typeof payload?.result === 'string'
      ? (payload.result as string)
      : typeof payload?.output === 'string'
        ? (payload.output as string)
        : JSON.stringify(payload?.result ?? payload?.output ?? payload ?? '');
  const truncated = raw.length > 200;
  return (
    <div className={cn('py-0.5 pl-2', isError ? 'text-danger' : 'text-fg-subtle')}>
      <button onClick={() => setOpen((v) => !v)} className="hover:text-fg">
        ◂ {open || !truncated ? raw : raw.slice(0, 200) + '…'}
      </button>
      {truncated && <span className="ml-1 text-fg-subtle">[{open ? 'less' : 'more'}]</span>}
    </div>
  );
}

/**
 * Phase 5 — compact runner attribution badge rendered in each step card. When
 * the lookup miss (runner deleted, central preview doesn't ship the joined
 * row yet) we fall back to the last 8 chars of the UUID so the operator still
 * sees *some* attribution. The tooltip exposes status / last heartbeat / GH
 * identity source from the Phase 4 fields.
 */
function RunnerChip({ runnerId, runner }: { runnerId: string; runner?: RunnerLookup[string] }) {
  const label = runner?.name ?? `runner ${runnerId.slice(-8)}`;
  const tip = runner
    ? `${runner.name} · ${runner.status}${runner.lastHeartbeatAt ? ` · heartbeat ${timeAgo(runner.lastHeartbeatAt)}` : ''} · gh: ${runner.ghIdentity}`
    : `runner ${runnerId}`;
  return (
    <ResponsiveTooltip content={tip}>
      <span className="inline-flex items-center gap-1 rounded border border-border bg-bg-elevated px-1.5 py-0.5 font-mono text-xs text-fg-muted lg:text-[10px]">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent/60" aria-hidden />
        {label}
      </span>
    </ResponsiveTooltip>
  );
}

function HeaderBtn({
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
        'inline-flex min-h-11 items-center rounded-md border px-3 text-xs transition-colors disabled:opacity-50 lg:min-h-0 lg:py-1',
        danger
          ? 'border-danger/40 text-danger hover:bg-danger/10'
          : 'border-border text-fg-muted hover:bg-bg-subtle hover:text-fg',
      )}
    >
      {label}
    </button>
  );
}
