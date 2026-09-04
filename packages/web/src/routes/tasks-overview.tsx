import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CheckCheckIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
  Clock3Icon,
  CoinsIcon,
  CpuIcon,
  DollarSignIcon,
  EyeIcon,
  EyeOffIcon,
  FileDiffIcon,
  GitBranchIcon,
  ListChecksIcon,
  LinkIcon,
  MemoryStickIcon,
  PencilIcon,
  PlusIcon,
  ScaleIcon,
  SearchIcon,
  SearchXIcon,
  WorkflowIcon,
  XIcon,
} from 'lucide-react'
import * as React from 'react'
import { Link, useNavigate } from '@/lib/project-router'

import { archiveFinished, archiveRun, markAllRunsSeen, markRunSeen, markRunUnseen, patchRun } from '@/api/client'
import { useRunUsage } from '@/api/global-events'
import { queryKeys, useHealth, useReferenceProjectId, useRuns } from '@/api/queries'
import type { RunRecord } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { DiffStatLabel } from '@/components/diff-stat'
import { DirectionalUsage } from '@/components/directional-usage'
import { TitleEditInput, useTitleEditor } from '@/components/editable-title'
import { FacetFilter } from '@/components/facet-filter'
import { useListView } from '@/components/list-view'
import { Pill } from '@/components/pill'
import { TaskReferenceChip } from '@/components/reference-conflict-action'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { deriveAttention } from '@/lib/attention'
import { shortAge } from '@/lib/format'
import { isReadDoneItem, isUnread, unreadDoneCount } from '@/lib/read-state'
import {
  isColumnExpanded,
  normalizeExpandedColumns,
  taskColumnsForCapabilities,
  type NormalizedExpandedColumns,
  type TaskColumnDefinition,
  type TaskColumnIcon,
  type TaskColumnId,
} from '@/lib/task-columns'
import { listCounts, queuePositions, runTitle, sortRuns, type ListView } from '@/lib/task-groups'
import {
  BULK_ACTION_IDS,
  NO_SELECTION,
  bulkResultMessage,
  selectionSummary,
  toggleAllVisible,
  toggleSelected,
  type BulkActionId,
  type HeaderSelectionState,
  type SelectionSummary,
} from '@/lib/task-selection'
import {
  NO_TASK_FILTERS,
  activeFilterCount,
  compareGroups,
  filterTaskList,
  finishedRunCount,
  formatCost,
  hasActiveTaskFilters,
  scheduledResume,
  statusFacetOptions,
  taskReference,
  toggleStatusFilter,
  usageCells,
  workflowLabel,
  type TaskListFilters,
  type UsageCell,
} from '@/lib/tasks-table'
import { usageMetricVisibility } from '@/lib/token-metrics'
import { useTaskTableColumns } from '@/lib/use-task-table-columns'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'

/**
 * The Tasks overview — the table that IS the home at `/` (spec, "Task list & table", per PR
 * #392: the Tasks nav always lands here, there is no list/table presentation toggle, and the
 * Active/Archived tabs in this header are the *same state* as the sidebar quick-list's tabs).
 *
 * Presentational: sorting, search, queue numbers, usage-cell decisions and the compare strip
 * all come from the pure modules (`lib/task-groups.ts`, `lib/tasks-table.ts`,
 * `lib/attention.ts`). What lives here is markup, the router, and the local search text.
 *
 * Below `md` the table becomes a stacked card list plus a New-task FAB — same rows, same order,
 * same data, only the framing changes (mockup `tasks-home.html`, mobile section).
 */
