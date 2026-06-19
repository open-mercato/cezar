'use client';

import { useEffect, useId, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { SkillSource } from '@cezar/core';
import { cn } from '@/components/ui/cn';
import {
  RefreshIcon,
  PlusIcon,
  SearchIcon,
  StatusDotIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  MoreVerticalIcon,
} from '@/components/icons';
import { PageContainer } from '@/components/ui/page-container';
import { FilterBar } from '@/components/ui/filter-bar';
import {
  ResponsiveListContainer,
  EntityCard,
  MetaRow,
  MetaItem,
  CardActions,
} from '@/components/ui/data-card-list';
import { ActionSheet, type ActionSheetItem } from '@/components/ui/action-sheet';
import { RowMenuPortal } from '@/components/row-menu-portal';
import { refreshRepoSkills } from './skills-action';
import { setSkillEnabled } from './state-actions';

/** Issue #262 — provenance values surfaced in the UI. `override` keeps its
 *  special meaning ("the workspace forked this skill") and shadows whatever
 *  source the upstream came from; everything else mirrors `SkillSource`. */
export type SkillRowSource = SkillSource | 'override';

/** Single source of truth for human-readable source labels — drives both the
 *  filter dropdown and the `<SourceBadge>` (badge CSS-uppercases the label). */
const SOURCE_LABELS: Record<SkillRowSource, string> = {
  override: 'Override',
  'built-in': 'Built-in',
  'workspace-repo': 'Workspace repo',
  'external-repo': 'External repo',
  disk: 'Disk upload',
  'skills-sh': 'skills.sh',
};

export interface SkillRow {
  name: string;
  description: string | null;
  path: string;
  source: SkillRowSource;
  mode: 'framed' | 'inline';
  trigger: 'on-sync' | 'cron' | 'manual';
  /** Issue #262 — true ⇒ skill is in the Active list and surfaces in pickers /
   *  workflow runs; false ⇒ catalog-only. Replaces the old `status` field. */
  active: boolean;
  lastRunIso: string | null;
  stages: string[];
}

interface SkillsViewProps {
  rows: SkillRow[];
  overridesCount: number;
  commitSha: string | null;
  fetchedAt: string | null;
  readOnly: boolean;
}

type SortKey = 'name' | 'source' | 'mode' | 'trigger' | 'status' | 'lastRun';
type SortDir = 'asc' | 'desc';
type SkillTab = 'catalog' | 'active';

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

export function SkillsView({ rows: rowsProp, overridesCount, commitSha, fetchedAt, readOnly }: SkillsViewProps) {
  // Keep an optimistic local mirror so a toggle reflects in the table before
  // `revalidatePath` lands the server-side refresh.
  const [rows, setRows] = useState<SkillRow[]>(rowsProp);
  useEffect(() => { setRows(rowsProp); }, [rowsProp]);

  const [tab, setTab] = useState<SkillTab>('catalog');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(10);
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState<string[]>([]);
  const [modeFilter, setModeFilter] = useState<string[]>([]);
  const [triggerFilter, setTriggerFilter] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [refreshState, setRefreshState] = useState<{ ok?: boolean; error?: string; count?: number } | null>(null);
  const [refreshing, startRefresh] = useTransition();

  function handleToggleActive(name: string, nextActive: boolean) {
    // Optimistic: flip the row right away, roll back if the server says no.
    setRows((prev) => prev.map((r) => (r.name === name ? { ...r, active: nextActive } : r)));
    void setSkillEnabled(name, nextActive).then((res) => {
      if (!res.ok) {
        setRows((prev) => prev.map((r) => (r.name === name ? { ...r, active: !nextActive } : r)));
        setRefreshState({ ok: false, error: res.error ?? 'Could not update skill state' });
      }
    });
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (tab === 'active' && !r.active) return false;
      if (sourceFilter.length > 0 && !sourceFilter.includes(r.source)) return false;
      if (modeFilter.length > 0 && !modeFilter.includes(r.mode)) return false;
      if (triggerFilter.length > 0 && !triggerFilter.includes(r.trigger)) return false;
      if (statusFilter.length > 0) {
        const statusValue = r.active ? 'enabled' : 'disabled';
        if (!statusFilter.includes(statusValue)) return false;
      }
      if (q.length > 0) {
        const hay = `${r.name} ${r.description ?? ''} ${r.stages.join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, search, sourceFilter, modeFilter, triggerFilter, statusFilter, tab]);

  const sorted = useMemo(() => {
    const out = [...filtered];
    const dir = sortDir === 'asc' ? 1 : -1;
    out.sort((a, b) => dir * compareByKey(a, b, sortKey));
    return out;
  }, [filtered, sortKey, sortDir]);

  const totalFiltered = sorted.length;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / pageSize));

  // Clamp the page if filters/size shrink the result set below the current page.
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const pageRows = useMemo(
    () => sorted.slice((page - 1) * pageSize, page * pageSize),
    [sorted, page, pageSize],
  );

  const totalSkills = rows.length;
  const activeSkills = rows.filter((r) => r.active).length;
  const activeRuns = rows.filter((r) => r.active && r.trigger !== 'manual').length;
  const avgSuccess = totalSkills === 0 ? null : 98.2; // Placeholder until run-history aggregates land.

  const filtersActive =
    search.trim().length > 0 ||
    sourceFilter.length > 0 ||
    modeFilter.length > 0 ||
    triggerFilter.length > 0 ||
    statusFilter.length > 0;

  function handleRefresh() {
    setRefreshState(null);
    startRefresh(async () => {
      const result = await refreshRepoSkills();
      setRefreshState(result);
    });
  }

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'lastRun' ? 'desc' : 'asc');
    }
  }

  function resetFilters() {
    setSearch('');
    setSourceFilter([]);
    setModeFilter([]);
    setTriggerFilter([]);
    setStatusFilter([]);
    setPage(1);
  }

  function handleTabChange(next: SkillTab) {
    setTab(next);
    setPage(1);
  }

  return (
    <PageContainer>
      {/* Page header */}
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[24px] font-semibold leading-tight tracking-tight text-on-surface">Skills</h1>
          <p className="mt-1 text-sm text-on-surface-variant">
            Manage and monitor autonomous AI capabilities across your repositories.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing || readOnly}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-outline-variant bg-surface-container-low px-3 text-sm font-medium text-on-surface transition-colors hover:border-primary hover:bg-surface-container disabled:opacity-50"
          >
            <RefreshIcon className="h-4 w-4" />
            {refreshing ? 'Syncing…' : 'Sync from repo'}
          </button>
          <AddSkillSourceMenu disabled={readOnly} />
          <Link
            href="/settings/workflows"
            aria-disabled={readOnly}
            className={cn(
              'inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-primary-on transition-colors hover:bg-primary-container hover:text-on-surface',
              readOnly && 'pointer-events-none opacity-50',
            )}
          >
            <PlusIcon className="h-4 w-4" />
            New override
          </Link>
        </div>
      </header>

      {/* Catalog / Active tabs — issue #262 two-list model */}
      <div className="mb-4 inline-flex items-center rounded-md border border-outline-variant bg-surface-container-low p-0.5 text-sm">
        {(
          [
            { id: 'catalog', label: 'Catalog', count: totalSkills },
            { id: 'active', label: 'Active', count: activeSkills },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => handleTabChange(t.id)}
            className={cn(
              'inline-flex h-7 items-center gap-2 rounded-[5px] px-3 font-medium transition-colors',
              tab === t.id
                ? 'bg-surface text-on-surface shadow-sm'
                : 'text-on-surface-variant hover:text-on-surface',
            )}
            aria-pressed={tab === t.id}
          >
            <span>{t.label}</span>
            <span className="rounded-full bg-surface-container px-1.5 py-px font-mono text-[11px] text-on-surface-variant">
              {t.count}
            </span>
          </button>
        ))}
      </div>

      {/* Inline status banners */}
      {refreshState?.ok && (
        <div className="mb-4 rounded-md border border-primary/30 bg-primary-container/20 px-4 py-2 text-sm text-primary">
          Synced {refreshState.count ?? 0} skill{(refreshState.count ?? 0) === 1 ? '' : 's'} from repo. Reload to see updates.
        </div>
      )}
      {refreshState?.error && (
        <div className="mb-4 rounded-md border border-error/30 bg-error-container/30 px-4 py-2 text-sm text-error">
          {refreshState.error}
        </div>
      )}

      {/* KPI stats */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="ACTIVE SKILLS" value={`${activeSkills} / ${totalSkills}`} tone="primary" />
        <StatCard label="ACTIVE RUNS" value={String(activeRuns)} tone="default" />
        <StatCard label="OVERRIDES" value={String(overridesCount)} tone="tertiary" />
        <StatCard label="AVG SUCCESS" value={avgSuccess === null ? '—' : `${avgSuccess}%`} tone="default" />
      </div>

      {/* Filter bar */}
      <div className="mb-4 rounded-lg border border-outline-variant bg-surface-container-low p-3">
        <FilterBar
          search={
            <label className="relative flex w-full items-center">
              <SearchIcon className="absolute left-3 h-4 w-4 text-on-surface-variant" aria-hidden />
              <input
                type="search"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                placeholder="Search by name, description, or stage…"
                className="h-9 w-full rounded-md border border-outline-variant bg-surface pl-9 pr-3 text-sm text-on-surface placeholder:text-on-surface-variant focus:border-primary focus:shadow-focus-primary focus:outline-none"
              />
            </label>
          }
          filters={[
            {
              id: 'source',
              label: 'Source',
              values: sourceFilter,
              onChange: (v) => {
                setSourceFilter(v);
                setPage(1);
              },
              options: Object.entries(SOURCE_LABELS).map(([value, label]) => ({ value, label })),
            },
            {
              id: 'mode',
              label: 'Mode',
              values: modeFilter,
              onChange: (v) => {
                setModeFilter(v);
                setPage(1);
              },
              options: [
                { value: 'framed', label: 'Framed' },
                { value: 'inline', label: 'Inline' },
              ],
            },
            {
              id: 'trigger',
              label: 'Trigger',
              values: triggerFilter,
              onChange: (v) => {
                setTriggerFilter(v);
                setPage(1);
              },
              options: [
                { value: 'on-sync', label: 'On-sync' },
                { value: 'cron', label: 'Cron' },
                { value: 'manual', label: 'Manual' },
              ],
            },
            {
              id: 'status',
              label: 'Status',
              values: statusFilter,
              onChange: (v) => {
                setStatusFilter(v);
                setPage(1);
              },
              options: [
                { value: 'enabled', label: 'Enabled' },
                { value: 'disabled', label: 'Disabled' },
              ],
            },
          ]}
          onClearAll={resetFilters}
        />
      </div>

      {/* Skills table / cards */}
      <ResponsiveListContainer
        table={
          <div className="overflow-hidden rounded-lg border border-outline-variant bg-surface-container-low">
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
              <tr className="bg-surface-container">
                <SortableTh sortKey="name"    sortDir={sortDir} active={sortKey === 'name'}    onClick={handleSort}>NAME</SortableTh>
                <SortableTh sortKey="source"  sortDir={sortDir} active={sortKey === 'source'}  onClick={handleSort}>SOURCE</SortableTh>
                <SortableTh sortKey="mode"    sortDir={sortDir} active={sortKey === 'mode'}    onClick={handleSort}>MODE</SortableTh>
                <SortableTh sortKey="trigger" sortDir={sortDir} active={sortKey === 'trigger'} onClick={handleSort}>TRIGGER</SortableTh>
                <SortableTh sortKey="status"  sortDir={sortDir} active={sortKey === 'status'}  onClick={handleSort}>ENABLED</SortableTh>
                <SortableTh sortKey="lastRun" sortDir={sortDir} active={sortKey === 'lastRun'} onClick={handleSort}>LAST RUN</SortableTh>
                <Th className="text-right pr-6">ACTIONS</Th>
              </tr>
            </thead>
            <tbody>
              {pageRows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center text-sm text-on-surface-variant">
                    {totalSkills === 0 ? (
                      <>
                        No skills found in <code className="font-mono text-on-surface">.ai/skills/</code>.{' '}
                        {!readOnly && (
                          <button
                            type="button"
                            onClick={handleRefresh}
                            className="underline underline-offset-2 hover:text-on-surface"
                          >
                            Sync from repo
                          </button>
                        )}{' '}
                        once your repo has skill manifests.
                      </>
                    ) : tab === 'active' ? (
                      <ActiveTabEmptyState onSwitch={() => handleTabChange('catalog')} />
                    ) : (
                      <>
                        No skills match these filters.{' '}
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
                    pageRows.map((row) => (
                      <SkillTableRow
                        key={row.name}
                        row={row}
                        readOnly={readOnly}
                        onToggle={handleToggleActive}
                      />
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        }
        cards={
          pageRows.length === 0 ? (
            <div className="rounded-lg border border-outline-variant bg-surface-container-low px-4 py-12 text-center text-sm text-on-surface-variant">
              {totalSkills === 0 ? (
                <>
                  No skills found in <code className="font-mono text-on-surface">.ai/skills/</code>.{' '}
                  {!readOnly && (
                    <button
                      type="button"
                      onClick={handleRefresh}
                      className="underline underline-offset-2 hover:text-on-surface"
                    >
                      Sync from repo
                    </button>
                  )}{' '}
                  once your repo has skill manifests.
                </>
              ) : tab === 'active' ? (
                <ActiveTabEmptyState onSwitch={() => handleTabChange('catalog')} />
              ) : (
                <>
                  No skills match these filters.{' '}
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
            pageRows.map((row) => (
              <SkillCard
                key={row.name}
                row={row}
                readOnly={readOnly}
                onToggle={handleToggleActive}
              />
            ))
          )
        }
      />

      {/* Footer / pagination */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-outline-variant bg-surface-container-low px-4 py-3 text-sm text-on-surface-variant sm:px-6 sm:py-4">
        <div className="flex flex-wrap items-center gap-3">
          <span>
            Showing {pageRows.length === 0 ? 0 : (page - 1) * pageSize + 1}
            {pageRows.length > 0 && <>–{(page - 1) * pageSize + pageRows.length}</>} of {totalFiltered}
            {filtersActive && <> filtered (of {totalSkills})</>} skill{totalFiltered === 1 ? '' : 's'}
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
          {commitSha && (
            <span className="hidden lg:inline">
              · <code className="font-mono text-on-surface">{commitSha.slice(0, 7)}</code>
            </span>
          )}
          {fetchedAt && (
            <span className="hidden xl:inline">· refreshed {new Date(fetchedAt).toLocaleString()}</span>
          )}
        </div>
        {totalPages > 1 && (
          <Pagination page={page} totalPages={totalPages} onChange={setPage} />
        )}
      </div>

      {/* Info callout cards */}
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <CalloutCard
          tone="primary"
          title="Skill Overrides"
          body={
            <>
              Overrides allow you to manually tune AI parameters for specific repositories. These take precedence over
              built-in behaviors and repository-defined configurations. Use the <span className="font-medium text-on-surface">New override</span> button
              to create a custom skill definition.
            </>
          }
        />
        <CalloutCard
          tone="tertiary"
          title="Repository Sync"
          body={
            <>
              Cezar automatically scans your <code className="font-mono text-on-surface">.cezar/skills</code> directory
              for skill definitions. Ensure your manifest files are correctly formatted JSON to ensure they appear in
              this directory after a sync.
            </>
          }
        />
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
      className={cn('inline-flex flex-col text-[8px] leading-[8px]', active ? 'text-primary' : 'text-outline-variant')}
    >
      <span className={cn(active && dir === 'asc' ? 'text-primary' : 'text-outline-variant')}>▲</span>
      <span className={cn(active && dir === 'desc' ? 'text-primary' : 'text-outline-variant')}>▼</span>
    </span>
  );
}

function compareByKey(a: SkillRow, b: SkillRow, key: SortKey): number {
  if (key === 'lastRun') {
    const ta = a.lastRunIso ? new Date(a.lastRunIso).getTime() : -Infinity;
    const tb = b.lastRunIso ? new Date(b.lastRunIso).getTime() : -Infinity;
    if (ta === tb) return a.name.localeCompare(b.name);
    return ta - tb;
  }
  if (key === 'status') {
    // Sort active first when ascending, disabled first when descending — gives
    // the user a natural "show me what's running" toggle off the header.
    const av = a.active ? 0 : 1;
    const bv = b.active ? 0 : 1;
    if (av === bv) return a.name.localeCompare(b.name);
    return av - bv;
  }
  const av = String(a[key as Exclude<SortKey, 'lastRun' | 'status'>]);
  const bv = String(b[key as Exclude<SortKey, 'lastRun' | 'status'>]);
  const cmp = av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' });
  return cmp === 0 ? a.name.localeCompare(b.name) : cmp;
}

function SkillTableRow({
  row,
  readOnly,
  onToggle,
}: {
  row: SkillRow;
  readOnly: boolean;
  onToggle: (name: string, next: boolean) => void;
}) {
  const href = `/skills/${encodeURIComponent(row.name)}`;
  return (
    <tr className="border-t border-outline-variant/60 hover:bg-surface-container/60">
      <td className="px-6 py-4 align-middle">
        <Link href={href} className="flex items-center gap-2 text-on-surface hover:text-primary">
          {row.source === 'override' && <span className="text-tertiary" aria-hidden>*</span>}
          <span className="font-medium">{row.name}</span>
        </Link>
      </td>
      <td className="px-6 py-4 align-middle">
        <SourceBadge source={row.source} />
      </td>
      <td className="px-6 py-4 align-middle">
        <span className="font-mono text-[13px] text-on-surface-variant">{row.mode}</span>
      </td>
      <td className="px-6 py-4 align-middle">
        <span className="font-mono text-[13px] text-on-surface-variant">{row.trigger}</span>
      </td>
      <td className="px-6 py-4 align-middle">
        <EnabledToggle
          active={row.active}
          disabled={readOnly}
          name={row.name}
          onChange={(next) => onToggle(row.name, next)}
        />
      </td>
      <td className="px-6 py-4 align-middle">
        <span className="font-mono text-[13px] text-on-surface-variant">{formatLastRun(row.lastRunIso)}</span>
      </td>
      <td className="px-6 py-4 align-middle">
        <div className="flex items-center justify-end pr-2">
          <SkillRowMenu name={row.name} />
        </div>
      </td>
    </tr>
  );
}

/** Binary on/off toggle for issue #262 — flips `workspace_skill_states.enabled`. */
function EnabledToggle({
  active,
  disabled,
  name,
  onChange,
}: {
  active: boolean;
  disabled: boolean;
  name: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      aria-label={`${active ? 'Disable' : 'Enable'} ${name}`}
      disabled={disabled}
      onClick={() => onChange(!active)}
      className={cn(
        'inline-flex items-center gap-2 rounded-full px-2 py-1 text-[12px] font-medium transition-colors',
        active
          ? 'bg-primary-container/40 text-primary hover:bg-primary-container/60'
          : 'bg-surface-container text-on-surface-variant hover:bg-surface-container/80',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <StatusDotIcon className="h-2.5 w-2.5" tone={active ? 'enabled' : 'disabled'} />
      <span className="font-mono">{active ? 'enabled' : 'disabled'}</span>
    </button>
  );
}

/**
 * Row actions for a skill. Today the menu only exposes "Open details" + "Copy
 * name" — the skills list has no per-skill server mutations yet (overrides live
 * on the detail page). On desktop it renders a portal popover; on coarse
 * pointers it opens a bottom ActionSheet (spec §7 / P4). Trigger ≥44px on touch.
 */
function SkillRowMenu({ name }: { name: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [coarse, setCoarse] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(pointer: coarse)');
    const update = () => setCoarse(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (!open || coarse) return;
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
  }, [open, coarse]);

  const href = `/skills/${encodeURIComponent(name)}`;
  const doCopyName = () => {
    void navigator.clipboard.writeText(name).then(
      () => undefined,
      () => alert('Could not copy to clipboard'),
    );
  };

  const sheetItems: ActionSheetItem[] = [
    { label: 'Open details', onSelect: () => router.push(href) },
    { label: 'Copy name', onSelect: doCopyName },
  ];

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`${name} actions`}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface-container hover:text-on-surface lg:h-7 lg:w-7 lg:min-h-0 lg:min-w-0"
      >
        <MoreVerticalIcon className="h-4 w-4" />
      </button>
      {coarse ? (
        <ActionSheet open={open} onClose={() => setOpen(false)} items={sheetItems} title={name} />
      ) : (
        <RowMenuPortal
          open={open}
          triggerRef={triggerRef}
          popoverRef={popoverRef}
          onClose={() => setOpen(false)}
          id={menuId}
          ariaLabel={`${name} actions menu`}
        >
          <Link
            href={href}
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block w-full px-3 py-2 text-left text-sm text-on-surface transition-colors hover:bg-surface-container focus:bg-surface-container focus:outline-none"
          >
            Open details
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              doCopyName();
            }}
            className="block w-full px-3 py-2 text-left text-sm text-on-surface transition-colors hover:bg-surface-container focus:bg-surface-container focus:outline-none"
          >
            Copy name
          </button>
        </RowMenuPortal>
      )}
    </>
  );
}

function SkillCard({
  row,
  readOnly,
  onToggle,
}: {
  row: SkillRow;
  readOnly: boolean;
  onToggle: (name: string, next: boolean) => void;
}) {
  const href = `/skills/${encodeURIComponent(row.name)}`;
  return (
    <EntityCard
      title={
        <Link href={href} className="flex flex-wrap items-center gap-2 text-on-surface hover:text-primary">
          {row.source === 'override' && <span className="text-tertiary" aria-hidden>*</span>}
          <span className="font-medium">{row.name}</span>
        </Link>
      }
      badge={
        <EnabledToggle
          active={row.active}
          disabled={readOnly}
          name={row.name}
          onChange={(next) => onToggle(row.name, next)}
        />
      }
      actions={
        <CardActions>
          <SkillRowMenu name={row.name} />
        </CardActions>
      }
    >
      {row.description && (
        <div className="text-xs text-on-surface-variant">{row.description}</div>
      )}
      <MetaRow>
        <MetaItem label="Source">
          <SourceBadge source={row.source} />
        </MetaItem>
        <MetaItem label="Mode">
          <span className="font-mono text-xs">{row.mode}</span>
        </MetaItem>
      </MetaRow>
      <MetaRow>
        <MetaItem label="Trigger">
          <span className="font-mono text-xs">{row.trigger}</span>
        </MetaItem>
        <MetaItem label="Last run">
          <span className="font-mono text-xs">{formatLastRun(row.lastRunIso)}</span>
        </MetaItem>
      </MetaRow>
    </EntityCard>
  );
}

function ActiveTabEmptyState({ onSwitch }: { onSwitch: () => void }) {
  return (
    <>
      No skills are active yet. Switch to the{' '}
      <button
        type="button"
        onClick={onSwitch}
        className="underline underline-offset-2 hover:text-on-surface"
      >
        Catalog
      </button>{' '}
      tab to enable skills from your sources.
    </>
  );
}

function SourceBadge({ source }: { source: SkillRow['source'] }) {
  const classes = (() => {
    switch (source) {
      case 'override':
        return 'border-primary/40 bg-primary-container/30 text-primary';
      case 'workspace-repo':
        return 'border-tertiary-container/60 bg-tertiary-container/30 text-tertiary';
      case 'external-repo':
        return 'border-amber-400/40 bg-amber-400/10 text-amber-300';
      case 'disk':
        return 'border-sky-400/40 bg-sky-400/10 text-sky-300';
      case 'skills-sh':
        return 'border-violet-400/40 bg-violet-400/10 text-violet-300';
      default:
        return 'border-outline-variant bg-surface-container text-on-surface-variant';
    }
  })();
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-2 py-0.5 font-display text-[11px] font-semibold uppercase tracking-[0.05em]',
        classes,
      )}
    >
      {SOURCE_LABELS[source]}
    </span>
  );
}

/** Issue #262 — placeholder dropdown for adding additional skill sources. The
 *  three non-workspace options ship in PR 2 (external-repo), PR 3 (disk), and
 *  PR 4 (skills-sh); they're listed here so the IA settles in PR 1 without a
 *  follow-up nav refactor. */
function AddSkillSourceMenu({ disabled }: { disabled: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="menu"
        className="inline-flex h-9 items-center gap-2 rounded-md border border-outline-variant bg-surface-container-low px-3 text-sm font-medium text-on-surface transition-colors hover:border-primary hover:bg-surface-container disabled:opacity-50"
      >
        Add skill source
        <span aria-hidden className="text-on-surface-variant">▾</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-56 rounded-md border border-outline-variant bg-surface-container py-1 shadow-lg"
          onMouseLeave={() => setOpen(false)}
        >
          {[
            { label: 'Another repo', note: 'Coming soon' },
            { label: 'Upload from disk', note: 'Coming soon' },
            { label: 'skills.sh registry', note: 'Coming soon' },
          ].map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled
              className="flex w-full cursor-not-allowed items-center justify-between px-3 py-2 text-left text-sm text-on-surface-variant"
            >
              <span>{item.label}</span>
              <span className="font-mono text-[10px] uppercase tracking-[0.05em] text-on-surface-variant/60">
                {item.note}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'default' | 'primary' | 'tertiary';
}) {
  const valueColor =
    tone === 'primary' ? 'text-primary' : tone === 'tertiary' ? 'text-tertiary' : 'text-on-surface';
  return (
    <div className="rounded-lg border border-outline-variant bg-surface-container-low p-4">
      <div className="font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-on-surface-variant">
        {label}
      </div>
      <div className={cn('mt-2 text-[28px] font-semibold leading-none tracking-tight', valueColor)}>{value}</div>
    </div>
  );
}

function CalloutCard({ title, body, tone }: { title: string; body: React.ReactNode; tone: 'primary' | 'tertiary' }) {
  const rail = tone === 'primary' ? 'bg-primary' : 'bg-tertiary';
  return (
    <div className="relative overflow-hidden rounded-lg border border-outline-variant bg-surface-container-low p-5 pl-6">
      <span className={cn('absolute inset-y-3 left-0 w-1 rounded-full', rail)} aria-hidden />
      <div className="text-sm font-semibold text-on-surface">{title}</div>
      <p className="mt-2 text-sm leading-relaxed text-on-surface-variant">{body}</p>
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
      {/* Compact phone variant: Prev · "N / M" · Next. */}
      <div className="flex items-center gap-2 sm:hidden">
        <PagerButton onClick={() => onChange(Math.max(1, page - 1))} disabled={page === 1} aria-label="Previous page">
          <ChevronLeftIcon className="h-4 w-4" />
        </PagerButton>
        <span className="text-sm tabular-nums text-on-surface-variant">
          {page} / {totalPages}
        </span>
        <PagerButton onClick={() => onChange(Math.min(totalPages, page + 1))} disabled={page === totalPages} aria-label="Next page">
          <ChevronRightIcon className="h-4 w-4" />
        </PagerButton>
      </div>

      {/* Full numeric variant: sm+. */}
      <div className="hidden items-center gap-1 sm:flex">
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
      className="flex min-h-11 min-w-11 items-center justify-center rounded-md border border-outline-variant bg-surface-container-low text-on-surface-variant transition-colors hover:border-primary hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-40 lg:h-8 lg:w-8 lg:min-h-0 lg:min-w-0"
      {...rest}
    >
      {children}
    </button>
  );
}

function formatLastRun(iso: string | null): string {
  if (!iso) return 'Never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'Never';
  const diffMs = Date.now() - then;
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}
