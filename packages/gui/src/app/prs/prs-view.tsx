'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/components/ui/cn';
import { SearchIcon, ChevronLeftIcon, ChevronRightIcon, RefreshIcon } from '@/components/icons';
import { RunStatusDots } from '@/components/run-status-dots';
import type { ActionRunSummary, RunStatus } from '@/lib/action-runs-loader';
import { PrRowMenu } from './pr-row-menu';
import { syncPullRequests } from './prs-action';

export interface PrRow {
  number: number;
  title: string;
  htmlUrl: string;
  state: 'open' | 'closed';
  draft: boolean;
  labels: string[];
  author: string;
  headRef: string | null;
  baseRef: string | null;
  prUpdatedAt: string | null;
  /** Most-recent agent_runs against this PR, newest first, capped by the loader. */
  actionRuns: ActionRunSummary[];
}

interface PrsViewProps {
  rows: PrRow[];
  repoLabel: string;
  fetchedAt: string | null;
  readOnly: boolean;
}

type StateFilter = 'all' | 'open' | 'closed';
type DraftFilter = 'all' | 'draft' | 'ready';
type RunStatusFilter = 'all' | 'has-runs' | 'running' | 'enqueued' | 'succeeded' | 'failed' | 'none';

type SortKey = 'runStatus' | 'number' | 'title' | 'state' | 'author' | 'prUpdatedAt';
type SortDir = 'asc' | 'desc';

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

const RUN_STATUS_RANK: Record<RunStatus | 'none', number> = {
  running: 5,
  queued: 4,
  failed: 3,
  paused: 2,
  succeeded: 1,
  skipped: 0,
  none: 0,
};

function topStatus(runs: ActionRunSummary[]): RunStatus | 'none' {
  if (runs.length === 0) return 'none';
  let best: RunStatus = runs[0].status;
  let bestRank = RUN_STATUS_RANK[best];
  for (const r of runs) {
    const rank = RUN_STATUS_RANK[r.status];
    if (rank > bestRank) {
      best = r.status;
      bestRank = rank;
    }
  }
  return best;
}