export function TasksOverview({
  runs,
  view,
  onViewChange,
  onArchiveFinished,
  onMarkAllRead,
  onRename,
  onBulkAction = () => undefined,
  bulkPending = false,
  now = Date.now(),
  showTokens = true,
  showCost = true,
  expandedColumns = normalizeExpandedColumns(undefined),
  onToggleColumn = () => undefined,
  columnsPending = false,
}: {
  /** Undefined while `/api/runs` has not answered: the header renders, the body stays empty —
   *  an empty state before we know there are no runs would be a lie. */
  runs: RunRecord[] | undefined
  view: ListView
  onViewChange: (view: ListView) => void
  onArchiveFinished: () => void
  /** "Mark all read" (#unread-done-items) — stamps every unread finished run. */
  onMarkAllRead: () => void
  /** Inline rename from the table's Task cell (spec step 15) — the route wires this to
   *  `PATCH /api/runs/:id`, the same flow as the run header's pencil. */
  onRename: (id: string, title: string) => void
  /** One bulk edit over the selected rows. Already narrowed to the rows the action would really
   *  change (`SelectionSummary.targets`), so the route fans out exactly N requests and reports
   *  exactly N outcomes. Defaulted, like `onToggleColumn`, so a direct render needs no stub. */
  onBulkAction?: (action: BulkActionId, runs: readonly RunRecord[]) => void
  /** A bulk edit is in flight — the bar's buttons wait rather than letting a second batch race
   *  the first over the same rows. */
  bulkPending?: boolean
  /** Injected so the ages are not racing the clock in tests. */
  now?: number
  /** Presentation capability; defaults visible for older health responses and direct renders. */
  showTokens?: boolean
  showCost?: boolean
  /** Workspace-global desktop column choices; absent ids use registry defaults. */
  expandedColumns?: NormalizedExpandedColumns
  onToggleColumn?: (id: TaskColumnId) => void
  /** Prevent a shallow write before the authoritative workspace state can preserve siblings. */
  columnsPending?: boolean
}) {
  const [filters, setFilters] = React.useState<TaskListFilters>(NO_TASK_FILTERS)
  // Selected row ids. Kept raw — never pruned by an effect — because every reader intersects it
  // with what is on screen (`selectionSummary`), so an id whose row left the view is already
  // inert. An effect that pruned it would be a second source of truth racing the first.
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(NO_SELECTION)
  const all = runs ?? []
  const counts = listCounts(all)
  // In-view (Active or Archived) and sorted, before the filter bar narrows it: the status facet's
  // options come from here, so it offers the statuses of the list you are LOOKING at rather than
  // the ones your own ticks have left.
  const inView = sortRuns(all, view)
  const visible = filterTaskList(inView, filters)
  // Positions come from the full list, never the filtered one: a search must not renumber the
  // queue the engine is actually going to drain.
  const positions = queuePositions(all)
  const strips = compareGroups(filterTaskList(all, filters), view)
  const finished = finishedRunCount(all)
  const columns = taskColumnsForCapabilities({ tokens: showTokens, cost: showCost })
  const unread = unreadDoneCount(all)
  const statusOptions = statusFacetOptions(inView, filters)
  const selection = selectionSummary(visible, selected)

  const setQuery = (query: string) => setFilters((current) => ({ ...current, query }))
  const clearFilters = () => setFilters(NO_TASK_FILTERS)
  // The bar acts, then empties itself: the rows it changed are usually leaving the view (an
  // archive is the motivating case), and a selection left pointing at them would invite a second
  // click that does nothing. The receipt is the route's toast, not a lingering tick.
  const runBulkAction = (action: BulkActionId) => {
    const targets = selection.targets[action]
    if (targets.length === 0) return
    onBulkAction(action, targets)
    setSelected(NO_SELECTION)
  }

  return (
    <div data-route="tasks" className="flex min-h-full flex-col">
      {/* Desktop header. Below `md` the shell's top bar already says "Tasks", and the drawer
          carries the shared Active/Archived tabs — repeating them here would be a third copy. */}
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">Tasks</h1>
        <div className="inline-flex gap-0.5 rounded-md bg-muted p-[3px]">
          <OverviewTab view="active" current={view} onSelect={onViewChange} count={counts.active}>
            Active
          </OverviewTab>
          <OverviewTab view="archived" current={view} onSelect={onViewChange} count={counts.archived}>
            Archived
          </OverviewTab>
        </div>
        <div className="flex-1" />
        {/* Count-gated, like the broom beside it: offered only while there is unread history to
            clear (#unread-done-items). Archived runs are never unread, so this only ever lights
            on the Active tab in practice — no need to also gate on `view`. */}
        {unread > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-slot="mark-all-read"
            onClick={onMarkAllRead}
          >
            <CheckCheckIcon className="size-3.5" aria-hidden="true" />
            Mark all read
          </Button>
        ) : null}
        {/* Only when there is something to sweep, like the legacy header's count-gated broom. */}
        {view === 'active' && finished > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-slot="archive-finished"
            onClick={onArchiveFinished}
          >
            <ArchiveIcon className="size-3.5" aria-hidden="true" />
            Archive finished
          </Button>
        ) : null}
        {/* Status, as the same searchable multi-select pill the global Tasks page uses — one
            filter grammar across both surfaces. Multi-select rather than a `<select>` because
            "what is waiting on me OR failed?" is the question people actually ask, and each
            option carries the number of rows it would leave. */}
        <FacetFilter
          slot="status"
          label="Status"
          selected={filters.statuses}
          onToggle={(value) => setFilters((current) => ({ ...current, statuses: toggleStatusFilter(current.statuses, value) }))}
          onClear={() => setFilters((current) => ({ ...current, statuses: [] }))}
          options={statusOptions}
          searchPlaceholder="Search statuses…"
          emptyLabel="No tasks to filter"
        />
        {hasActiveTaskFilters(filters) ? (
          <button
            type="button"
            data-action="clear-filters"
            onClick={clearFilters}
            className="inline-flex h-7 items-center gap-1 rounded-full px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <XIcon className="size-3" aria-hidden="true" />
            Clear
            {` (${activeFilterCount(filters)})`}
          </button>
        ) : null}
        <div className="relative w-60">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-soft-foreground"
            aria-hidden="true"
          />
          <input
            type="text"
            value={filters.query}
            onChange={(event) => setQuery(event.target.value)}
            // The number is advertised because it is not guessable: a box that says only
            // "Search tasks" is not a box anyone pastes a PR number into. (Spelled in words
            // rather than as a `#nnn` example — a three-digit one reads as a hex colour to the
            // design guardian, and it is not worth an exception.)
            placeholder="Search tasks, or a PR/issue number…"
            aria-label="Search tasks"
            className="h-9 w-full rounded-md border border-input bg-card pr-3 pl-8 text-[13px] text-foreground outline-none placeholder:text-soft-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
        </div>
      </header>

      <div className="flex flex-1 flex-col p-3 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-5 md:pb-5">
        {selection.count > 0 ? (
          <BulkActionBar
            selection={selection}
            pending={bulkPending}
            onAction={runBulkAction}
            onClear={() => setSelected(NO_SELECTION)}
          />
        ) : null}

        {runs === undefined ? null : visible.length === 0 ? (
          <TasksEmptyState view={view} filters={filters} />
        ) : (
          <>
            {/* ≥md: the table. */}
            <div
              data-slot="tasks-table"
              className="hidden overflow-x-auto rounded-lg border border-border bg-card shadow-xs md:block"
            >
              <TooltipProvider>
                <table className="w-full border-collapse">
                  <colgroup>
                    {/* The selection column is outside the foldable registry on purpose: it is
                        not a column of run DATA, it is the handle for editing the rows, and it
                        must never be folded away with the metric columns. */}
                    <col data-column-id="select" style={{ width: '38px' }} />
                    {columns.map((column) => {
                      const expanded = isColumnExpanded(column.id, expandedColumns)
                      return (
                        <col
                          key={column.id}
                          data-column-id={column.id}
                          data-expanded={expanded}
                          style={{ width: expanded ? column.width : '42px' }}
                        />
                      )
                    })}
                  </colgroup>
                  <thead>
                    <tr>
                      <th
                        scope="col"
                        data-column-id="select"
                        className="h-[38px] border-b border-border px-2.5 text-left first:pl-4"
                      >
                        <SelectionCheckbox
                          slot="select-all"
                          state={selection.state}
                          // "Select all" over the FILTERED list, always — never the rows a
                          // filter is hiding. See `toggleAllVisible`.
                          label={selection.state === 'none' ? 'Select all tasks' : 'Clear selection'}
                          onToggle={() => setSelected((current) => toggleAllVisible(visible, current))}
                        />
                      </th>
                      {columns.map((column) => (
                        <TaskColumnHeader
                          key={column.id}
                          column={column}
                          expanded={isColumnExpanded(column.id, expandedColumns)}
                          onToggle={onToggleColumn}
                          disabled={columnsPending}
                        />
                      ))}
                    </tr>
                  </thead>
                  <tbody className="[&>tr:last-child>td]:border-b-0">
                    {visible.map((run) => (
                      <TableRow
                        key={run.id}
                        run={run}
                        queuePosition={run.status === 'queued' ? (positions.get(run.id) ?? null) : null}
                        onRename={onRename}
                        now={now}
                        columns={columns}
                        expandedColumns={expandedColumns}
                        selected={selected.has(run.id)}
                        onToggleSelected={() => setSelected((current) => toggleSelected(current, run.id))}
                      />
                    ))}
                  </tbody>
                </table>
              </TooltipProvider>
            </div>

            {/* <md: the same runs as stacked cards. */}
            <div data-slot="task-cards" className="flex flex-col gap-2.5 md:hidden">
              {visible.map((run) => (
                <TaskCard
                  key={run.id}
                  run={run}
                  queuePosition={run.status === 'queued' ? (positions.get(run.id) ?? null) : null}
                  now={now}
                  showTokens={showTokens}
                  showCost={showCost}
                  selected={selected.has(run.id)}
                  onToggleSelected={() => setSelected((current) => toggleSelected(current, run.id))}
                />
              ))}
            </div>
          </>
        )}

        {strips.map((group) => (
          <div
            key={group.groupId}
            data-slot="compare-strip"
            data-group-id={group.groupId}
            className="mt-3.5 flex flex-wrap items-center gap-2.5 rounded-lg border border-border bg-card px-3.5 py-2.5 text-[12.5px] text-muted-foreground shadow-xs"
          >
            <ScaleIcon className="size-[15px] shrink-0 text-soft-foreground" aria-hidden="true" />
            <span>
              <strong className="font-semibold text-foreground">{group.title}</strong> — {group.count} variants
              finished
            </span>
            <Button asChild variant="outline" size="sm" className="md:ml-auto">
              <Link to={`/compare/${group.groupId}`}>Compare</Link>
            </Button>
          </div>
        ))}
      </div>

      {/* The mobile New-task FAB. The desktop CTA lives in the sidebar. A router Link since
          R4 step 1.3 re-pointed /new at the React composer — no full page load needed. */}
      <Link
        to="/new"
        data-slot="new-task-fab"
        aria-label="New task"
        className="fixed right-4 bottom-[calc(16px+env(safe-area-inset-bottom))] z-20 inline-flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-modal md:hidden"
      >
        <PlusIcon className="size-[22px]" aria-hidden="true" />
      </Link>
    </div>
  )
}

