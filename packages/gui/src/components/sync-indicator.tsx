'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/components/ui/cn';
import { createSupabaseBrowserClient } from '@/lib/supabase/browser';
import { syncAndDigest } from '@/app/inbox/sync-action';
import type { Database, SyncCounts, SyncPhase, SyncErrorKind } from '@/lib/supabase/types';

type SyncStatusRow = Database['public']['Tables']['sync_status']['Row'];

/** A `syncing` row older than this is abandoned (container restarted mid-sync);
 *  we treat it as idle instead of showing a permanent spinner. Mirrors the
 *  server-side guard in sync-action.ts and sync-button.tsx. */
const STALE_SYNC_MS = 10 * 60 * 1000;

/** A webhook delivery within this window counts as "recent activity" — older
 *  than this and a Live workspace's tooltip softens to "(no recent activity)". */
const WEBHOOK_FRESH_MS = 24 * 60 * 60 * 1000;

const PHASE_LABEL: Record<SyncPhase, string> = {
  issues: 'issues',
  digests: 'digests',
  comments: 'comments',
  prs: 'pull requests',
};

/** Turn the `counts` blob into a short human string, e.g. "346 issues · 65 PRs". */
function summarize(counts: SyncCounts | null | undefined): string | null {
  if (!counts) return null;
  const bits: string[] = [];
  if (counts.issuesFetched)
    bits.push(`${counts.issuesFetched} issue${counts.issuesFetched === 1 ? '' : 's'}`);
  if (counts.digestsCreated) bits.push(`${counts.digestsCreated} digested`);
  if (counts.commentsFetched) bits.push(`${counts.commentsFetched} commented`);
  if (counts.prsUpdated) bits.push(`${counts.prsUpdated} PR${counts.prsUpdated === 1 ? '' : 's'}`);
  return bits.length > 0 ? bits.join(' · ') : null;
}

/** Build the "what changed" delta string (spec §4) from the per-run `counts`,
 *  e.g. "3 new issues · 1 reopened · 2 PRs closed · 1 PR opened". Returns null
 *  when every delta is zero/absent so a no-op sync stays silent. PR merges fold
 *  into `prsClosed` (no merge signal in the sync fetch today), so we render that
 *  bucket as "closed". */
function deltaSummary(counts: SyncCounts | null | undefined): string | null {
  if (!counts) return null;
  const bits: string[] = [];
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (counts.issuesCreated) bits.push(plural(counts.issuesCreated, 'new issue', 'new issues'));
  if (counts.issuesClosed) bits.push(`${counts.issuesClosed} closed`);
  if (counts.issuesReopened) bits.push(`${counts.issuesReopened} reopened`);
  if (counts.prsCreated) bits.push(plural(counts.prsCreated, 'PR opened', 'PRs opened'));
  if (counts.prsMerged) bits.push(plural(counts.prsMerged, 'PR merged', 'PRs merged'));
  if (counts.prsClosed) bits.push(plural(counts.prsClosed, 'PR closed', 'PRs closed'));
  if (counts.prsReopened) bits.push(plural(counts.prsReopened, 'PR reopened', 'PRs reopened'));
  return bits.length > 0 ? bits.join(' · ') : null;
}

/** "5 minutes ago", "2 hours ago", etc. — coarse relative time. */
function relativeTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const diff = Date.now() - then;
  if (diff < 60 * 1000) return 'just now';
  const mins = Math.floor(diff / (60 * 1000));
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

interface SyncIndicatorProps {
  workspaceId: string;
  initialStatus: SyncStatusRow | null;
  readOnly: boolean;
  /** 'manual' workspaces don't auto-sync — the tooltip flags it. */
  syncMode: 'auto' | 'manual';
  /** The reconcile cadence (minutes) — sets the staleness threshold
   *  `max(2 × interval, 30)` for the amber "stale" state (spec §3). */
  syncIntervalMinutes: number;
  /** Live = GitHub App installed + webhook secret set (updates arrive in real
   *  time); Polling = otherwise (falls back to the cron reconcile interval). */
  webhookHealth: 'live' | 'polling';
  /** Last matched webhook delivery — lets the Live line note "no recent activity". */
  lastWebhookAt?: string | null;
}

/**
 * Global sync indicator for the top header. A small dot that reflects the
 * active workspace's live `sync_status` (subscribed over Supabase Realtime),
 * is clickable to trigger a "sync now", and shows a tooltip with the last-sync
 * time + status + counts on hover.
 */