export function PrsView({ rows, repoLabel, fetchedAt, readOnly }: PrsViewProps) {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(10);
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState<StateFilter>('all');
  const [draftFilter, setDraftFilter] = useState<DraftFilter>('all');
  const [runStatusFilter, setRunStatusFilter] = useState<RunStatusFilter>('all');
  const [sortKey, setSortKey] = useState<SortKey>('number');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [syncState, setSyncState] = useState<{ ok?: boolean; error?: string; count?: number; capped?: boolean } | null>(null);
  const [syncing, startSync] = useTransition();

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (stateFilter !== 'all' && r.state !== stateFilter) return false;
      if (draftFilter !== 'all') {
        if (draftFilter === 'draft' ? !r.draft : r.draft) return false;
      }
      if (runStatusFilter !== 'all') {
        const top = topStatus(r.actionRuns);
        if (runStatusFilter === 'has-runs') {
          if (r.actionRuns.length === 0) return false;
        } else if (runStatusFilter === 'enqueued') {
          if (top !== 'queued') return false;
        } else if (runStatusFilter === 'none') {
          if (r.actionRuns.length > 0) return false;
        } else if (top !== runStatusFilter) {
          return false;
        }
      }
      if (q.length > 0) {
        const hay = `${r.number} ${r.title} ${r.author} ${r.headRef ?? ''} ${r.baseRef ?? ''} ${r.labels.join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, search, stateFilter, draftFilter, runStatusFilter]);

  const sorted = useMemo(() => {
    const out = [...filtered];
    const dir = sortDir === 'asc' ? 1 : -1;
    out.sort((a, b) => dir * compareByKey(a, b, sortKey));
    return out;
  }, [filtered, sortKey, sortDir]);

  const totalFiltered = sorted.length;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / pageSize));

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const pageRows = useMemo(
    () => sorted.slice((page - 1) * pageSize, page * pageSize),
    [sorted, page, pageSize],
  );

  const totalPrs = rows.length;
  const openCount = rows.filter((r) => r.state === 'open').length;
  const draftCount = rows.filter((r) => r.draft).length;
  const runningCount = rows.filter((r) =>
    r.actionRuns.some((run) => run.status === 'running' || run.status === 'queued'),
  ).length;

  const filtersActive =
    search.trim().length > 0 ||
    stateFilter !== 'all' ||
    draftFilter !== 'all' ||
    runStatusFilter !== 'all';

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'number' || key === 'runStatus' || key === 'prUpdatedAt' ? 'desc' : 'asc');
    }
  }

  function resetFilters() {
    setSearch('');
    setStateFilter('all');
    setDraftFilter('all');
    setRunStatusFilter('all');
    setPage(1);
  }

  function handleSync() {
    setSyncState(null);
    startSync(async () => {
      const result = await syncPullRequests();
      setSyncState(result);
      if (result.ok) router.refresh();
    });
  }

  return (
    <div className="px-6 py-6">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[24px] font-semibold leading-tight tracking-tight text-on-surface">Pull requests</h1>
          <p className="mt-1 text-sm text-on-surface-variant">
            <span className="font-mono">{repoLabel}</span> — {totalPrs} PR{totalPrs === 1 ? '' : 's'} synced
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSync}
            disabled={syncing || readOnly}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-outline-variant bg-surface-container-low px-3 text-sm font-medium text-on-surface transition-colors hover:border-primary hover:bg-surface-container disabled:opacity-50"
          >
            <RefreshIcon className={cn('h-4 w-4', syncing && 'animate-spin')} />
            {syncing ? 'Syncing…' : 'Sync from GitHub'}
          </button>
        </div>
      </header>

      {syncState?.ok && (
        <div className="mb-4 rounded-md border border-primary/30 bg-primary-container/20 px-4 py-2 text-sm text-primary">
          Synced {syncState.count ?? 0} open PR{(syncState.count ?? 0) === 1 ? '' : 's'} from GitHub.
          {syncState.capped && (
            <> Page cap reached — the background sync will backfill the rest.</>
          )}
        </div>
      )}
      {syncState?.error && (
        <div className="mb-4 rounded-md border border-error/30 bg-error-container/30 px-4 py-2 text-sm text-error">
          {syncState.error}
        </div>
      )}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="TOTAL PRS" value={String(totalPrs)} tone="default" />
        <StatCard label="OPEN" value={String(openCount)} tone="primary" />
        <StatCard label="DRAFT" value={String(draftCount)} tone="tertiary" />
        <StatCard
          label="RUNNING"
          value={String(runningCount)}
          tone="default"
          pulse={runningCount > 0}
        />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-outline-variant bg-surface-container-low p-3">
        <label className="relative flex min-w-[220px] flex-1 items-center">
          <SearchIcon className="absolute left-3 h-4 w-4 text-on-surface-variant" aria-hidden />
          <input
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search by title, author, branch, label, or number…"
            className="h-9 w-full rounded-md border border-outline-variant bg-surface pl-9 pr-3 text-sm text-on-surface placeholder:text-on-surface-variant focus:border-primary focus:shadow-focus-primary focus:outline-none"
          />
        </label>

        <FilterSelect
          label="State"
          value={stateFilter}
          onChange={(v) => {
            setStateFilter(v as StateFilter);
            setPage(1);
          }}
          options={[
            { value: 'all', label: 'All states' },
            { value: 'open', label: 'Open' },
            { value: 'closed', label: 'Closed' },
          ]}
        />
        <FilterSelect
          label="Draft"
          value={draftFilter}
          onChange={(v) => {
            setDraftFilter(v as DraftFilter);
            setPage(1);
          }}
          options={[
            { value: 'all', label: 'All' },
            { value: 'draft', label: 'Draft' },
            { value: 'ready', label: 'Ready' },
          ]}
        />
        <FilterSelect
          label="Run status"
          value={runStatusFilter}
          onChange={(v) => {
            setRunStatusFilter(v as RunStatusFilter);
            setPage(1);
          }}
          options={[
            { value: 'all', label: 'All' },
            { value: 'has-runs', label: 'Has any run' },
            { value: 'running', label: 'Running' },
            { value: 'enqueued', label: 'Enqueued' },
            { value: 'succeeded', label: 'Succeeded' },
            { value: 'failed', label: 'Failed' },
            { value: 'none', label: 'No runs' },
          ]}
        />

        {filtersActive && (
          <button
            type="button"
            onClick={resetFilters}
            className="h-9 rounded-md border border-outline-variant bg-surface px-3 text-sm text-on-surface-variant transition-colors hover:border-primary hover:text-on-surface"
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="overflow-hidden rounded-lg border border-outline-variant bg-surface-container-low">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="bg-surface-container">
                <SortableTh sortKey="runStatus"    sortDir={sortDir} active={sortKey === 'runStatus'}    onClick={handleSort} className="w-[44px] pr-2">
                  <span className="sr-only">Run status</span>
                </SortableTh>
                <SortableTh sortKey="number"       sortDir={sortDir} active={sortKey === 'number'}       onClick={handleSort}>#</SortableTh>
                <SortableTh sortKey="title"        sortDir={sortDir} active={sortKey === 'title'}        onClick={handleSort}>NAME</SortableTh>
                <SortableTh sortKey="state"        sortDir={sortDir} active={sortKey === 'state'}        onClick={handleSort}>STATE</SortableTh>
                <SortableTh sortKey="author"       sortDir={sortDir} active={sortKey === 'author'}       onClick={handleSort}>AUTHOR</SortableTh>
                <Th>BRANCH</Th>
                <Th>LABELS</Th>
                <SortableTh sortKey="prUpdatedAt"  sortDir={sortDir} active={sortKey === 'prUpdatedAt'}  onClick={handleSort}>UPDATED</SortableTh>
                <Th className="text-right pr-6">ACTIONS</Th>
              </tr>
            </thead>
            <tbody>
              {pageRows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-6 py-12 text-center text-sm text-on-surface-variant">
                    {totalPrs === 0 ? (
                      <>No pull requests in this workspace yet. The <code className="font-mono text-on-surface">prs-sync</code> cron will populate them.</>
                    ) : (
                      <>
                        No PRs match these filters.{' '}
                        <button
                          type="button"
                          onClick={resetFilters}
                          className="underline underline-offset-2 hover:text-on-surface"
                        >
                          Clear filters
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ) : (
                pageRows.map((row) => <PrTableRow key={row.number} row={row} readOnly={readOnly} />)
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-outline-variant bg-surface-container-low px-6 py-4 text-sm text-on-surface-variant">
          <div className="flex flex-wrap items-center gap-3">
            <span>
              Showing {pageRows.length === 0 ? 0 : (page - 1) * pageSize + 1}
              {pageRows.length > 0 && <>–{(page - 1) * pageSize + pageRows.length}</>} of {totalFiltered}
              {filtersActive && <> filtered (of {totalPrs})</>} PR{totalFiltered === 1 ? '' : 's'}
            </span>
            <span className="hidden h-4 w-px bg-outline-variant sm:inline-block" aria-hidden />
            <label className="flex items-center gap-2">
              <span className="font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-on-surface-variant">
                Per page
              </span>
              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value) as PageSize);
                  setPage(1);
                }}
                className="h-8 rounded-md border border-outline-variant bg-surface px-2 text-sm text-on-surface focus:border-primary focus:outline-none"
              >
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            {fetchedAt && (
              <span className="hidden lg:inline">· upstream updated {new Date(fetchedAt).toLocaleString()}</span>
            )}
          </div>
          {totalPages > 1 && <Pagination page={page} totalPages={totalPages} onChange={setPage} />}
        </div>
      </div>
    </div>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        'whitespace-nowrap px-6 py-3 text-left font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-on-surface-variant',
        className,
      )}
    >
      {children}
    </th>
  );
}

function SortableTh({
  children,
  sortKey,
  active,
  sortDir,
  onClick,
  className,
}: {
  children: React.ReactNode;
  sortKey: SortKey;
  active: boolean;
  sortDir: SortDir;
  onClick: (key: SortKey) => void;
  className?: string;
}) {
  return (
    <th
      className={cn(
        'whitespace-nowrap px-6 py-3 text-left font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-on-surface-variant',
        className,
      )}
      aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onClick(sortKey)}
        className={cn(
          'inline-flex items-center gap-1 transition-colors hover:text-on-surface',
          active && 'text-on-surface',
        )}
      >
        <span>{children}</span>
        <SortIndicator active={active} dir={sortDir} />
      </button>
    </th>
  );
}

function SortIndicator({ active, dir }: { active: boolean; dir: SortDir }) {
  return (
    <span
      aria-hidden
      className={cn('inline-flex flex-col text-[8px] leading-[8px]', active ? 'text-primary' : 'text-outline-variant')}
    >
      <span className={cn(active && dir === 'asc' ? 'text-primary' : 'text-outline-variant')}>▲</span>
      <span className={cn(active && dir === 'desc' ? 'text-primary' : 'text-outline-variant')}>▼</span>
    </span>
  );
}

function FilterSelect<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-on-surface-variant">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="h-9 min-w-[7.5rem] rounded-md border border-outline-variant bg-surface px-2 text-sm text-on-surface focus:border-primary focus:outline-none"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function compareByKey(a: PrRow, b: PrRow, key: SortKey): number {
  if (key === 'number') return a.number - b.number;
  if (key === 'runStatus') {
    return RUN_STATUS_RANK[topStatus(a.actionRuns)] - RUN_STATUS_RANK[topStatus(b.actionRuns)]
      || a.number - b.number;
  }
  if (key === 'prUpdatedAt') {
    const ta = a.prUpdatedAt ? new Date(a.prUpdatedAt).getTime() : -Infinity;
    const tb = b.prUpdatedAt ? new Date(b.prUpdatedAt).getTime() : -Infinity;
    if (ta === tb) return a.number - b.number;
    return ta - tb;
  }
  const av = String(a[key as 'title' | 'state' | 'author']);
  const bv = String(b[key as 'title' | 'state' | 'author']);
  const cmp = av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' });
  return cmp === 0 ? a.number - b.number : cmp;
}

function PrTableRow({ row, readOnly }: { row: PrRow; readOnly: boolean }) {
  return (
    <tr className="border-t border-outline-variant/60 hover:bg-surface-container/60">
      <td className="px-4 py-4 align-middle">
        <RunStatusDots runs={row.actionRuns} />
      </td>
      <td className="px-6 py-4 align-middle">
        <span className="font-mono text-[13px] text-on-surface-variant">#{row.number}</span>
      </td>
      <td className="max-w-[420px] px-6 py-4 align-middle">
        <a
          href={row.htmlUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="block truncate font-medium text-on-surface hover:text-primary"
          title={row.title}
        >
          {row.title}
        </a>
      </td>
      <td className="px-6 py-4 align-middle">
        <StateBadge state={row.state} draft={row.draft} />
      </td>
      <td className="px-6 py-4 align-middle">
        <span className="font-mono text-[13px] text-on-surface-variant">{row.author}</span>
      </td>
      <td className="max-w-[260px] px-6 py-4 align-middle">
        <BranchCell head={row.headRef} base={row.baseRef} />
      </td>
      <td className="max-w-[220px] px-6 py-4 align-middle">
        <LabelChips labels={row.labels} />
      </td>
      <td className="px-6 py-4 align-middle">
        <span className="font-mono text-[13px] text-on-surface-variant">{formatRelative(row.prUpdatedAt)}</span>
      </td>
      <td className="relative px-6 py-4 align-middle">
        <div className="flex items-center justify-end pr-2">
          <PrRowMenu
            prNumber={row.number}
            prTitle={row.title}
            prUrl={row.htmlUrl}
            readOnly={readOnly}
          />
        </div>
      </td>
    </tr>
  );
}


function StateBadge({ state, draft }: { state: 'open' | 'closed'; draft: boolean }) {
  if (draft) {
    return (
      <span className="inline-flex items-center rounded-md border border-outline-variant bg-surface-container px-2 py-0.5 font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-on-surface-variant">
        draft
      </span>
    );
  }
  return (
    <span
      className={cn(
        'font-mono text-[13px]',
        state === 'open' ? 'text-primary' : 'text-on-surface-variant',
      )}
    >
      {state}
    </span>
  );
}

function BranchCell({ head, base }: { head: string | null; base: string | null }) {
  if (!head && !base) {
    return <span className="font-mono text-[13px] text-on-surface-variant">—</span>;
  }
  return (
    <span className="inline-flex items-center gap-1 truncate font-mono text-[12px] text-on-surface-variant" title={`${head ?? '?'} → ${base ?? '?'}`}>
      <span className="truncate">{head ?? '?'}</span>
      <span className="text-outline-variant">→</span>
      <span className="truncate">{base ?? '?'}</span>
    </span>
  );
}

function LabelChips({ labels }: { labels: string[] }) {
  if (labels.length === 0) {
    return <span className="font-mono text-[13px] text-on-surface-variant">—</span>;
  }
  const visible = labels.slice(0, 3);
  const extra = labels.length - visible.length;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {visible.map((l) => (
        <span
          key={l}
          className="inline-flex items-center rounded-md border border-outline-variant bg-surface px-1.5 py-0.5 font-mono text-[11px] text-on-surface-variant"
          title={l}
        >
          {l}
        </span>
      ))}
      {extra > 0 && <span className="font-mono text-[11px] text-on-surface-variant">+{extra}</span>}
    </span>
  );
}

function StatCard({
  label,
  value,
  tone,
  pulse,
}: {
  label: string;
  value: string;
  tone: 'default' | 'primary' | 'tertiary';
  pulse?: boolean;
}) {
  const valueColor =
    tone === 'primary' ? 'text-primary' : tone === 'tertiary' ? 'text-tertiary' : 'text-on-surface';
  return (
    <div className="rounded-lg border border-outline-variant bg-surface-container-low p-4">
      <div className="font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-on-surface-variant">
        {label}
      </div>
      <div
        className={cn(
          'mt-2 text-[28px] font-semibold leading-none tracking-tight',
          valueColor,
          pulse && 'animate-pulse',
        )}
      >
        {value}
      </div>
    </div>
  );
}

function Pagination({
  page,
  totalPages,
  onChange,
}: {
  page: number;
  totalPages: number;
  onChange: (p: number) => void;
}) {
  const pages = Array.from({ length: totalPages }, (_, i) => i + 1);
  return (
    <div className="flex items-center gap-1">
      <PagerButton onClick={() => onChange(Math.max(1, page - 1))} disabled={page === 1} aria-label="Previous page">
        <ChevronLeftIcon className="h-4 w-4" />
      </PagerButton>
      {pages.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onChange(p)}
          className={cn(
            'h-8 min-w-[2rem] rounded-md border px-2 text-sm transition-colors',
            p === page
              ? 'border-primary/40 bg-surface-container text-on-surface'
              : 'border-outline-variant bg-surface-container-low text-on-surface-variant hover:border-primary hover:text-on-surface',
          )}
        >
          {p}
        </button>
      ))}
      <PagerButton onClick={() => onChange(Math.min(totalPages, page + 1))} disabled={page === totalPages} aria-label="Next page">
        <ChevronRightIcon className="h-4 w-4" />
      </PagerButton>
    </div>
  );
}

function PagerButton({
  onClick,
  disabled,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-8 w-8 items-center justify-center rounded-md border border-outline-variant bg-surface-container-low text-on-surface-variant transition-colors hover:border-primary hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-40"
      {...rest}
    >
      {children}
    </button>
  );
}

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = Date.now() - t;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}