/**
 * What an empty list honestly means, given how it got empty — as a CenteredState, one variant
 * per cause. Only the no-tasks-at-all state is a hero moment and gets the twinkle backdrop
 * (spec: textures on hero/empty surfaces only); a missed search or an unswept archive is just
 * a fact, so those stay flat. `heading="h2"` because the page's h1 is the header's "Tasks".
 */
function TasksEmptyState({ view, filters }: { view: ListView; filters: TaskListFilters }) {
  const needle = filters.query.trim()
  // A status tick empties the list exactly as a missed search does, and for the same reason —
  // something the reader turned on. Reporting "Nothing archived yet" over a filtered-away archive
  // would blame the list for the filter.
  const kind = hasActiveTaskFilters(filters) ? 'search-miss' : view === 'archived' ? 'archive' : 'no-tasks'
  return (
    <div data-slot="tasks-empty" data-empty-kind={kind} className="flex flex-1 flex-col">
      {kind === 'search-miss' ? (
        <CenteredState
          heading="h2"
          icon={<SearchXIcon />}
          tone="neutral"
          title="No matching tasks"
          subtitle={needle ? `No tasks match “${needle}”.` : 'No tasks match the filters you picked.'}
        />
      ) : kind === 'archive' ? (
        <CenteredState
          heading="h2"
          icon={<ArchiveIcon />}
          tone="neutral"
          title="Nothing archived yet"
          subtitle="Finished tasks you archive land here."
        />
      ) : (
        <CenteredState
          heading="h2"
          icon={<ListChecksIcon />}
          tone="primary"
          backdrop
          title="No tasks yet"
          subtitle="Describe a task to get started."
          actions={
            <Button asChild>
              <Link to="/new">
                <PlusIcon aria-hidden="true" />
                New task
              </Link>
            </Button>
          }
        />
      )}
    </div>
  )
}