export function SyncIndicator({
  workspaceId,
  initialStatus,
  readOnly,
  syncMode,
  syncIntervalMinutes,
  webhookHealth,
  lastWebhookAt,
}: SyncIndicatorProps) {
  const router = useRouter();
  const [status, setStatus] = useState<SyncStatusRow | null>(initialStatus);
  const [pending, startKickoff] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Refresh exactly once when a sync transitions to a terminal state.
  const wasSyncing = useRef(initialStatus?.status === 'syncing');
  // ── "What changed" toast (spec §4). ──
  // `userInitiated` remembers that the *most recent* run was started by this
  // user's "sync now" click (set in `handleClick`), distinct from a background
  // cron reconcile that merely flips the row over Realtime. We only toast for
  // user-initiated runs so background syncs stay silent.
  const userInitiated = useRef(false);
  const [toast, setToast] = useState<string | null>(null);

  // ── Realtime: follow this workspace's sync_status row. ──
  useEffect(() => {
    if (!workspaceId) return;
    const supabase = createSupabaseBrowserClient();
    const channel = supabase
      .channel(`sync-${workspaceId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'sync_status',
          filter: `workspace_id=eq.${workspaceId}`,
        },
        (payload) => {
          const row = payload.new as Partial<SyncStatusRow>;
          // Ignore DELETE / tombstone payloads (no row data).
          if (!row || !row.workspace_id || !row.status) return;
          setStatus(row as SyncStatusRow);
          if (row.status === 'syncing') {
            wasSyncing.current = true;
          } else if (wasSyncing.current && (row.status === 'done' || row.status === 'error')) {
            // Sync just finished — pull the freshly-synced data into every page.
            wasSyncing.current = false;
            // "What changed" toast (spec §4): only for a user-initiated run that
            // completed (not background reconciles, not the §2 initial import —
            // its progress bar already covers that). No deltas ⇒ "no changes".
            if (userInitiated.current && row.status === 'done' && !row.initial) {
              const deltas = deltaSummary(row.counts);
              setToast(deltas ? `Synced — ${deltas}` : 'Synced — no changes');
            }
            userInitiated.current = false;
            router.refresh();
          }
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [workspaceId, router]);

  // ── "What changed" toast auto-dismiss (spec §4): clears ~5s after it shows. ──
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const isStale =
    status?.status === 'syncing' &&
    Date.now() - new Date(status.updated_at).getTime() > STALE_SYNC_MS;
  const syncing = (status?.status === 'syncing' && !isStale) || pending;
  const isError = !syncing && (Boolean(error) || status?.status === 'error');

  // ── First-import (spec §2): a determinate "Importing" bar. ──
  // `initial` flags the workspace's first full backfill; while it's syncing we
  // surface real progress (n/total digested) instead of the subtle dot.
  const isInitialImport = syncing && Boolean(status?.initial);
  const importProgress = (() => {
    if (!isInitialImport) return null;
    const counts = status?.counts;
    const digestsTotal = counts?.digestsTotal ?? 0;
    const digestsCreated = counts?.digestsCreated ?? 0;
    // Prefer digest progress (the slow phase); fall back to issue fetch during
    // phase 1 before any digest total is known.
    if (digestsTotal > 0) {
      return {
        fraction: Math.min(1, digestsCreated / digestsTotal),
        label: `Importing — ${digestsCreated}/${digestsTotal} digested`,
        indeterminate: false,
      };
    }
    const issuesFetched = counts?.issuesFetched ?? 0;
    const issuesCreated = counts?.issuesCreated ?? 0;
    if (issuesFetched > 0) {
      return {
        fraction: Math.min(1, issuesCreated / issuesFetched),
        label: `Importing — ${issuesCreated}/${issuesFetched} issues`,
        indeterminate: false,
      };
    }
    // No totals yet (very start of phase 1) — show an indeterminate bar.
    return { fraction: 0, label: 'Importing your repo…', indeterminate: true };
  })();

  const lastSyncedAt =
    status?.finished_at ?? (status?.status === 'done' ? status?.updated_at : null);

  // ── Staleness (spec §3): amber when the last successful sync is older than
  // max(2 × interval, 30 min) and nothing is in flight. Suppressed for manual
  // workspaces — they're *expected* to be stale and carry their own tooltip
  // line. Errors take precedence over stale (handled by the `!isError` guard).
  const staleThresholdMs = Math.max(2 * syncIntervalMinutes, 30) * 60 * 1000;
  const isStaleData =
    !syncing &&
    !isError &&
    syncMode !== 'manual' &&
    Boolean(lastSyncedAt) &&
    Date.now() - new Date(lastSyncedAt as string).getTime() > staleThresholdMs;

  // ── Actionable errors (spec §3): map the persisted `error_kind` to copy + an
  // optional CTA. `rate_limit` is transient (amber, no CTA); `auth` is permanent
  // (red, Reconnect); `not_found` is a repo-access problem; unknown/null fall
  // back to the raw message.
  const errorKind: SyncErrorKind | null = (status?.error_kind as SyncErrorKind | null) ?? null;
  // `rate_limit` is transient — render it amber like stale, distinct from the
  // red permanent-failure states (auth / not_found / unknown).
  const isTransientError = isError && errorKind === 'rate_limit';

  function handleClick() {
    if (syncing || readOnly) return;
    setError(null);
    // Mark this run as user-initiated so the syncing→done transition fires the
    // "what changed" toast (background reconciles leave this false).
    userInitiated.current = true;
    startKickoff(async () => {
      const result = await syncAndDigest();
      if (!result.ok) {
        setError(result.error ?? 'Sync failed');
      }
      // On success the Realtime subscription drives the rest; nothing to await.
    });
  }

  // ── Tooltip lines. ──
  // `cta` is an optional recovery action rendered as a real link below the
  // lines (spec §3 — e.g. an `auth` failure → "Reconnect").
  const { lines: tooltip, cta } = ((): {
    lines: string[];
    cta: { label: string; href: string } | null;
  } => {
    const lines: string[] = [];
    if (syncing) {
      if (importProgress) lines.push(importProgress.label);
      else if (status?.message) lines.push(status.message);
      else if (status?.phase) lines.push(`Syncing ${PHASE_LABEL[status.phase]}…`);
      else lines.push('Starting sync…');
      return { lines, cta: null };
    }
    if (isError) {
      // Actionable copy keyed off the persisted classification. A live `error`
      // from a just-failed kickoff has no kind yet, so fall back to the raw text.
      switch (errorKind) {
        case 'auth':
          lines.push('GitHub access expired');
          // Reconnect → the GitHub OAuth sign-in flow (signInWithGitHub), which
          // re-mints the OAuth token the sync falls back to when the App token
          // is unavailable.
          return { lines, cta: { label: 'Reconnect', href: '/login' } };
        case 'rate_limit':
          lines.push('GitHub rate limit — will retry automatically');
          return { lines, cta: null };
        case 'not_found':
          lines.push("Repo not accessible — check the GitHub App's repo access");
          return { lines, cta: null };
        default:
          lines.push(error ?? status?.error ?? 'Sync failed');
          return { lines, cta: null };
      }
    }
    const rel = relativeTime(lastSyncedAt);
    // Stale (spec §3): amber warning when the last successful sync is too old.
    if (isStaleData) {
      lines.push(`Data may be stale — last synced ${rel ?? 'a while ago'}`);
    } else if (rel) lines.push(`Last synced ${rel}`);
    else lines.push('Not synced yet');
    const counts = summarize(status?.counts);
    if (counts) lines.push(counts);
    // Live-vs-Polling: how the data is kept fresh (spec §1). Live = GitHub App
    // installed + receiver active; quiet live repos still count as Live.
    if (webhookHealth === 'live') {
      const recent =
        lastWebhookAt != null && Date.now() - new Date(lastWebhookAt).getTime() < WEBHOOK_FRESH_MS;
      lines.push(recent ? '⚡ Live — updates arrive in real time' : '⚡ Live (no recent activity)');
    } else {
      lines.push('⏱ Polling — install the GitHub App for real-time updates');
    }
    // Flag manual workspaces — the cron won't auto-sync; the user drives it.
    if (syncMode === 'manual') {
      lines.push(readOnly ? 'Auto-sync off' : 'Auto-sync off — click to sync');
    }
    return { lines, cta: null };
  })();

  // Sync-icon color (traffic light): green when up to date, amber/yellow when
  // data is stale or a transient rate-limit is in play, red when sync isn't
  // possible (permanent failure). While syncing the icon spins in the primary
  // tint; a never-synced workspace stays muted/neutral.
  const iconColor = syncing
    ? 'text-primary animate-spin'
    : isError
      ? 'text-error'
      : isTransientError || isStaleData
        ? 'text-tertiary'
        : lastSyncedAt
          ? 'text-emerald-400'
          : 'text-on-surface-variant';

  const aria = syncing ? 'Syncing…' : isError ? 'Sync failed' : 'Sync now';

  return (
    <div className="group relative flex items-center">
      <button
        type="button"
        disabled={syncing || readOnly}
        onClick={handleClick}
        aria-label={aria}
        className={cn(
          'flex h-9 items-center justify-center gap-2 rounded-md px-2 text-on-surface-variant transition-colors',
          // Initial import gets extra width for the inline bar; otherwise stay
          // a compact 9×9 dot button.
          importProgress ? '' : 'w-9 px-0',
          readOnly ? 'cursor-default' : 'hover:bg-surface-container hover:text-on-surface',
          syncing && 'cursor-wait',
        )}
      >
        <SyncIcon className={cn('h-4 w-4 shrink-0 transition-colors', iconColor)} />
        {/* First-import (spec §2): a thin determinate bar + count, replacing the
         *  bare pulsing dot so the slow onboarding import shows real progress. */}
        {importProgress && (
          <span className="flex items-center gap-1.5" aria-hidden>
            <span className="h-1 w-16 overflow-hidden rounded-full bg-surface-container-highest">
              <span
                className={cn(
                  'block h-full rounded-full bg-primary',
                  importProgress.indeterminate
                    ? 'w-1/3 animate-pulse'
                    : 'transition-[width] duration-500',
                )}
                style={
                  importProgress.indeterminate
                    ? undefined
                    : { width: `${Math.round(importProgress.fraction * 100)}%` }
                }
              />
            </span>
            <span className="whitespace-nowrap text-[10px] tabular-nums text-on-surface-variant">
              {(status?.counts?.digestsTotal ?? 0) > 0
                ? `${status?.counts?.digestsCreated ?? 0}/${status?.counts?.digestsTotal}`
                : 'Importing'}
            </span>
          </span>
        )}
      </button>

      {/* Tooltip — appears on hover, right-aligned under the dot. When it carries
       *  a CTA (e.g. Reconnect) it becomes interactive so the link is clickable. */}
      <div
        role="tooltip"
        className={cn(
          'absolute right-0 top-full z-20 mt-1 hidden w-max max-w-[260px] rounded-md border border-outline-variant bg-surface-container-high px-3 py-2 text-xs shadow-ambient group-hover:block',
          cta ? 'pointer-events-auto' : 'pointer-events-none',
        )}
      >
        <div className="font-medium text-on-surface">
          {syncing
            ? 'Syncing'
            : isError
              ? 'Sync failed'
              : isStaleData
                ? 'Data may be stale'
                : readOnly
                  ? 'Sync status'
                  : 'Sync now'}
        </div>
        {tooltip.map((line, i) => (
          <div
            key={i}
            className={cn(
              'mt-0.5',
              i === 0 && isTransientError
                ? 'text-tertiary'
                : i === 0 && isError
                  ? 'text-error'
                  : i === 0 && isStaleData
                    ? 'text-tertiary'
                    : 'text-on-surface-variant',
            )}
          >
            {line}
          </div>
        ))}
        {cta && (
          <a
            href={cta.href}
            className="mt-1.5 inline-flex items-center rounded-md bg-primary-container px-2 py-1 text-xs font-medium text-primary-on-container hover:bg-primary-container/90"
          >
            {cta.label}
          </a>
        )}
      </div>

      {/* "What changed" toast (spec §4) — a transient popover anchored under the
       *  icon, shown only after a user-initiated "sync now" completes. Auto-
       *  dismisses after ~5s; dismissable on click. */}
      {toast && (
        <div
          role="status"
          onClick={() => setToast(null)}
          className="absolute right-0 top-full z-30 mt-1 w-max max-w-[280px] cursor-pointer rounded-md border border-outline-variant bg-surface-container-high px-3 py-2 text-xs text-on-surface shadow-ambient"
        >
          {toast}
        </div>
      )}
    </div>
  );
}

/** Two-arrow "sync" glyph (Feather refresh-cw). Color + spin come from the
 *  caller via `className` so the status palette / animation stay in one place. */
function SyncIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}
