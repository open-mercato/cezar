'use client';

import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/components/ui/cn';
import { SearchIcon, ChevronLeftIcon, ChevronRightIcon } from '@/components/icons';
import { RunStatusDots } from '@/components/run-status-dots';
import { PageContainer } from '@/components/ui/page-container';
import { FilterBar } from '@/components/ui/filter-bar';
import { EntityCard, MetaRow, MetaItem, CardActions } from '@/components/ui/data-card-list';
import type { ActionRunSummary, RunStatus } from '@/lib/action-runs-loader';
import { PrRowMenu } from './pr-row-menu';

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

type RunStatusFilter = 'has-runs' | 'running' | 'enqueued' | 'succeeded' | 'failed' | 'none';

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

/** Per-value run-status predicate, preserving each option's original meaning. */
function matchesRunStatus(r: PrRow, value: RunStatusFilter): boolean {
  const top = topStatus(r.actionRuns);
  if (value === 'has-runs') return r.actionRuns.length > 0;
  if (value === 'none') return r.actionRuns.length === 0;
  if (value === 'enqueued') return top === 'queued';
  return top === value;
}

export function PrsView({ rows, repoLabel, fetchedAt, readOnly }: PrsViewProps) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(10);
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState<string[]>([]);
  const [draftFilter, setDraftFilter] = useState<string[]>([]);
  const [runStatusFilter, setRunStatusFilter] = useState<string[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>('number');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (stateFilter.length > 0 && !stateFilter.includes(r.state)) return false;
      if (draftFilter.length > 0) {
        const draftValue = r.draft ? 'draft' : 'ready';
        if (!draftFilter.includes(draftValue)) return false;
      }
      if (runStatusFilter.length > 0) {
        if (!runStatusFilter.some((v) => matchesRunStatus(r, v as RunStatusFilter))) return false;
      }
      if (q.length > 0) {
        const hay =
          `${r.number} ${r.title} ${r.author} ${r.headRef ?? ''} ${r.baseRef ?? ''} ${r.labels.join(' ')}`.toLowerCase();
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
    stateFilter.length > 0 ||
    draftFilter.length > 0 ||
    runStatusFilter.length > 0;

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
    setStateFilter([]);
    setDraftFilter([]);
    setRunStatusFilter([]);
    setPage(1);
  }

  return (
    <PageContainer>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold leading-tight tracking-tight text-on-surface sm:text-[24px]">
            Pull requests
          </h1>
          <p className="mt-1 text-sm text-on-surface-variant">
            <span className="font-mono">{repoLabel}</span> — {totalPrs} PR
            {totalPrs === 1 ? '' : 's'} synced
          </p>
        </div>
      </header>

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

      <div className="mb-4 rounded-lg border border-outline-variant bg-surface-container-low p-3">
        <FilterBar
          search={
            <label className="relative flex w-full items-center">
              <SearchIcon className="absolute left-3 h-4 w-4 text-on-surface-variant" aria-hidden />
              <input
                type="search"
                enterKeyHint="search"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                placeholder="Search by title, author, branch, label, or number…"
                className="h-9 w-full rounded-md border border-outline-variant bg-surface pl-9 pr-3 text-base text-on-surface placeholder:text-on-surface-variant focus:border-primary focus:shadow-focus-primary focus:outline-none sm:text-sm"
              />
            </label>
          }
          filters={[
            {
              id: 'state',
              label: 'State',
              values: stateFilter,
              onChange: (v) => {
                setStateFilter(v);
                setPage(1);
              },
              options: [
                { value: 'open', label: 'Open' },
                { value: 'closed', label: 'Closed' },
              ],
            },
            {
              id: 'draft',
              label: 'Draft',
              values: draftFilter,
              onChange: (v) => {
                setDraftFilter(v);
                setPage(1);
              },
              options: [
                { value: 'draft', label: 'Draft' },
                { value: 'ready', label: 'Ready' },
              ],
            },
            {
              id: 'runStatus',
              label: 'Run status',
              values: runStatusFilter,
              onChange: (v) => {
                setRunStatusFilter(v);
                setPage(1);
              },
              options: [
                { value: 'has-runs', label: 'Has any run' },
                { value: 'running', label: 'Running' },
                { value: 'enqueued', label: 'Enqueued' },
                { value: 'succeeded', label: 'Succeeded' },
                { value: 'failed', label: 'Failed' },
                { value: 'none', label: 'No runs' },
              ],
            },
          ]}
          onClearAll={resetFilters}
        />
      </div>

      <div className="overflow-hidden rounded-lg border border-outline-variant bg-surface-container-low">
        {/* Phone: stacked cards (P1). */}
        <div className="space-y-3 p-3 md:hidden">
          {pageRows.length === 0 ? (
            <div className="px-2 py-10 text-center text-sm text-on-surface-variant">
              {totalPrs === 0 ? (
                <>
                  No pull requests in this workspace yet. The{' '}
                  <code className="font-mono text-on-surface">prs-sync</code> cron will populate
                  them.
                </>
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
            </div>
          ) : (
            pageRows.map((row) => <PrCard key={row.number} row={row} readOnly={readOnly} />)
          )}
        </div>

        {/* Tablet/desktop: the table (md+). */}
        <div className="hidden overflow-x-auto md:block">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="bg-surface-container">
                <SortableTh
                  sortKey="runStatus"
                  sortDir={sortDir}
                  active={sortKey === 'runStatus'}
                  onClick={handleSort}
                  className="w-[44px] pr-2"
                >
                  <span className="sr-only">Run status</span>
                </SortableTh>
                <SortableTh
                  sortKey="number"
                  sortDir={sortDir}
                  active={sortKey === 'number'}
                  onClick={handleSort}
                >
                  #
                </SortableTh>
                <SortableTh
                  sortKey="title"
                  sortDir={sortDir}
                  active={sortKey === 'title'}
                  onClick={handleSort}
                >
                  NAME
                </SortableTh>
                <SortableTh
                  sortKey="state"
                  sortDir={sortDir}
                  active={sortKey === 'state'}
                  onClick={handleSort}
                >
                  STATE
                </SortableTh>
                <SortableTh
                  sortKey="author"
                  sortDir={sortDir}
                  active={sortKey === 'author'}
                  onClick={handleSort}
                >
                  AUTHOR
                </SortableTh>
                <Th>BRANCH</Th>
                <Th>LABELS</Th>
                <SortableTh
                  sortKey="prUpdatedAt"
                  sortDir={sortDir}
                  active={sortKey === 'prUpdatedAt'}
                  onClick={handleSort}
                >
                  UPDATED
                </SortableTh>
                <Th className="text-right pr-6">ACTIONS</Th>
              </tr>
            </thead>
            <tbody>
              {pageRows.length === 0 ? (
                <tr>
                  <td
                    colSpan={9}
                    className="px-6 py-12 text-center text-sm text-on-surface-variant"
                  >
                    {totalPrs === 0 ? (
                      <>
                        No pull requests in this workspace yet. The{' '}
                        <code className="font-mono text-on-surface">prs-sync</code> cron will
                        populate them.
                      </>
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

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-outline-variant bg-surface-container-low px-4 py-4 text-sm text-on-surface-variant sm:px-6">
          <div className="flex flex-wrap items-center gap-3">
            <span>
              Showing {pageRows.length === 0 ? 0 : (page - 1) * pageSize + 1}
              {pageRows.length > 0 && <>–{(page - 1) * pageSize + pageRows.length}</>} of{' '}
              {totalFiltered}
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
              <span className="hidden lg:inline">
                · upstream updated {new Date(fetchedAt).toLocaleString()}
              </span>
            )}
          </div>
          {totalPages > 1 && <Pagination page={page} totalPages={totalPages} onChange={setPage} />}
        </div>
      </div>
    </PageContainer>
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
      className={cn(
        'inline-flex flex-col text-[8px] leading-[8px]',
        active ? 'text-primary' : 'text-outline-variant',
      )}
    >
      <span className={cn(active && dir === 'asc' ? 'text-primary' : 'text-outline-variant')}>
        ▲
      </span>
      <span className={cn(active && dir === 'desc' ? 'text-primary' : 'text-outline-variant')}>
        ▼
      </span>
    </span>
  );
}

function compareByKey(a: PrRow, b: PrRow, key: SortKey): number {
  if (key === 'number') return a.number - b.number;
  if (key === 'runStatus') {
    return (
      RUN_STATUS_RANK[topStatus(a.actionRuns)] - RUN_STATUS_RANK[topStatus(b.actionRuns)] ||
      a.number - b.number
    );
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
        <span className="font-mono text-[13px] text-on-surface-variant">
          {formatRelative(row.prUpdatedAt)}
        </span>
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

function PrCard({ row, readOnly }: { row: PrRow; readOnly: boolean }) {
  return (
    <EntityCard
      leading={<RunStatusDots runs={row.actionRuns} />}
      title={
        <a
          href={row.htmlUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-w-0 items-baseline gap-2 hover:text-primary"
          title={row.title}
        >
          <span className="shrink-0 font-mono text-[13px] text-on-surface-variant">
            #{row.number}
          </span>
          <span className="truncate">{row.title}</span>
        </a>
      }
      badge={<StateBadge state={row.state} draft={row.draft} />}
      actions={
        <CardActions>
          <PrRowMenu
            prNumber={row.number}
            prTitle={row.title}
            prUrl={row.htmlUrl}
            readOnly={readOnly}
          />
        </CardActions>
      }
    >
      <MetaRow>
        <MetaItem label="Author">{row.author}</MetaItem>
        <MetaItem label="Updated">{formatRelative(row.prUpdatedAt)}</MetaItem>
      </MetaRow>
      {(row.headRef || row.baseRef) && (
        <MetaRow>
          <MetaItem label="Branch" className="min-w-0 max-w-full">
            <BranchCell head={row.headRef} base={row.baseRef} />
          </MetaItem>
        </MetaRow>
      )}
      {row.labels.length > 0 && (
        <MetaRow>
          <LabelChips labels={row.labels} />
        </MetaRow>
      )}
    </EntityCard>
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
  // Each side caps its own width and truncates with an ellipsis — the table is
  // auto-layout, so a `max-width` on the <td> alone is ignored and a long head
  // ref would otherwise push into the labels column.
  return (
    <span
      className="flex items-center gap-1 font-mono text-[12px] text-on-surface-variant"
      title={`${head ?? '?'} → ${base ?? '?'}`}
    >
      <span className="max-w-[150px] truncate">{head ?? '?'}</span>
      <span className="shrink-0 text-outline-variant">→</span>
      <span className="max-w-[90px] truncate">{base ?? '?'}</span>
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
    <>
      {/* Phone: compact Prev · N / M · Next. */}
      <div className="flex items-center gap-2 sm:hidden">
        <PagerButton
          onClick={() => onChange(Math.max(1, page - 1))}
          disabled={page === 1}
          aria-label="Previous page"
        >
          <ChevronLeftIcon className="h-4 w-4" />
        </PagerButton>
        <span className="text-sm tabular-nums text-on-surface-variant">
          {page} / {totalPages}
        </span>
        <PagerButton
          onClick={() => onChange(Math.min(totalPages, page + 1))}
          disabled={page === totalPages}
          aria-label="Next page"
        >
          <ChevronRightIcon className="h-4 w-4" />
        </PagerButton>
      </div>

      {/* Desktop: full numeric pager. */}
      <div className="hidden items-center gap-1 sm:flex">
        <PagerButton
          onClick={() => onChange(Math.max(1, page - 1))}
          disabled={page === 1}
          aria-label="Previous page"
        >
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
        <PagerButton
          onClick={() => onChange(Math.min(totalPages, page + 1))}
          disabled={page === totalPages}
          aria-label="Next page"
        >
          <ChevronRightIcon className="h-4 w-4" />
        </PagerButton>
      </div>
    </>
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
      className="flex min-h-11 min-w-11 items-center justify-center rounded-md border border-outline-variant bg-surface-container-low text-on-surface-variant transition-colors hover:border-primary hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-40 sm:h-8 sm:w-8 sm:min-h-0 sm:min-w-0"
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