function OverviewTab({
  view,
  current,
  onSelect,
  count,
  children,
}: {
  view: ListView
  current: ListView
  onSelect: (view: ListView) => void
  count: number
  children: React.ReactNode
}) {
  const isActive = view === current
  return (
    <button
      type="button"
      data-slot="overview-tab"
      data-view={view}
      // Same rationale as the sidebar's tabs: these filter one list in place, they do not switch
      // panels — `aria-pressed` is what that actually is.
      aria-pressed={isActive}
      onClick={() => onSelect(view)}
      className={cn(
        'flex h-7 items-center justify-center gap-1.5 rounded-[7px] px-3 text-[12.5px] font-medium text-muted-foreground',
        isActive && 'bg-card font-semibold text-foreground shadow-xs'
      )}
    >
      {children}
      {count > 0 ? <span className="font-mono text-[11px] tabular-nums">{count}</span> : null}
    </button>
  )
}

/**
 * One tick box — a row's, or the header's tri-state one.
 *
 * A native `<input type="checkbox">` rather than a styled `<div role="checkbox">`, because the
 * row it sits in already exempts real controls from its click-to-navigate handler (`closest('a,
 * button, input')`), and because a native box is the one that keyboards, screen readers and
 * shift-click already understand. `indeterminate` is a DOM property with no attribute, so it is
 * set through the ref — the one thing React cannot express declaratively here.
 */
function SelectionCheckbox({
  state,
  label,
  onToggle,
  slot = 'select-task',
  className,
}: {
  state: HeaderSelectionState
  label: string
  onToggle: () => void
  slot?: string
  className?: string
}) {
  return (
    <input
      type="checkbox"
      data-slot={slot}
      data-state={state}
      checked={state === 'all'}
      ref={(element) => {
        if (element) element.indeterminate = state === 'some'
      }}
      onChange={onToggle}
      aria-label={label}
      title={label}
      className={cn('size-3.5 shrink-0 cursor-pointer accent-violet', className)}
    />
  )
}

/** What each bulk action is called, and what it looks like. One table so the bar renders from
 *  `BULK_ACTION_IDS` and a fifth action is an entry here plus a case in the route's fan-out. */
const BULK_ACTIONS: Record<BulkActionId, { label: string; icon: React.ReactNode; nothing: string }> = {
  archive: {
    label: 'Archive',
    icon: <ArchiveIcon className="size-3.5" aria-hidden="true" />,
    nothing: 'Nothing selected can be archived — only finished tasks can be.',
  },
  restore: {
    label: 'Restore',
    icon: <ArchiveRestoreIcon className="size-3.5" aria-hidden="true" />,
    nothing: 'Nothing selected is archived.',
  },
  read: {
    label: 'Mark read',
    icon: <EyeIcon className="size-3.5" aria-hidden="true" />,
    nothing: 'Nothing selected is unread.',
  },
  unread: {
    label: 'Mark unread',
    icon: <EyeOffIcon className="size-3.5" aria-hidden="true" />,
    nothing: 'Nothing selected can go back to unread.',
  },
}

/**
 * The multi-edit bar: what a selection can be done to, and to how many rows.
 *
 * It appears only with a selection and offers all four actions every time, DISABLED rather than
 * hidden when the selection has nothing for them. A bar whose buttons appear and vanish as rows
 * are ticked is a bar you cannot aim at, and the disabled state carries the reason in its title —
 * "only finished tasks can be archived" is the answer to why the button will not press, and it is
 * better said than left to be guessed.
 *
 * Each count is the number of rows the action would REALLY change, not the size of the selection:
 * archiving five rows of which two are already archived is a three-row action and says three.
 */
function BulkActionBar({
  selection,
  pending,
  onAction,
  onClear,
}: {
  selection: SelectionSummary
  pending: boolean
  onAction: (action: BulkActionId) => void
  onClear: () => void
}) {
  return (
    <div
      data-slot="bulk-action-bar"
      role="group"
      aria-label="Edit selected tasks"
      className="mb-3 flex flex-wrap items-center gap-1.5 rounded-lg border border-violet/40 bg-violet/10 px-3 py-2 shadow-xs"
    >
      <span data-slot="bulk-selection-count" className="text-[12.5px] font-semibold text-foreground tabular-nums">
        {selection.count} selected
      </span>
      <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
      {BULK_ACTION_IDS.map((id) => {
        const action = BULK_ACTIONS[id]
        const count = selection.targets[id].length
        return (
          <Button
            key={id}
            type="button"
            variant="outline"
            size="sm"
            data-action={`bulk-${id}`}
            disabled={count === 0 || pending}
            title={count === 0 ? action.nothing : `${action.label} ${count} task${count === 1 ? '' : 's'}`}
            onClick={() => onAction(id)}
          >
            {action.icon}
            {action.label}
            {count > 0 ? <span className="font-mono text-[11px] tabular-nums">{count}</span> : null}
          </Button>
        )
      })}
      <button
        type="button"
        data-action="bulk-clear"
        onClick={onClear}
        className="ml-auto inline-flex h-7 items-center gap-1 rounded-full px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <XIcon className="size-3" aria-hidden="true" />
        Clear selection
      </button>
    </div>
  )
}

