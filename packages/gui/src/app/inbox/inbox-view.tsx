'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/components/ui/cn';
import {
  CheckIcon,
  ChevronDownIcon,
  MoreVerticalIcon,
  PlayIcon,
  RefreshIcon,
  RotateLeftIcon,
  SparkleSmallIcon,
  StatusDotIcon,
} from '@/components/icons';
import { RowMenuPortal } from '@/components/row-menu-portal';
import { createSupabaseBrowserClient } from '@/lib/supabase/browser';
import type {
  DecisionItem,
  FailedItem,
  Finding,
  InboxItem,
  PausedItem,
  PrItem,
  SkillTag,
} from './mock-data';
import type { ActionFilterOption } from './load-inbox';
import {
  acceptDecision,
  acceptDecisions,
  dismissDecision,
  dismissDecisions,
  snoozeDecision,
} from './decision-actions';
import { syncAndDigest } from './sync-action';

// ─────────────────────────────────────────────────────────────────────
// Skill palette — each skill gets its own accent so confidence pills
// and tags are visually distinct at a glance.
// ─────────────────────────────────────────────────────────────────────
const SKILL_STYLE: Record<SkillTag, { tag: string; pill: string; dot: string }> = {
  DUPLICATES: {
    tag: 'text-tertiary',
    pill: 'bg-tertiary/15 text-tertiary border-tertiary/30',
    dot: 'bg-tertiary',
  },
  LOG_ANALYZER: {
    tag: 'text-primary',
    pill: 'bg-primary/15 text-primary border-primary/30',
    dot: 'bg-primary',
  },
  SEMANTIC_SEARCH: {
    tag: 'text-tertiary',
    pill: 'bg-tertiary/15 text-tertiary border-tertiary/30',
    dot: 'bg-tertiary',
  },
  LINT_MASTER: {
    tag: 'text-primary',
    pill: 'bg-primary/15 text-primary border-primary/30',
    dot: 'bg-primary',
  },
  BUG_DETECTOR: {
    tag: 'text-error',
    pill: 'bg-error/15 text-error border-error/30',
    dot: 'bg-error',
  },
  PRIORITY: {
    tag: 'text-secondary',
    pill: 'bg-secondary/15 text-secondary border-secondary/30',
    dot: 'bg-secondary',
  },
  AUTO_LABEL: {
    tag: 'text-emerald-300',
    pill: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
    dot: 'bg-emerald-400',
  },
};

const CONFIDENCE_FILTERS = [
  { id: 'all', label: 'All', threshold: 0 },
  { id: '90', label: '> 90%', threshold: 90 },
  { id: '80', label: '> 80%', threshold: 80 },
  { id: '70', label: '> 70%', threshold: 70 },
] as const;

interface SkillFilterOption {
  /** Action name (or 'all'). Compared against `Finding.actionName`. */
  id: string;
  label: string;
}

const ALL_SKILLS_OPTION: SkillFilterOption = { id: 'all', label: 'All skills' };

// Client-side mirror of the server-side sync cooldown (see sync-action.ts /
// migration 0029). Keeps the button disabled for the same window so the user
// can't fire calls the server will only reject.
const SYNC_COOLDOWN_MS = 30_000;

