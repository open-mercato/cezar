'use client';

import Link from 'next/link';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './ui/cn';
import { RUN_STATUS_PALETTE } from './run-status-palette';
import type { ActionRunSummary, RunStatus } from '@/lib/action-runs-loader';

// ─────────────────────────────────────────────────────────────────────
// Multi-dot run-status indicator with a portaled hover tooltip.
// Used by /issues and /prs tables. One dot per agent_run (= one action
// run on this issue / PR), capped at MAX_VISIBLE_DOTS; overflow renders
// as a "+N" pill that opens a tooltip listing the rest.
//
// Tooltip lives in a portal so it escapes the table's overflow chrome.
// Hover-with-grace pattern: 80ms open delay, 120ms close delay, and the
// tooltip itself counts as "still hovered" so the pointer can move into
// it without flicker.
// ─────────────────────────────────────────────────────────────────────

const MAX_VISIBLE_DOTS = 5;
const OPEN_DELAY_MS = 80;
const CLOSE_DELAY_MS = 120;

export interface RunStatusDotsProps {
  runs: ActionRunSummary[];
  /** Empty-state placeholder height — preserves column width when no runs. */
  emptyClassName?: string;
}

export function RunStatusDots({ runs, emptyClassName }: RunStatusDotsProps) {
  if (runs.length === 0) {
    return <span className={cn('block h-[18px] w-[18px]', emptyClassName)} aria-label="no runs" />;
  }
  const visible = runs.slice(0, MAX_VISIBLE_DOTS);
  const overflow = Math.max(0, runs.length - MAX_VISIBLE_DOTS);
  return (
    <div className="flex items-center gap-1.5">
      {visible.map((run) => (
        <RunDot key={run.agentRunId} run={run} />
      ))}
      {overflow > 0 && <OverflowPill count={overflow} runs={runs.slice(MAX_VISIBLE_DOTS)} />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Single dot + tooltip
// ─────────────────────────────────────────────────────────────────────
function RunDot({ run }: { run: ActionRunSummary }) {
  const dotRef = useRef<HTMLAnchorElement | null>(null);
  const [hover, setHover] = useState(false);
  return (
    <HoverPopover
      anchorRef={dotRef}
      hover={hover}
      setHover={setHover}
      tooltip={<RunTooltip run={run} />}
    >
      <Link
        ref={dotRef}
        href={`/cockpit/${run.workflowRunId}`}
        aria-label={`${run.actionName} — ${run.status}`}
        className={cn(
          'inline-block h-[14px] w-[14px] rounded-full ring-1 ring-inset ring-black/20 transition-transform',
          RUN_STATUS_PALETTE[run.status].dot,
          run.status === 'running' && 'animate-pulse',
          'hover:scale-125 focus-visible:outline-none focus-visible:scale-125 focus-visible:ring-2 focus-visible:ring-primary',
        )}
      />
    </HoverPopover>
  );
}

function OverflowPill({ count, runs }: { count: number; runs: ActionRunSummary[] }) {
  const pillRef = useRef<HTMLButtonElement | null>(null);
  const [hover, setHover] = useState(false);
  return (
    <HoverPopover
      anchorRef={pillRef}
      hover={hover}
      setHover={setHover}
      tooltip={<OverflowTooltip runs={runs} />}
    >
      <button
        ref={pillRef}
        type="button"
        className="inline-flex h-[16px] min-w-[20px] items-center justify-center rounded-full border border-outline-variant bg-surface-container px-1 font-mono text-[10px] text-on-surface-variant hover:border-outline hover:text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        aria-label={`${count} more action ${count === 1 ? 'run' : 'runs'}`}
      >
        +{count}
      </button>
    </HoverPopover>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Tooltip content
// ─────────────────────────────────────────────────────────────────────
function RunTooltip({ run }: { run: ActionRunSummary }) {
  const ranAt = new Date(run.startedAt);
  const durationMs = run.finishedAt
    ? Math.max(0, new Date(run.finishedAt).getTime() - ranAt.getTime())
    : null;
  return (
    <div className="w-[min(320px,calc(100vw-16px))] text-xs leading-relaxed">
      <header className="flex items-start justify-between gap-3 border-b border-outline-variant/60 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'h-2.5 w-2.5 shrink-0 rounded-full',
                RUN_STATUS_PALETTE[run.status].dot,
              )}
            />
            <span className="truncate font-mono text-[12px] font-semibold uppercase tracking-wider text-on-surface">
              {run.actionName}
            </span>
          </div>
          <div className="mt-1 truncate text-[11px] text-on-surface-variant">
            workflow · <span className="text-on-surface">{run.workflow}</span>
          </div>
        </div>
        <StatusChip status={run.status} />
      </header>

      <div className="space-y-2 px-3 py-2.5">
        <Row label={statusVerb(run.status, !!run.finishedAt)}>
          {formatRelative(run.startedAt)}
          {durationMs !== null && (
            <span className="text-on-surface-variant"> · {formatDuration(durationMs)}</span>
          )}
        </Row>

        {run.findingsCount > 0 && (
          <Row label="Findings">
            <Link href="/inbox" className="text-primary hover:underline">
              {run.findingsCount} pending {run.findingsCount === 1 ? 'decision' : 'decisions'} →
            </Link>
          </Row>
        )}

        {run.summary && (
          <Row label="Summary">
            <span className="text-on-surface-variant">{truncate(run.summary, 180)}</span>
          </Row>
        )}

        {run.status === 'failed' && run.error && (
          <Row label="Error">
            <span className="text-error">{truncate(run.error, 180)}</span>
          </Row>
        )}
      </div>

      <footer className="flex items-center justify-between border-t border-outline-variant/60 bg-surface-container/60 px-3 py-2">
        <Link
          href={`/cockpit/${run.workflowRunId}`}
          className="text-[11px] font-medium text-primary hover:underline"
        >
          View run →
        </Link>
        <span className="font-mono text-[10px] text-outline">{run.agentRunId.slice(0, 8)}</span>
      </footer>
    </div>
  );
}

function OverflowTooltip({ runs }: { runs: ActionRunSummary[] }) {
  return (
    <div className="max-h-[320px] w-[min(320px,calc(100vw-16px))] overflow-y-auto py-1.5">
      <div className="px-3 py-1 font-display text-[10px] font-semibold uppercase tracking-wider text-outline">
        Older runs
      </div>
      <ul className="divide-y divide-outline-variant/40">
        {runs.map((r) => (
          <li key={r.agentRunId}>
            <Link
              href={`/cockpit/${r.workflowRunId}`}
              className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-surface-container/60"
            >
              <span
                className={cn('h-2 w-2 shrink-0 rounded-full', RUN_STATUS_PALETTE[r.status].dot)}
              />
              <span className="truncate font-mono text-on-surface">{r.actionName}</span>
              <span className="ml-auto shrink-0 text-[10px] text-outline">
                {formatRelative(r.startedAt)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-[60px] shrink-0 font-display text-[10px] font-semibold uppercase tracking-wider text-outline">
        {label}
      </span>
      <span className="min-w-0 flex-1 text-on-surface">{children}</span>
    </div>
  );
}

function StatusChip({ status }: { status: RunStatus }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 font-display text-[9.5px] font-semibold uppercase tracking-wider',
        RUN_STATUS_PALETTE[status].chip,
      )}
    >
      {status === 'queued' ? 'enqueued' : status}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Portal popover with hover-grace timing
// ─────────────────────────────────────────────────────────────────────
function HoverPopover({
  anchorRef,
  hover,
  setHover,
  tooltip,
  children,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  hover: boolean;
  setHover: (h: boolean) => void;
  tooltip: ReactNode;
  children: ReactNode;
}) {
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [coarse, setCoarse] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);

  // Coarse pointers (touch) get no hover events — detect and switch to a
  // tap-to-toggle interaction instead, keeping the hover path for `pointer:fine`.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(pointer: coarse)');
    const update = () => setCoarse(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  // Defer opening by OPEN_DELAY_MS to avoid noisy flicker as the cursor
  // brushes past rows of dots. Close has its own grace so mouse can travel
  // from anchor into the tooltip. Skipped on coarse pointers (tap-driven).
  useEffect(() => {
    if (coarse) return;
    if (hover) {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      showTimer.current = setTimeout(() => setOpen(true), OPEN_DELAY_MS);
    } else {
      if (showTimer.current) clearTimeout(showTimer.current);
      hideTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
    }
    return () => {
      if (showTimer.current) clearTimeout(showTimer.current);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [hover, coarse]);

  // Esc closes immediately.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Coarse-pointer (tap) variant: dismiss on outside tap / scroll, like the
  // shared ResponsiveTooltip. The trigger itself toggles via onClick below.
  useEffect(() => {
    if (!open || !coarse) return;
    function onDown(e: Event) {
      const t = e.target as Node | null;
      if (t && wrapRef.current?.contains(t)) return;
      setOpen(false);
    }
    const onScroll = () => setOpen(false);
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, coarse]);

  return (
    <span
      ref={wrapRef}
      onMouseEnter={() => !coarse && setHover(true)}
      onMouseLeave={() => !coarse && setHover(false)}
      onFocus={() => !coarse && setHover(true)}
      onBlur={() => !coarse && setHover(false)}
      onClick={(e) => {
        if (!coarse) return;
        // The dot is a <Link>; on touch the first tap should reveal the
        // tooltip rather than navigate. Suppress navigation while closed.
        if (!open) e.preventDefault();
        e.stopPropagation();
        setOpen((v) => !v);
      }}
      className="inline-flex"
    >
      {children}
      {open && (
        <TooltipPortal
          anchorRef={anchorRef}
          onEnter={() => setHover(true)}
          onLeave={() => setHover(false)}
        >
          {tooltip}
        </TooltipPortal>
      )}
    </span>
  );
}

const TOOLTIP_MARGIN = 6;
const VIEWPORT_PAD = 8;

function TooltipPortal({
  anchorRef,
  onEnter,
  onLeave,
  children,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  onEnter: () => void;
  onLeave: () => void;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Re-run when `mounted` flips so the portal DOM is present for measurement;
  // refs alone don't trigger effect re-runs. Without `mounted` here the
  // tooltip stays at top:-9999.
  useLayoutEffect(() => {
    if (!mounted) return;
    const anchor = anchorRef.current;
    const pop = popRef.current;
    if (!anchor || !pop) return;
    const anchorRect = anchor.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    const spaceBelow = window.innerHeight - anchorRect.bottom;
    const wantsAbove = spaceBelow < popRect.height + TOOLTIP_MARGIN + VIEWPORT_PAD;
    const top = wantsAbove
      ? Math.max(VIEWPORT_PAD, anchorRect.top - popRect.height - TOOLTIP_MARGIN)
      : anchorRect.bottom + TOOLTIP_MARGIN;
    const rawLeft = anchorRect.left + anchorRect.width / 2 - popRect.width / 2;
    const left = Math.min(
      Math.max(VIEWPORT_PAD, rawLeft),
      window.innerWidth - popRect.width - VIEWPORT_PAD,
    );
    setCoords({ top, left });
  }, [anchorRef, mounted]);

  if (!mounted) return null;
  return createPortal(
    <div
      ref={popRef}
      role="tooltip"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{
        position: 'fixed',
        top: coords?.top ?? -9999,
        left: coords?.left ?? -9999,
        opacity: coords ? 1 : 0,
      }}
      className="z-tooltip overflow-hidden rounded-md border border-outline-variant bg-surface-container-high shadow-ambient"
    >
      {children}
    </div>,
    document.body,
  );
}

function statusVerb(status: RunStatus, finished: boolean): string {
  if (status === 'running') return 'Running';
  if (status === 'queued') return 'Enqueued';
  if (status === 'paused') return 'Paused';
  if (!finished) return 'Started';
  if (status === 'succeeded') return 'Succeeded';
  if (status === 'failed') return 'Failed';
  return 'Skipped';
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  return remS === 0 ? `${m}m` : `${m}m${remS}s`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