function Th({
  children,
  right = false,
  columnId,
  folded = false,
}: {
  children: React.ReactNode
  right?: boolean
  columnId: TaskColumnId
  folded?: boolean
}) {
  return (
    <th
      scope="col"
      data-column-id={columnId}
      data-folded={folded || undefined}
      className={cn(
        'h-[38px] border-b border-border px-2.5 text-left text-[11px] font-semibold tracking-[0.05em] whitespace-nowrap text-soft-foreground uppercase first:pl-4 last:pr-4',
        right && 'text-right',
        folded && 'px-0 first:pl-0 last:pr-0',
      )}
    >
      {children}
    </th>
  )
}

function TaskColumnHeader({
  column,
  expanded,
  onToggle,
  disabled,
}: {
  column: TaskColumnDefinition
  expanded: boolean
  onToggle: (id: TaskColumnId) => void
  disabled: boolean
}) {
  if (!column.canFold) {
    return (
      <Th columnId={column.id} right={column.align === 'right'}>
        {column.label}
      </Th>
    )
  }

  const action = expanded ? 'Fold' : 'Expand'
  return (
    <Th columnId={column.id} right={column.align === 'right'} folded={!expanded}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`${action} ${column.label} column`}
            aria-pressed={expanded}
            disabled={disabled}
            onClick={() => onToggle(column.id)}
            className={cn(
              'inline-flex h-8 w-full items-center gap-1 rounded-sm px-0.5 text-inherit outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-wait disabled:opacity-60',
              column.align === 'right' ? 'justify-end' : 'justify-start',
              !expanded && 'justify-center px-0',
            )}
          >
            {expanded ? (
              <>
                <span>{column.label}</span>
                <ChevronsLeftIcon className="size-3 opacity-55" aria-hidden="true" />
              </>
            ) : (
              <>
                <TaskColumnIconView icon={column.icon} />
                <ChevronsRightIcon className="size-3 opacity-70" aria-hidden="true" />
              </>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">{column.label} · {action} column</TooltipContent>
      </Tooltip>
    </Th>
  )
}

function TaskColumnIconView({ icon }: { icon?: TaskColumnIcon }) {
  const className = 'size-3.5'
  switch (icon) {
    case 'workflow':
      return <WorkflowIcon className={className} aria-hidden="true" />
    case 'branch':
      return <GitBranchIcon className={className} aria-hidden="true" />
    case 'diff':
      return <FileDiffIcon className={className} aria-hidden="true" />
    case 'reference':
      return <LinkIcon className={className} aria-hidden="true" />
    case 'tokens':
      return <CoinsIcon className={className} aria-hidden="true" />
    case 'cost':
      return <DollarSignIcon className={className} aria-hidden="true" />
    case 'cpu':
      return <CpuIcon className={className} aria-hidden="true" />
    case 'memory':
      return <MemoryStickIcon className={className} aria-hidden="true" />
    case 'started':
      return <Clock3Icon className={className} aria-hidden="true" />
    default:
      return null
  }
}

const TD_BASE = 'h-11 border-b border-border px-2.5 whitespace-nowrap first:pl-4 last:pr-4'

/**
 * One run, one row.
 *
 * The whole row is a click target for `/tasks/:id` — but a click that lands on any anchor,
 * button or input inside it (the PR chip, the title's real link, the rename pencil and its
 * input) belongs to that control and is not hijacked. The title is a true `<Link>` so the
 * row's destination exists for keyboards and middle-clicks too.
 */
function TableRow({
  run,
  queuePosition,
  onRename,
  now,
  columns,
  expandedColumns,
  selected,
  onToggleSelected,
}: {
  run: RunRecord
  queuePosition: number | null
  onRename: (id: string, title: string) => void
  now: number
  columns: readonly TaskColumnDefinition[]
  expandedColumns: NormalizedExpandedColumns
  selected: boolean
  onToggleSelected: () => void
}) {
  const navigate = useNavigate()
  const attention = deriveAttention(run)
  const scheduled = scheduledResume(run)
  const to = `/tasks/${run.id}`
  const cost = formatCost(run.costUsd)
  const reference = taskReference(run)

  return (
    <tr
      data-slot="task-table-row"
      data-run-id={run.id}
      data-selected={selected || undefined}
      onClick={(event) => {
        if ((event.target as Element).closest('a, button, input')) return
        navigate(to)
      }}
      className={cn('group/row cursor-pointer hover:bg-muted', selected && 'bg-violet/5')}
    >
      <td data-column-id="select" className={TD_BASE}>
        <SelectionCheckbox
          state={selected ? 'all' : 'none'}
          label={`Select ${runTitle(run)}`}
          onToggle={onToggleSelected}
        />
      </td>
      {columns.map((column) => {
        if (column.id === 'memory') return null
        if (column.id === 'cpu') {
          return queuePosition !== null ? (
            <td
              key={column.id}
              data-slot="queue-note"
              data-column-id="cpu-memory"
              colSpan={2}
              className={cn(TD_BASE, 'text-right font-mono text-[11.5px] text-soft-foreground')}
            >
              #{queuePosition} in queue
            </td>
          ) : (
            <UsageTds
              key={column.id}
              run={run}
              cpuExpanded={isColumnExpanded('cpu', expandedColumns)}
              memoryExpanded={isColumnExpanded('memory', expandedColumns)}
            />
          )
        }
        return (
          <TaskTableCell
            key={column.id}
            column={column}
            expanded={isColumnExpanded(column.id, expandedColumns)}
            run={run}
            attention={attention}
            scheduled={scheduled}
            reference={reference}
            cost={cost}
            to={to}
            onRename={onRename}
            now={now}
          />
        )
      })}
    </tr>
  )
}

function TaskTableCell({
  column,
  expanded,
  run,
  attention,
  scheduled,
  reference,
  cost,
  to,
  onRename,
  now,
}: {
  column: TaskColumnDefinition
  expanded: boolean
  run: RunRecord
  attention: ReturnType<typeof deriveAttention>
  scheduled: ReturnType<typeof scheduledResume>
  reference: ReturnType<typeof taskReference>
  cost: string
  to: string
  onRename: (id: string, title: string) => void
  now: number
}) {
  if (!expanded) return <FoldedTd column={column.id} />

  switch (column.id) {
    case 'status':
      return (
        <td data-column-id={column.id} className={TD_BASE}>
          {/* A scheduled run wears its appointment in the pill, the way a queued one wears its
              queue position — the row's whole answer to "what is this waiting for?". */}
          <Pill dot={attention.tone} pulse={attention.pulse} title={scheduled?.title}>
            {attention.label}
            {scheduled ? <span className="tabular-nums">{scheduled.label}</span> : null}
          </Pill>
        </td>
      )
    case 'task':
      return (
        <td data-column-id={column.id} className={cn(TD_BASE, 'min-w-[220px] max-w-0')}>
          <TitleCell run={run} to={to} onRename={onRename} />
        </td>
      )
    case 'workflow':
      return (
        <td data-column-id={column.id} className={cn(TD_BASE, 'text-[12.5px] text-muted-foreground')}>
          {workflowLabel(run)}
        </td>
      )
    case 'branch':
      return (
        <td data-column-id={column.id} className={TD_BASE}>
          {run.branch ? <BranchChip branch={run.branch} /> : <Dash />}
        </td>
      )
    case 'diff':
      return (
        <td data-column-id={column.id} className={TD_BASE}>
          {run.diffStat ? <DiffStatLabel stat={run.diffStat} /> : <Dash />}
        </td>
      )
    case 'reference':
      return (
        <td data-column-id={column.id} className={TD_BASE}>
          {reference ? <TaskReferenceChip run={run} reference={reference} /> : <Dash />}
        </td>
      )
    case 'tokens':
      return (
        <td data-column-id={column.id} className={cn(TD_BASE, 'text-right text-xs text-muted-foreground')}>
          <DirectionalUsage
            inputTokens={run.inputTokens}
            outputTokens={run.outputTokens}
            variant="table"
            omitWhenUnknown={false}
          />
        </td>
      )
    case 'cost':
      return (
        <td
          data-column-id={column.id}
          className={cn(TD_BASE, 'text-right font-mono text-xs text-muted-foreground tabular-nums')}
        >
          {cost || <Dash />}
        </td>
      )
    case 'started':
      return (
        <td data-column-id={column.id} className={cn(TD_BASE, 'text-right text-xs text-soft-foreground tabular-nums')}>
          {shortAge(run.startedAt ?? run.createdAt, now)}
        </td>
      )
    case 'cpu':
    case 'memory':
      return null
  }
}

function FoldedTd({ column }: { column: TaskColumnId }) {
  return (
    <td
      role="presentation"
      aria-hidden="true"
      data-column-id={column}
      data-folded="true"
      className={cn(TD_BASE, 'px-0 first:pl-0 last:pr-0')}
    />
  )
}

/**
 * The Task cell: the title as a real link, with the mockup's hover pencil (`tasks-home.html`
 * `.task-title .pencil`) flipping it into the shared inline-rename input. Same machine as the
 * run header's title — one edit, one PATCH. The quick-list's rows stay read-only on purpose:
 * at 13px-in-a-260px-sidebar there is no room for an input worth typing into.
 */
function TitleCell({
  run,
  to,
  onRename,
}: {
  run: RunRecord
  to: string
  onRename: (id: string, title: string) => void
}) {
  const title = runTitle(run)
  const editor = useTitleEditor(title, (next) => onRename(run.id, next))
  // Read/unread (#unread-done-items, "Option B"): promote an unread done item (bright + semibold)
  // and dim a read one, matching the sidebar row exactly so the two surfaces read as one grammar.
  const unread = isUnread(run)
  const readDone = isReadDoneItem(run)

  if (editor.editing) {
    return <TitleEditInput editor={editor} className="text-[13px] font-medium" />
  }

  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Link
        to={to}
        title={title}
        className={cn(
          'min-w-0 truncate text-[13px]',
          unread ? 'font-semibold text-foreground' : readDone ? 'font-medium text-muted-foreground' : 'font-medium'
        )}
      >
        {title}
      </Link>
      {/* The unread marker — same trailing violet dot as the sidebar row. */}
      {unread ? (
        <StatusDot
          tone="violet"
          role="img"
          aria-label="unread"
          title="Unread — not opened since it finished"
          className="shrink-0"
        />
      ) : null}
      <button
        type="button"
        data-slot="row-rename"
        aria-label="Rename task"
        onClick={editor.begin}
        className="shrink-0 rounded-sm p-0.5 text-soft-foreground opacity-0 transition-opacity group-hover/row:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <PencilIcon className="size-3" aria-hidden="true" />
      </button>
    </span>
  )
}