// Humanize an action name like 'log-analyzer' → 'Log analyzer'. The action
// name is the canonical identifier; the label is purely presentational.
function humanizeActionName(name: string): string {
  if (!name) return name;
  const spaced = name.replace(/[-_]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const TYPE_FILTERS = [
  { id: 'all', label: 'All types' },
  { id: 'decision', label: 'Pending decisions' },
  { id: 'pr', label: 'PRs to review' },
  { id: 'paused', label: 'Paused runs' },
  { id: 'failed', label: 'Failed runs' },
] as const;

// ─────────────────────────────────────────────────────────────────────

interface InboxViewProps {
  workspaceId: string;
  initialItems: InboxItem[];
  syncedAt: number;
  healthAlerts: { id: string; text: string; severity: 'warn' | 'error' }[];
  actionNames: ActionFilterOption[];
}

export function InboxView({
  workspaceId,
  initialItems,
  syncedAt: initialSyncedAt,
  healthAlerts,
  actionNames,
}: InboxViewProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [items, setItems] = useState<InboxItem[]>(initialItems);

  // Keep local state in sync when the server re-fetches.
  useEffect(() => {
    setItems(initialItems);
  }, [initialItems]);

  // ── Realtime: refresh-on-event (spec §9.3 — start with refresh, upgrade
  // to per-row patching only if perceptible lag appears). Two channels:
  // one for the pending_decisions queue, one for workflow_runs since the
  // inbox renders paused + failed runs from that table.
  useEffect(() => {
    if (!workspaceId) return;
    const supabase = createSupabaseBrowserClient();
    const filter = `workspace_id=eq.${workspaceId}`;
    const channel = supabase
      .channel(`inbox-${workspaceId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'pending_decisions', filter },
        () => router.refresh(),
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'workflow_runs', filter },
        () => router.refresh(),
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'workflow_runs', filter },
        () => router.refresh(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [workspaceId, router]);

  // Build the dynamic skill filter list from real action names. The
  // 'all' option is always present; the rest mirrors whatever the loader
  // surfaced from the actions table.
  const skillFilters = useMemo<SkillFilterOption[]>(() => {
    return [
      ALL_SKILLS_OPTION,
      ...actionNames.map((a) => ({ id: a.name, label: humanizeActionName(a.name) })),
    ];
  }, [actionNames]);

  const [selectedFindings, setSelectedFindings] = useState<Set<string>>(new Set());
  const [confidenceFilter, setConfidenceFilter] = useState<(typeof CONFIDENCE_FILTERS)[number]>(
    CONFIDENCE_FILTERS[2], // > 80%
  );
  const [skillFilter, setSkillFilter] = useState<SkillFilterOption>(ALL_SKILLS_OPTION);
  // Fall back to "All skills" if the filtered-on action vanishes from the
  // server response (e.g. all its pending decisions got drained).
  useEffect(() => {
    if (skillFilter.id === 'all') return;
    if (!skillFilters.some((s) => s.id === skillFilter.id)) {
      setSkillFilter(ALL_SKILLS_OPTION);
    }
  }, [skillFilters, skillFilter]);
  const [typeFilter, setTypeFilter] = useState<(typeof TYPE_FILTERS)[number]>(TYPE_FILTERS[0]);
  const [syncing, setSyncing] = useState(false);
  const [syncedAt, setSyncedAt] = useState<number>(initialSyncedAt);
  // Epoch-ms until which the sync button stays disabled — mirrors the
  // server-side cooldown so we don't fire calls the server will reject.
  const [cooldownUntil, setCooldownUntil] = useState<number>(0);
  const [, forceCooldownTick] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  // ── derived counts / filters ──
  const counts = useMemo(() => {
    let decisions = 0;
    let prs = 0;
    let paused = 0;
    let failed = 0;
    for (const it of items) {
      if (it.kind === 'decision') decisions += it.findings.length;
      else if (it.kind === 'pr') prs += 1;
      else if (it.kind === 'paused') paused += 1;
      else if (it.kind === 'failed') failed += 1;
    }
    return { decisions, prs, paused, failed };
  }, [items]);

  const visibleItems = useMemo(() => {
    return items
      .map((it) => {
        if (typeFilter.id !== 'all' && it.kind !== typeFilter.id) return null;
        if (it.kind !== 'decision') return it;
        // Filter findings within decisions. `skill` is visual-only;
        // the filter axis is the canonical `actionName`.
        const filtered = it.findings.filter((f) => {
          if (f.confidence < confidenceFilter.threshold) return false;
          if (skillFilter.id !== 'all' && f.actionName !== skillFilter.id) return false;
          return true;
        });
        if (filtered.length === 0) return null;
        return { ...it, findings: filtered };
      })
      .filter((x): x is InboxItem => x !== null);
  }, [items, confidenceFilter, skillFilter, typeFilter]);

  // ── selection helpers ──
  const allVisibleFindingIds = useMemo(() => {
    const ids: string[] = [];
    for (const it of visibleItems) {
      if (it.kind === 'decision') {
        for (const f of it.findings) ids.push(f.id);
      }
    }
    return ids;
  }, [visibleItems]);

  const toggleFinding = useCallback((id: string) => {
    setSelectedFindings((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAllForIssue = useCallback((item: DecisionItem, select: boolean) => {
    setSelectedFindings((prev) => {
      const next = new Set(prev);
      for (const f of item.findings) {
        if (select) next.add(f.id);
        else next.delete(f.id);
      }
      return next;
    });
  }, []);

  const selectAllVisible = useCallback(() => {
    setSelectedFindings(new Set(allVisibleFindingIds));
  }, [allVisibleFindingIds]);

  const clearSelection = useCallback(() => setSelectedFindings(new Set()), []);

  // ── mutations — wired to real server actions ──
  // Optimistic local removal keeps the UI snappy; router.refresh re-fetches
  // server state to reconcile any errors or sibling-tab changes.
  const acceptOne = useCallback(
    (findingId: string) => {
      setItems((prev) => removeFindingFromItems(prev, [findingId]));
      setSelectedFindings((prev) => {
        const next = new Set(prev);
        next.delete(findingId);
        return next;
      });
      startTransition(async () => {
        const result = await acceptDecision(findingId);
        if (!result.ok) setToast(`Accept failed: ${result.error ?? 'unknown'}`);
        else setToast('Accepted finding');
        router.refresh();
      });
    },
    [router],
  );

  const dismissOne = useCallback(
    (findingId: string) => {
      setItems((prev) => removeFindingFromItems(prev, [findingId]));
      setSelectedFindings((prev) => {
        const next = new Set(prev);
        next.delete(findingId);
        return next;
      });
      startTransition(async () => {
        const result = await dismissDecision(findingId);
        if (!result.ok) setToast(`Dismiss failed: ${result.error ?? 'unknown'}`);
        else setToast('Dismissed finding');
        router.refresh();
      });
    },
    [router],
  );

  const snoozeOne = useCallback(
    (findingId: string, hours = 24) => {
      // Same optimistic removal as dismiss — the row hides until the
      // snooze expires; the server-side loader excludes future-expiry rows.
      setItems((prev) => removeFindingFromItems(prev, [findingId]));
      setSelectedFindings((prev) => {
        const next = new Set(prev);
        next.delete(findingId);
        return next;
      });
      startTransition(async () => {
        const result = await snoozeDecision(findingId, hours);
        if (!result.ok) setToast(`Snooze failed: ${result.error ?? 'unknown'}`);
        else setToast(`Snoozed for ${hours}h`);
        router.refresh();
      });
    },
    [router],
  );

  // Single-row items (PR / paused / failed) — the buttons today are no-op
  // placeholders that just deep-link. We remove them locally for UX feedback
  // and let router.refresh re-hydrate on the next load.
  const removeItem = useCallback(
    (itemId: string, verb: string) => {
      setItems((prev) => prev.filter((it) => it.id !== itemId));
      setToast(verb);
    },
    [],
  );

  const bulkAccept = useCallback(() => {
    const ids = Array.from(selectedFindings);
    if (ids.length === 0) return;
    setItems((prev) => removeFindingFromItems(prev, ids));
    setSelectedFindings(new Set());
    startTransition(async () => {
      const result = await acceptDecisions(ids);
      if (!result.ok) {
        const failed = result.results?.filter((r) => !r.ok).length ?? ids.length;
        setToast(`${ids.length - failed}/${ids.length} accepted · ${failed} failed`);
      } else {
        setToast(`Accepted ${ids.length} finding${ids.length === 1 ? '' : 's'}`);
      }
      router.refresh();
    });
  }, [selectedFindings, router]);

  const bulkDismiss = useCallback(() => {
    const ids = Array.from(selectedFindings);
    if (ids.length === 0) return;
    setItems((prev) => removeFindingFromItems(prev, ids));
    setSelectedFindings(new Set());
    startTransition(async () => {
      const result = await dismissDecisions(ids);
      if (!result.ok) setToast(`Dismiss failed: ${result.error ?? 'unknown'}`);
      else setToast(`Dismissed ${ids.length} finding${ids.length === 1 ? '' : 's'}`);
      router.refresh();
    });
  }, [selectedFindings, router]);

  const handleSync = useCallback(async () => {
    if (Date.now() < cooldownUntil) return;
    setSyncing(true);
    const result = await syncAndDigest();
    setSyncing(false);
    if (!result.ok) {
      // The server enforces its own cooldown; mirror it client-side so the
      // button stays disabled for the same window instead of letting the
      // user keep firing rejected calls.
      if (result.retryAfter) setCooldownUntil(Date.now() + result.retryAfter * 1000);
      setToast(`Sync failed: ${result.error ?? 'unknown'}`);
      return;
    }
    setSyncedAt(Date.now());
    setCooldownUntil(Date.now() + SYNC_COOLDOWN_MS);
    const bits: string[] = [];
    if (result.issuesFetched) {
      const created = result.issuesCreated ?? 0;
      const updated = result.issuesUpdated ?? 0;
      bits.push(`${result.issuesFetched} issue${result.issuesFetched === 1 ? '' : 's'} (${created} new · ${updated} updated)`);
    }
    if (result.digestsCreated) bits.push(`${result.digestsCreated} digested`);
    if (result.commentsFetched) bits.push(`${result.commentsFetched} commented`);
    if (result.prsUpdated) bits.push(`${result.prsUpdated} PR${result.prsUpdated === 1 ? '' : 's'}`);
    let summary = bits.length > 0 ? `Synced: ${bits.join(' · ')}` : 'Already up to date';
    if (result.truncated) summary += ' · more to digest — sync again in a minute';
    setToast(summary);
    router.refresh();
  }, [router, cooldownUntil]);

  // ── keyboard: Cmd+A / Ctrl+A selects all visible findings ──
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
        e.preventDefault();
        selectAllVisible();
      } else if (e.key === 'Escape') {
        clearSelection();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectAllVisible, clearSelection]);

  // ── toast auto-dismiss ──
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1800);
    return () => clearTimeout(t);
  }, [toast]);

  // ── re-enable the sync button when the cooldown elapses ──
  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const t = setTimeout(() => forceCooldownTick((n) => n + 1), cooldownUntil - Date.now());
    return () => clearTimeout(t);
  }, [cooldownUntil]);

  const inCooldown = cooldownUntil > Date.now();

  const pendingTotal = counts.decisions;
  const hasAny = visibleItems.length > 0;
  const allFilteredOut = !hasAny && items.length > 0;

  return (
    <div className="relative mx-auto max-w-[1080px] px-8 py-6 pb-32">
      {/* ── HEADER ── */}
      <header className="mb-6">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h1 className="font-display text-[28px] font-semibold leading-tight tracking-tight text-on-surface">
              Inbox
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-on-surface-variant">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 font-mono text-[12px] text-primary">
                {pendingTotal} pending decisions
              </span>
              <Metric value={counts.prs} label="PRs to review" tone={counts.prs > 0 ? 'accent' : 'muted'} />
              <Metric value={counts.paused} label="paused" tone={counts.paused > 0 ? 'warn' : 'muted'} />
              <Metric value={counts.failed} label="failed" tone={counts.failed > 0 ? 'danger' : 'muted'} />
              <span className="text-xs text-outline">
                Queue synced <RelativeTime ts={syncedAt} />
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={handleSync}
            disabled={syncing || inCooldown}
            title={inCooldown ? 'Synced moments ago — wait a few seconds before retrying' : undefined}
            className={cn(
              'inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium transition-colors',
              syncing || inCooldown
                ? 'cursor-not-allowed border-outline-variant bg-surface-container text-on-surface-variant'
                : 'border-primary/40 bg-primary/10 text-primary hover:border-primary/60 hover:bg-primary/15',
              syncing && 'cursor-wait',
            )}
          >
            <RefreshIcon className={cn('h-4 w-4', syncing && 'animate-spin')} />
            {syncing ? 'Syncing…' : inCooldown ? 'Synced just now' : 'Sync & Digest'}
          </button>
        </div>
      </header>

      {/* ── FILTER ROW ── */}
      <div className="mb-5 flex flex-wrap items-center gap-2 border-b border-outline-variant pb-4">
        <FilterDropdown
          label="Skill"
          value={skillFilter.label}
          options={skillFilters}
          selectedId={skillFilter.id}
          onSelect={(opt) => setSkillFilter(opt)}
        />
        <FilterDropdown
          label="Confidence"
          value={confidenceFilter.label}
          options={CONFIDENCE_FILTERS.map((c) => ({ id: c.id, label: c.label }))}
          selectedId={confidenceFilter.id}
          onSelect={(opt) => {
            const found = CONFIDENCE_FILTERS.find((c) => c.id === opt.id);
            if (found) setConfidenceFilter(found);
          }}
        />
        <FilterDropdown
          label="Type"
          value={typeFilter.label}
          options={TYPE_FILTERS.map((t) => ({ id: t.id, label: t.label }))}
          selectedId={typeFilter.id}
          onSelect={(opt) => {
            const found = TYPE_FILTERS.find((t) => t.id === opt.id);
            if (found) setTypeFilter(found);
          }}
        />
        <div className="ml-auto hidden items-center gap-1.5 text-xs text-outline md:flex">
          <Kbd>⌘</Kbd>
          <Kbd>A</Kbd>
          <span>to select all visible</span>
        </div>
      </div>

      {/* ── FEED ── */}
      {!hasAny ? (
        <EmptyState filteredOut={allFilteredOut} onClear={() => {
          setConfidenceFilter(CONFIDENCE_FILTERS[0]);
          setSkillFilter(ALL_SKILLS_OPTION);
          setTypeFilter(TYPE_FILTERS[0]);
        }} />
      ) : (
        <div className="flex flex-col gap-3">
          {visibleItems.map((it) => {
            switch (it.kind) {
              case 'decision':
                return (
                  <DecisionCard
                    key={it.id}
                    item={it}
                    selectedFindings={selectedFindings}
                    onToggleFinding={toggleFinding}
                    onToggleAll={(sel) => toggleAllForIssue(it, sel)}
                    onAccept={(id) => acceptOne(id)}
                    onDismiss={(id) => dismissOne(id)}
                    onSnooze={(id) => snoozeOne(id)}
                  />
                );
              case 'pr':
                return <PrCard key={it.id} item={it} onReview={() => removeItem(it.id, 'Opened PR review')} />;
              case 'paused':
                return <PausedCard key={it.id} item={it} onResolve={() => removeItem(it.id, 'Gate resolved')} />;
              case 'failed':
                return <FailedCard key={it.id} item={it} onRetry={() => removeItem(it.id, 'Run retried')} />;
            }
          })}
        </div>
      )}

      {/* ── HEALTH FOOTER ── */}
      {healthAlerts.length > 0 && (
        <div className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-outline-variant pt-4 text-xs text-on-surface-variant">
          <span className="font-medium text-tertiary">System health</span>
          {healthAlerts.map((alert) => (
            <span key={alert.id} className="inline-flex items-center gap-1.5">
              <StatusDotIcon className="h-2.5 w-2.5" tone={alert.severity === 'error' ? 'error' : 'warning'} />
              {alert.text}
            </span>
          ))}
        </div>
      )}

      {/* ── BULK ACTION BAR ── */}
      {selectedFindings.size > 0 && (
        <div className="fixed inset-x-0 bottom-6 z-30 flex justify-center px-4">
          <div className="flex items-center gap-3 rounded-xl border border-primary/40 bg-surface-container-high px-5 py-3 shadow-ambient">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-mono text-primary">{selectedFindings.size}</span>
              <span className="text-on-surface-variant">selected</span>
              <button
                type="button"
                onClick={clearSelection}
                className="ml-1 text-xs text-outline hover:text-on-surface-variant"
              >
                Deselect all
              </button>
            </div>
            <div className="mx-2 h-5 w-px bg-outline-variant" />
            <button
              type="button"
              onClick={bulkAccept}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-on hover:bg-primary-container"
            >
              <CheckIcon className="h-3.5 w-3.5" />
              Accept all
            </button>
            <button
              type="button"
              onClick={() => setToast('Re-label sent to triage')}
              className="rounded-md border border-outline-variant px-3 py-1.5 text-xs text-on-surface-variant hover:border-outline hover:text-on-surface"
            >
              Re-label
            </button>
            <button
              type="button"
              onClick={bulkDismiss}
              className="rounded-md border border-outline-variant px-3 py-1.5 text-xs text-on-surface-variant hover:border-error/40 hover:text-error"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* ── TOAST ── */}
      {toast && (
        <div className="pointer-events-none fixed bottom-24 left-1/2 z-40 -translate-x-1/2 rounded-md border border-outline-variant bg-surface-container-high px-3 py-1.5 text-xs text-on-surface shadow-ambient">
          {toast}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Decision card — an issue with its nested findings.
// ─────────────────────────────────────────────────────────────────────
function DecisionCard({
  item,
  selectedFindings,
  onToggleFinding,
  onToggleAll,
  onAccept,
  onDismiss,
  onSnooze,
}: {
  item: DecisionItem;
  selectedFindings: Set<string>;
  onToggleFinding: (id: string) => void;
  onToggleAll: (select: boolean) => void;
  onAccept: (id: string) => void;
  onDismiss: (id: string) => void;
  onSnooze: (id: string) => void;
}) {
  const selectedCount = item.findings.filter((f) => selectedFindings.has(f.id)).length;
  const allSelected = selectedCount === item.findings.length;
  const someSelected = selectedCount > 0 && !allSelected;

  return (
    <article
      className={cn(
        'group rounded-lg border bg-surface-container-low transition-colors',
        selectedCount > 0
          ? 'border-primary/40 bg-primary/[0.03]'
          : 'border-outline-variant hover:border-outline',
      )}
    >
      <header className="flex items-center gap-3 border-b border-outline-variant/60 px-4 py-3">
        <Checkbox
          checked={allSelected}
          indeterminate={someSelected}
          onChange={() => onToggleAll(!allSelected)}
          ariaLabel={`Select all findings for issue ${item.issueNumber}`}
        />
        <span className="font-mono text-xs text-outline">#{item.issueNumber}</span>
        <h3 className="flex-1 truncate text-sm font-medium text-on-surface">{item.issueTitle}</h3>
        <button
          type="button"
          className="rounded-md p-1 text-outline opacity-0 transition-opacity hover:bg-surface-container hover:text-on-surface-variant group-hover:opacity-100"
          aria-label="More actions"
        >
          <MoreVerticalIcon className="h-4 w-4" />
        </button>
      </header>
      <ul className="divide-y divide-outline-variant/40">
        {item.findings.map((f) => (
          <li key={f.id}>
            <FindingRow
              finding={f}
              selected={selectedFindings.has(f.id)}
              onToggle={() => onToggleFinding(f.id)}
              onAccept={() => onAccept(f.id)}
              onDismiss={() => onDismiss(f.id)}
              onSnooze={() => onSnooze(f.id)}
            />
          </li>
        ))}
      </ul>
    </article>
  );
}

function FindingRow({
  finding,
  selected,
  onToggle,
  onAccept,
  onDismiss,
  onSnooze,
}: {
  finding: Finding;
  selected: boolean;
  onToggle: () => void;
  onAccept: () => void;
  onDismiss: () => void;
  onSnooze: () => void;
}) {
  const style = SKILL_STYLE[finding.skill];
  return (
    <div
      className={cn(
        'group/row flex items-center gap-3 px-4 py-3 transition-colors',
        selected ? 'bg-primary/[0.06]' : 'hover:bg-surface-container/60',
      )}
    >
      <Checkbox checked={selected} onChange={onToggle} ariaLabel={`Select ${finding.skill} finding`} />
      <div className="flex items-center gap-2 shrink-0">
        <SparkleSmallIcon className={cn('h-3.5 w-3.5', style.tag)} />
        <span className={cn('font-mono text-[10.5px] font-semibold uppercase tracking-wider', style.tag)}>
          {finding.skill}
        </span>
      </div>
      <div className="flex-1 truncate text-sm text-on-surface-variant">
        <FindingBodyText finding={finding} />
      </div>
      <span
        className={cn(
          'shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10.5px] font-semibold tracking-wider',
          style.pill,
        )}
      >
        {finding.confidence}%
      </span>
      <div className="flex items-center gap-1 shrink-0 opacity-70 transition-opacity group-hover/row:opacity-100">
        <button
          type="button"
          onClick={onAccept}
          className="inline-flex items-center gap-1 rounded-md border border-outline-variant bg-surface-container px-2 py-1 text-xs text-on-surface-variant hover:border-emerald-400/40 hover:text-emerald-300"
          aria-label="Accept finding"
        >
          <CheckIcon className="h-3 w-3" />
          Accept
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="inline-flex items-center justify-center rounded-md border border-outline-variant bg-surface-container px-2 py-1 text-xs text-outline hover:border-error/40 hover:text-error"
          aria-label="Dismiss finding"
        >
          ✕
        </button>
        <FindingRowMenu onSnooze={onSnooze} />
      </div>
    </div>
  );
}

// Per-row kebab — currently hosts only "Snooze 24h" but is structured so
// future per-row actions (re-label, copy id, etc.) drop in as additional
// menu items without re-wiring the trigger or portal positioning.
function FindingRowMenu({ onSnooze }: { onSnooze: () => void }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label="Finding actions"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-outline hover:bg-surface-container hover:text-on-surface-variant"
      >
        <MoreVerticalIcon className="h-4 w-4" />
      </button>
      <RowMenuPortal
        open={open}
        triggerRef={triggerRef}
        popoverRef={popoverRef}
        onClose={() => setOpen(false)}
        id={menuId}
        ariaLabel="Finding actions menu"
      >
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setOpen(false);
            onSnooze();
          }}
          className="block w-full px-3 py-2 text-left text-sm text-on-surface transition-colors hover:bg-surface-container focus:bg-surface-container focus:outline-none"
        >
          Snooze 24h
        </button>
      </RowMenuPortal>
    </>
  );
}

function FindingBodyText({ finding }: { finding: Finding }) {
  const b = finding.body;
  switch (b.kind) {
    case 'dup':
      return (
        <>
          Identified as a duplicate of{' '}
          <span className="font-mono text-primary">#{b.dupNumber}</span> with high confidence.
        </>
      );
    case 'log':
      return (
        <>
          Pattern <code className="rounded bg-surface-container px-1 py-px font-mono text-[12px] text-on-surface">{b.pattern}</code>{' '}
          observed across <span className="text-on-surface">{b.clusters}</span> clusters.
        </>
      );
    case 'semantic':
      return (
        <>
          {b.note}{' '}
          <code className="rounded bg-surface-container px-1 py-px font-mono text-[12px] text-on-surface">{b.deployment}</code>.
        </>
      );
    case 'lint':
      return (
        <>
          Proposed fix: change &quot;<span className="text-error/80 line-through">{b.from}</span>&quot; → &quot;
          <span className="text-emerald-300">{b.to}</span>&quot; in{' '}
          <code className="rounded bg-surface-container px-1 py-px font-mono text-[12px] text-on-surface">{b.file}</code>{' '}
          line {b.line}.
        </>
      );
    case 'bug':
      return <>{b.note}</>;
    case 'priority':
      return (
        <>
          Suggested priority <span className="font-mono text-on-surface">{b.value}</span> · {b.note}
        </>
      );
    case 'label':
      return (
        <>
          Suggested labels:{' '}
          {b.labels.map((l, i) => (
            <span key={l}>
              <code className="rounded bg-surface-container px-1 py-px font-mono text-[12px] text-on-surface">{l}</code>
              {i < b.labels.length - 1 ? ' · ' : ''}
            </span>
          ))}
        </>
      );
  }
}

// ─────────────────────────────────────────────────────────────────────
// Single-row item cards
// ─────────────────────────────────────────────────────────────────────
function PrCard({ item, onReview }: { item: PrItem; onReview: () => void }) {
  return (
    <SingleRowCard
      tone="success"
      eyebrow="PR ready"
      title={
        <>
          <span className="font-mono text-xs text-outline">PR #{item.prNumber}</span>{' '}
          <span className="text-on-surface">{item.title}</span>
        </>
      }
      meta={<>{item.agent} · opened <RelativeTime ts={Date.now() - item.ageMin * 60_000} /></>}
      primary={{ label: 'Review', onClick: onReview, icon: <PlayIcon className="h-3.5 w-3.5" /> }}
    />
  );
}

function PausedCard({ item, onResolve }: { item: PausedItem; onResolve: () => void }) {
  return (
    <SingleRowCard
      tone="warn"
      eyebrow="Paused"
      title={
        <>
          <span className="font-mono text-xs text-outline">Run #{item.runNumber}</span>{' '}
          <span className="text-on-surface">{item.workflow}</span>{' '}
          <span className="text-on-surface-variant">· waiting at</span>{' '}
          <code className="rounded bg-surface-container px-1 py-px font-mono text-[12px] text-on-surface">{item.step}</code>
        </>
      }
      meta={<>paused <RelativeTime ts={Date.now() - item.ageMin * 60_000} /></>}
      primary={{ label: 'Resolve', onClick: onResolve, icon: <CheckIcon className="h-3.5 w-3.5" /> }}
    />
  );
}

function FailedCard({ item, onRetry }: { item: FailedItem; onRetry: () => void }) {
  return (
    <SingleRowCard
      tone="danger"
      eyebrow="Failed"
      title={
        <>
          <span className="font-mono text-xs text-outline">Run #{item.runNumber}</span>{' '}
          <span className="text-on-surface">{item.workflow}</span>{' '}
          <span className="text-on-surface-variant">· {item.reason}</span>
        </>
      }
      meta={<>failed <RelativeTime ts={Date.now() - item.ageMin * 60_000} /></>}
      primary={{ label: 'Retry', onClick: onRetry, icon: <RotateLeftIcon className="h-3.5 w-3.5" /> }}
    />
  );
}

function SingleRowCard({
  tone,
  eyebrow,
  title,
  meta,
  primary,
}: {
  tone: 'success' | 'warn' | 'danger';
  eyebrow: string;
  title: React.ReactNode;
  meta: React.ReactNode;
  primary: { label: string; onClick: () => void; icon?: React.ReactNode };
}) {
  const toneClass = {
    success: { bar: 'bg-emerald-400', label: 'text-emerald-300', btn: 'border-emerald-400/40 text-emerald-300 hover:bg-emerald-500/10' },
    warn: { bar: 'bg-tertiary', label: 'text-tertiary', btn: 'border-tertiary/40 text-tertiary hover:bg-tertiary/10' },
    danger: { bar: 'bg-error', label: 'text-error', btn: 'border-error/40 text-error hover:bg-error/10' },
  }[tone];
  return (
    <article className="group flex items-center gap-3 rounded-lg border border-outline-variant bg-surface-container-low px-4 py-3 transition-colors hover:border-outline">
      <span className={cn('h-8 w-1 rounded-full shrink-0', toneClass.bar)} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className={cn('font-mono text-[10.5px] font-semibold uppercase tracking-wider', toneClass.label)}>
            {eyebrow}
          </span>
          <span className="truncate text-sm text-on-surface-variant">{title}</span>
        </div>
        <div className="mt-0.5 text-xs text-outline">{meta}</div>
      </div>
      <button
        type="button"
        onClick={primary.onClick}
        className={cn(
          'inline-flex shrink-0 items-center gap-1.5 rounded-md border bg-surface-container px-3 py-1.5 text-xs font-medium transition-colors',
          toneClass.btn,
        )}
      >
        {primary.icon}
        {primary.label}
      </button>
      <button
        type="button"
        className="rounded-md p-1 text-outline opacity-0 transition-opacity hover:bg-surface-container hover:text-on-surface-variant group-hover:opacity-100"
        aria-label="More actions"
      >
        <MoreVerticalIcon className="h-4 w-4" />
      </button>
    </article>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Building blocks
// ─────────────────────────────────────────────────────────────────────
function Checkbox({
  checked,
  indeterminate,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={ariaLabel}
      onClick={onChange}
      className={cn(
        'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
        checked || indeterminate
          ? 'border-primary bg-primary text-primary-on'
          : 'border-outline-variant bg-transparent hover:border-outline',
      )}
    >
      {indeterminate ? (
        <span className="h-0.5 w-2 rounded bg-primary-on" />
      ) : checked ? (
        <CheckIcon className="h-3 w-3" />
      ) : null}
    </button>
  );
}

function Metric({
  value,
  label,
  tone,
}: {
  value: number;
  label: string;
  tone: 'accent' | 'warn' | 'danger' | 'muted';
}) {
  const valClass = {
    accent: 'text-primary',
    warn: 'text-tertiary',
    danger: 'text-error',
    muted: 'text-on-surface-variant',
  }[tone];
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className={cn('font-mono text-sm font-semibold', valClass)}>{value}</span>
      <span className="text-xs text-outline">{label}</span>
    </span>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-[20px] items-center justify-center rounded border border-outline-variant bg-surface-container px-1 font-mono text-[10.5px] text-on-surface-variant">
      {children}
    </kbd>
  );
}

function FilterDropdown<T extends { id: string; label: string }>({
  label,
  value,
  options,
  selectedId,
  onSelect,
}: {
  label: string;
  value: string;
  options: readonly T[];
  selectedId: string;
  onSelect: (opt: T) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className={cn(
          'inline-flex items-center gap-2 rounded-md border border-outline-variant bg-surface-container-low px-3 py-1.5 text-xs transition-colors',
          'hover:border-outline',
          open && 'border-primary/40 bg-surface-container',
        )}
      >
        <span className="text-outline">{label}:</span>
        <span className="text-on-surface">{value}</span>
        <ChevronDownIcon className={cn('h-3 w-3 text-outline transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 min-w-[180px] rounded-md border border-outline-variant bg-surface-container-high py-1 shadow-ambient">
          {options.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onSelect(opt);
                setOpen(false);
              }}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors',
                opt.id === selectedId
                  ? 'bg-primary/10 text-primary'
                  : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface',
              )}
            >
              <CheckIcon className={cn('h-3 w-3', opt.id === selectedId ? 'opacity-100' : 'opacity-0')} />
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyState({ filteredOut, onClear }: { filteredOut: boolean; onClear: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-outline-variant bg-surface-container-low/40 py-16 text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <CheckIcon className="h-6 w-6" />
      </div>
      <div className="text-base font-medium text-on-surface">
        {filteredOut ? 'No items match the current filters' : "You're clear."}
      </div>
      <div className="mt-1 text-sm text-on-surface-variant">
        {filteredOut
          ? 'Try loosening the confidence threshold or selecting a different skill.'
          : 'Nothing in the queue. Want to sweep the backlog for new findings?'}
      </div>
      <div className="mt-5">
        {filteredOut ? (
          <button
            type="button"
            onClick={onClear}
            className="rounded-md border border-outline-variant bg-surface-container px-4 py-2 text-xs text-on-surface hover:border-outline"
          >
            Clear filters
          </button>
        ) : (
          <a
            href="/actions"
            className="inline-flex items-center gap-2 rounded-md border border-primary/40 bg-primary/10 px-4 py-2 text-xs font-medium text-primary hover:border-primary/60 hover:bg-primary/15"
          >
            Run triage sweep →
          </a>
        )}
      </div>
    </div>
  );
}

function RelativeTime({ ts }: { ts: number }) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return <>just now</>;
  if (mins < 60) return <>{mins}m ago</>;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return <>{hrs}h ago</>;
  const days = Math.floor(hrs / 24);
  return <>{days}d ago</>;
}

// Drop the given finding IDs from decision items, removing any decision
// card that ends up empty. Used by every mutation path for snappy UX.
function removeFindingFromItems(items: InboxItem[], findingIds: string[]): InboxItem[] {
  const drop = new Set(findingIds);
  return items
    .map((it) => {
      if (it.kind !== 'decision') return it;
      const findings = it.findings.filter((f) => !drop.has(f.id));
      return { ...it, findings };
    })
    .filter((it) => (it.kind === 'decision' ? it.findings.length > 0 : true));
}