/**
 * The live CPU/Mem pair, read from the global usage stream (`useRunUsage`, never `run.usage` —
 * the REST snapshot goes stale between refetches; the stream ticks every ~2s). Selected per run,
 * so a tick that says nothing about this run re-renders nothing.
 */
function UsageTds({
  run,
  cpuExpanded,
  memoryExpanded,
}: {
  run: RunRecord
  cpuExpanded: boolean
  memoryExpanded: boolean
}) {
  const sample = useRunUsage(run.id)
  const cells = usageCells(run, sample)
  return (
    <>
      {cpuExpanded ? <UsageTd column="cpu" cell={cells.cpu} /> : <FoldedTd column="cpu" />}
      {memoryExpanded ? <UsageTd column="memory" cell={cells.mem} /> : <FoldedTd column="memory" />}
    </>
  )
}

function UsageTd({ column, cell }: { column: 'cpu' | 'memory'; cell: UsageCell }) {
  return (
    <td
      data-usage={column === 'memory' ? 'mem' : column}
      data-column-id={column}
      data-usage-kind={cell.kind}
      title={cell.title}
      className={cn(
        TD_BASE,
        'text-right font-mono tabular-nums',
        cell.kind === 'live' && 'bg-violet/5 text-xs font-medium text-foreground',
        cell.kind === 'peak' && 'text-[11.5px] text-soft-foreground',
        cell.kind === 'none' && 'text-xs text-soft-foreground'
      )}
    >
      {cell.text || '—'}
    </td>
  )
}

/** One run, one card — the `<md` framing of the same row. */
function TaskCard({
  run,
  queuePosition,
  now,
  showTokens,
  showCost,
  selected,
  onToggleSelected,
}: {
  run: RunRecord
  queuePosition: number | null
  now: number
  showTokens: boolean
  showCost: boolean
  selected: boolean
  onToggleSelected: () => void
}) {
  const navigate = useNavigate()
  const attention = deriveAttention(run)
  const scheduled = scheduledResume(run)
  const to = `/tasks/${run.id}`
  const reference = taskReference(run)
  // Read/unread (#unread-done-items) — the same promote-unread / dim-read treatment as the row.
  const unread = isUnread(run)
  const readDone = isReadDoneItem(run)
  const cost = formatCost(run.costUsd)
  const hasDirectionalUsage = run.inputTokens !== undefined || run.outputTokens !== undefined

  return (
    <div
      data-slot="task-card"
      data-run-id={run.id}
      data-selected={selected || undefined}
      onClick={(event) => {
        // `input` joins the exemption list now that a card carries a tick box: without it the
        // first tap on the box would select the row AND navigate away from the list it belongs to.
        if ((event.target as Element).closest('a, button, input')) return
        navigate(to)
      }}
      className={cn(
        'cursor-pointer rounded-lg border border-border bg-card px-3.5 py-3 shadow-xs',
        selected && 'border-violet/40 bg-violet/5',
      )}
    >
      <div className="flex items-start gap-2.5">
        <SelectionCheckbox
          state={selected ? 'all' : 'none'}
          label={`Select ${runTitle(run)}`}
          onToggle={onToggleSelected}
          className="mt-1"
        />
        <Pill dot={attention.tone} pulse={attention.pulse} className="mt-px shrink-0" title={scheduled?.title}>
          {attention.label}
          {scheduled ? <span className="tabular-nums">{scheduled.label}</span> : null}
        </Pill>
        <Link
          to={to}
          className={cn(
            'min-w-0 flex-1 text-[13.5px] leading-[1.35]',
            unread ? 'font-semibold text-foreground' : readDone ? 'font-medium text-muted-foreground' : 'font-medium'
          )}
        >
          {runTitle(run)}
        </Link>
        {/* The unread marker — trailing violet dot, as on the desktop row. */}
        {unread ? (
          <StatusDot
            tone="violet"
            role="img"
            aria-label="unread"
            title="Unread — not opened since it finished"
            className="mt-1.5 shrink-0"
          />
        ) : null}
        <span className="mt-0.5 shrink-0 text-[11.5px] text-soft-foreground tabular-nums">
          {shortAge(run.finishedAt ?? run.createdAt, now)}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 font-mono text-[11.5px] font-medium text-muted-foreground tabular-nums">
        <span>{workflowLabel(run)}</span>
        {queuePosition !== null ? (
          <>
            <Sep />
            <span data-slot="queue-note">#{queuePosition} in queue</span>
          </>
        ) : (
          <>
            {run.branch ? (
              <>
                <Sep />
                <span>{run.branch}</span>
              </>
            ) : null}
            {/* Branch · ±diff · IN/OUT · cost — the compact card's meta order. */}
            {run.diffStat ? (
              <>
                <Sep />
                <DiffStatLabel stat={run.diffStat} className="text-[11.5px]" />
              </>
            ) : null}
            {showTokens && hasDirectionalUsage ? (
              <>
                <Sep />
                <DirectionalUsage inputTokens={run.inputTokens} outputTokens={run.outputTokens} />
              </>
            ) : null}
            {showCost && cost ? (
              <>
                <Sep />
                <span>{cost}</span>
              </>
            ) : null}
          </>
        )}
        {reference ? (
          <TaskReferenceChip run={run} reference={reference} className="h-5" />
        ) : null}
      </div>
    </div>
  )
}

/** An honest em dash: this cell has nothing true to show. */
function Dash() {
  return <span className="text-xs text-soft-foreground">—</span>
}

function Sep() {
  return (
    <span className="text-soft-foreground" aria-hidden="true">
      ·
    </span>
  )
}

function BranchChip({ branch }: { branch: string }) {
  return (
    <span className="rounded-[6px] bg-muted px-1.5 py-0.5 font-mono text-[11.5px] font-medium text-muted-foreground">
      {branch}
    </span>
  )
}

/** One row's half of a bulk edit. The switch is exhaustive over `BulkActionId`, so a fifth action
 *  is a compile error here rather than a button that quietly does nothing. */
function bulkRequest(action: BulkActionId, id: string): Promise<unknown> {
  switch (action) {
    case 'archive':
      return archiveRun(id, true)
    case 'restore':
      return archiveRun(id, false)
    case 'read':
      return markRunSeen(id)
    case 'unread':
      return markRunUnseen(id)
  }
}

/** A rejected fan-out request, as a sentence. `allSettled` hands back `unknown`, and the client's
 *  rejections are `Error`s carrying the server's one-line reason. */
function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/**
 * The overview wired to live data: `useRuns()` (kept fresh by the global SSE stream), the shared
 * Active/Archived context (the sidebar's tabs and these are one state), and the archive-finished
 * mutation. The invalidate on success is the authoritative half of the doctrine — the stream will
 * likely have patched each archived run already, but the endpoint's answer is the truth.
 */
export function TasksOverviewRoute() {
  const runs = useRuns()
  const health = useHealth()
  const metricVisibility = usageMetricVisibility(health.data)
  const [view, setView] = useListView()
  const queryClient = useQueryClient()
  const archive = useMutation({
    mutationFn: archiveFinished,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
  })
  // "Mark all read" (#unread-done-items): one call stamps every unread finished run; the
  // invalidate is the authoritative half — each stamped run also rides the `run` SSE.
  const markAllRead = useMutation({
    mutationFn: markAllRunsSeen,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  // The table's inline rename — `usePatchRun` is per-run, so the any-row variant carries the id
  // in its variables. Same endpoint, same invalidation, same danger toast as the run header.
  const rename = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => patchRun(id, { title }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  // The multi-edit fan-out. There is no batch endpoint and this run does not add one: every
  // action already has a per-run route, the server is on loopback, and a selection is tens of
  // rows rather than thousands. `allSettled`, not `all`, is the whole point — one refused write
  // must not cancel the rest, and the receipt has to be able to say "3 of 5".
  const bulk = useMutation({
    mutationFn: async ({ action, runs }: { action: BulkActionId; runs: readonly RunRecord[] }) => {
      const results = await Promise.allSettled(runs.map((run) => bulkRequest(action, run.id)))
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [errorMessage(result.reason)] : [],
      )
      return { total: runs.length, failures }
    },
    onSuccess: ({ total, failures }, { action }) => {
      toast(bulkResultMessage(action, total, failures), failures.length > 0 ? { tone: 'danger' } : undefined)
    },
    // Reached only if the fan-out itself threw, which `allSettled` makes unlikely — but a toast
    // beats a silent no-op if it ever does.
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
    // Always, both halves: the stream has probably patched each run already, but the endpoint's
    // answer is the truth — and after a partial failure the cache is the only place that still
    // believes every row changed.
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
  })
  const now = useNow(30_000)
  const taskTableColumns = useTaskTableColumns()
  // Chip statuses are hydrated HERE rather than inside `TasksOverview`, which is a pure
  // presentational component rendered directly (and without a query client) by its tests. The
  // provider wraps it instead, so the chips deep in the table and the cards read their status
  // from context and nothing in between has to relay it.
  const projectId = useReferenceProjectId()
  const referenceRequests = React.useMemo(
    () =>
      // `taskReference`, singular: this table paints exactly one chip per row (the strongest
      // reference), so asking about the others would be a request for something never shown.
      projectId === undefined
        ? []
        : (runs.data ?? []).flatMap((run) => {
            const reference = taskReference(run)
            return reference ? [{ projectId, kind: reference.kind, number: reference.number }] : []
          }),
    [runs.data, projectId],
  )

  return (
    <ReferenceStatusProvider projectId={projectId} requests={referenceRequests}>
      <TasksOverview
        runs={runs.data}
        view={view}
        onViewChange={setView}
        onArchiveFinished={() => archive.mutate()}
        onMarkAllRead={() => markAllRead.mutate()}
        onRename={(id, title) => rename.mutate({ id, title })}
        onBulkAction={(action, selected) => bulk.mutate({ action, runs: selected })}
        bulkPending={bulk.isPending}
        now={now}
        showTokens={metricVisibility.tokens}
        showCost={metricVisibility.cost}
        expandedColumns={taskTableColumns.expandedColumns}
        onToggleColumn={taskTableColumns.toggleColumn}
        columnsPending={taskTableColumns.isPending}
      />
    </ReferenceStatusProvider>
  )
}
