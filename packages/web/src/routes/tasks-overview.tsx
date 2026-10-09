import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArchiveIcon,
  CheckCheckIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
  Clock3Icon,
  CoinsIcon,
  CpuIcon,
  DollarSignIcon,
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

import { archiveFinished, markAllRunsSeen, patchRun } from '@/api/client'
import { useRunUsage } from '@/api/global-events'
import { queryKeys, useHealth, usePinRun, useReferenceProjectId, useRuns, writePatchedRunToCaches } from '@/api/queries'
import type { RunRecord } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { DiffStatLabel } from '@/components/diff-stat'
import { DirectionalUsage } from '@/components/directional-usage'
import { TitleEditInput, useTitleEditor } from '@/components/editable-title'
import { FacetFilter } from '@/components/facet-filter'
import { useListView } from '@/components/list-view'
import { Pill } from '@/components/pill'
import { PinToggle } from '@/components/pin-toggle'
import { TaskReferenceChip } from '@/components/reference-conflict-action'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { Segmented } from '@/components/segmented'
import { StatusDot } from '@/components/status-dot'
import { SubtaskToggle } from '@/components/subtask-toggle'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { UnreadMarker } from '@/components/unread-marker'
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
import {
  activeTaskFacetCount,
  automationIndex,
  distinctValues,
  filterTaskTable,
  NO_TASK_FILTERS,
  originCounts,
  taskFacetCounts,
  type TaskFacetId,
  type TaskTableFilters,
} from '@/lib/task-filters'
import { listCounts, queuePositions, runTitle, sortRuns, type ListView } from '@/lib/task-groups'
import { TASK_ORIGIN_OPTIONS, useTaskOrigin, type TaskOrigin } from '@/lib/task-origin'
import { dispatchKindLabel, subtaskLabel, taskTreeRows } from '@/lib/task-tree'
import {
  compareGroups,
  filterRuns,
  finishedRunCount,
  formatCost,
  scheduledResume,
  taskReference,
  taskReferences,
  usageCells,
  workflowLabel,
  type UsageCell,
} from '@/lib/tasks-table'
import { usageMetricVisibility } from '@/lib/token-metrics'
import { useTaskTableColumns } from '@/lib/use-task-table-columns'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'
import { useAutomationsGate, useAutomationsQuery } from '@/routes/automations/use-automations'

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
  onTogglePin,
  now = Date.now(),
  showTokens = true,
  showCost = true,
  expandedColumns = normalizeExpandedColumns(undefined),
  onToggleColumn = () => undefined,
  columnsPending = false,
  origin = 'all',
  onOriginChange = () => undefined,
  automationNames,
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
  /** Pin/unpin one task (#935). Pinned rows sort to the top of the table — `sortRuns` does that
   *  for every surface at once — so the row's own control is also the only thing on this page
   *  that explains why one is up there. */
  onTogglePin?: (run: RunRecord, pinned: boolean) => void
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
  /** Who started the rows shown: a person, an automation, or either. The route passes the
   *  remembered choice (`useTaskOrigin`, Regular by default); a direct render shows everything. */
  origin?: TaskOrigin
  onOriginChange?: (origin: TaskOrigin) => void
  /** Automation id → name, for the Automation facet. An id it does not know (a deleted
   *  automation, or automations off) is shown as itself. */
  automationNames?: ReadonlyMap<string, string>
}) {
  const [query, setQuery] = React.useState('')
  // The subtask accordion (#1110): ids of the parents whose dispatched rows are unfolded.
  // Empty on arrival — collapsed is the default, and the chip on the parent row is the handle.
  // Session-local on purpose: "collapsed by default" is the contract, so a fresh visit folds
  // everything back.
  const [expandedSubtasks, setExpandedSubtasks] = React.useState<ReadonlySet<string>>(new Set())
  const toggleSubtasks = (id: string) =>
    setExpandedSubtasks((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  // The facets are session-local, like the search text; only the origin is remembered.
  const [filters, setFilters] = React.useState<TaskTableFilters>(NO_TASK_FILTERS)
  const all = React.useMemo(() => runs ?? [], [runs])
  const automations = React.useMemo(() => automationIndex(all), [all])
  // Origin and facets narrow BEFORE everything else, so the tab counts, the queue-free rows and
  // the compare strips all describe the same list the table shows.
  const narrowed = filterTaskTable(all, origin, filters, automations)
  const counts = listCounts(narrowed)
  const visible = sortRuns(filterRuns(narrowed, query), view)
  // A live search overrides the fold wholesale: `filterRuns` keeps a child whose parent also
  // matched NESTED under it, and a match the accordion then hid would read as a search miss.
  const searching = query.trim() !== ''
  // Dispatched children nest under the task that ordered them, in that task's own place in the
  // sort above (spec `.ai/specs/2026-09-10-dispatch.md`). One derivation, both layouts: the table
  // and the cards are the same rows at two widths, and a tree that disagreed between them would
  // be two trees — which is also why the accordion state feeds the derivation here rather than
  // either layout hiding rows on its own.
  const rows = taskTreeRows(visible, (id) => searching || expandedSubtasks.has(id))
  // Positions come from the full list, never the filtered one: a search must not renumber the
  // queue the engine is actually going to drain.
  const positions = queuePositions(all)
  const strips = compareGroups(filterRuns(narrowed, query), view)
  const finished = finishedRunCount(all)
  const columns = taskColumnsForCapabilities({ tokens: showTokens, cost: showCost })
  const unread = unreadDoneCount(all)
  // The archived view withholds the pin, the same call `runActionFlags` makes for the thread
  // header (`pin: !run.archived`): `sortRuns` skips the pin comparator there and `bucketOf`
  // answers `Archived` before it ever reads `run.pinned`, so the button would be an action with
  // nowhere to show its result — and one that outlives the view, since un-archiving would then
  // drop the task at the top of the active list by a click that looked like it did nothing.
  const pinToggle = view === 'archived' ? undefined : onTogglePin

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
        <div className="relative w-60">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-soft-foreground"
            aria-hidden="true"
          />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search tasks…"
            aria-label="Search tasks"
            className="h-9 w-full rounded-md border border-input bg-card pr-3 pl-8 text-[13px] text-foreground outline-none placeholder:text-soft-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
        </div>
      </header>

      <div className="flex flex-1 flex-col p-3 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-5 md:pb-5">
        {/* No bar over the first-run hero: with nothing to narrow, filters are noise. */}
        {all.length > 0 ? (
          <TasksFilterBar
            runs={all}
            view={view}
            origin={origin}
            onOriginChange={onOriginChange}
            filters={filters}
            onFiltersChange={setFilters}
            automations={automations}
            automationNames={automationNames}
          />
        ) : null}
        {runs === undefined ? null : visible.length === 0 ? (
          <TasksEmptyState
            view={view}
            query={query}
            filtered={activeTaskFacetCount(filters) > 0}
            onClearFilters={() => setFilters(NO_TASK_FILTERS)}
            origin={origin}
            hiddenByOrigin={
              origin !== 'all' &&
              filterTaskTable(sortRuns(all, view), 'all', filters, automations).length > 0
            }
            onShowAll={() => onOriginChange('all')}
          />
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
                    {rows.map((node) => (
                      <TableRow
                        key={node.run.id}
                        run={node.run}
                        depth={node.depth}
                        childCount={node.childCount}
                        subtasksExpanded={searching || expandedSubtasks.has(node.run.id)}
                        onToggleSubtasks={toggleSubtasks}
                        queuePosition={
                          node.run.status === 'queued' ? (positions.get(node.run.id) ?? null) : null
                        }
                        onRename={onRename}
                        onTogglePin={pinToggle}
                        now={now}
                        columns={columns}
                        expandedColumns={expandedColumns}
                      />
                    ))}
                  </tbody>
                </table>
              </TooltipProvider>
            </div>

            {/* <md: the same runs as stacked cards. */}
            <div data-slot="task-cards" className="flex flex-col gap-2.5 md:hidden">
              {rows.map((node) => (
                <TaskCard
                  key={node.run.id}
                  run={node.run}
                  depth={node.depth}
                  childCount={node.childCount}
                  subtasksExpanded={searching || expandedSubtasks.has(node.run.id)}
                  onToggleSubtasks={toggleSubtasks}
                  queuePosition={
                    node.run.status === 'queued' ? (positions.get(node.run.id) ?? null) : null
                  }
                  now={now}
                  showTokens={showTokens}
                  showCost={showCost}
                  onTogglePin={pinToggle}
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
function TasksEmptyState({
  view,
  query,
  filtered = false,
  onClearFilters = () => undefined,
  origin = 'all',
  hiddenByOrigin = false,
  onShowAll = () => undefined,
}: {
  view: ListView
  query: string
  /** A status/workflow/automation facet is narrowing the list. */
  filtered?: boolean
  onClearFilters?: () => void
  origin?: TaskOrigin
  /** The origin split is the only reason this view is empty: switching to All would show rows. */
  hiddenByOrigin?: boolean
  onShowAll?: () => void
}) {
  const needle = query.trim()
  const kind = needle
    ? 'search-miss'
    : filtered
      ? 'filtered'
      : hiddenByOrigin
        ? 'origin-hidden'
        : view === 'archived'
          ? 'archive'
          : 'no-tasks'
  return (
    <div data-slot="tasks-empty" data-empty-kind={kind} className="flex flex-1 flex-col">
      {kind === 'filtered' ? (
        <CenteredState
          heading="h2"
          icon={<SearchXIcon />}
          tone="neutral"
          title="No tasks match these filters"
          actions={
            <Button type="button" variant="outline" onClick={onClearFilters}>
              Clear filters
            </Button>
          }
        />
      ) : kind === 'origin-hidden' ? (
        <CenteredState
          heading="h2"
          icon={<WorkflowIcon />}
          tone="neutral"
          title={origin === 'regular' ? 'No regular tasks here' : 'No automation tasks here'}
          subtitle={
            origin === 'regular'
              ? 'Tasks started by automations are hidden.'
              : 'Only tasks started by automations are shown.'
          }
          actions={
            <Button type="button" variant="outline" onClick={onShowAll}>
              Show all tasks
            </Button>
          }
        />
      ) : kind === 'search-miss' ? (
        <CenteredState
          heading="h2"
          icon={<SearchXIcon />}
          tone="neutral"
          title="No matching tasks"
          subtitle={`No tasks match “${needle}”.`}
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

/**
 * The filter row over the table: the remembered Regular | Automations | All split, then the
 * facets — the same pill grammar as the global page (`components/facet-filter.tsx`), with the
 * facets this page can actually answer. Options and counts come from the runs in the CURRENT
 * view (Active or Archived), each counted as the other facets narrow it.
 *
 * The Automation facet appears only while automation tasks are on screen: under Regular it
 * could only ever empty the table.
 */
function TasksFilterBar({
  runs,
  view,
  origin,
  onOriginChange,
  filters,
  onFiltersChange,
  automations,
  automationNames,
}: {
  runs: readonly RunRecord[]
  view: ListView
  origin: TaskOrigin
  onOriginChange: (origin: TaskOrigin) => void
  filters: TaskTableFilters
  onFiltersChange: (update: (current: TaskTableFilters) => TaskTableFilters) => void
  automations: ReadonlyMap<string, string | undefined>
  automationNames?: ReadonlyMap<string, string>
}) {
  const inView = React.useMemo(
    () => runs.filter((run) => (view === 'archived' ? run.archived : !run.archived)),
    [runs, view],
  )
  const perOrigin = originCounts(inView, filters, automations)
  const countsOf = (facet: TaskFacetId) => taskFacetCounts(inView, origin, filters, automations, facet)
  const statusCounts = countsOf('statuses')
  const workflowCounts = countsOf('workflows')
  const automationCounts = countsOf('automations')
  const automationIds = distinctValues(inView.map((run) => automations.get(run.id)))
  const toggle = (facet: TaskFacetId, value: string) =>
    onFiltersChange((current) => ({
      ...current,
      [facet]: current[facet].includes(value)
        ? current[facet].filter((picked) => picked !== value)
        : [...current[facet], value],
    }))
  const clear = (facet: TaskFacetId) => onFiltersChange((current) => ({ ...current, [facet]: [] }))
  const active = activeTaskFacetCount(filters)

  return (
    <div data-slot="tasks-filters" className="mb-3 flex flex-wrap items-center gap-1.5">
      <Segmented
        slot="task-origin"
        label="Show tasks started by"
        value={origin}
        options={TASK_ORIGIN_OPTIONS.map((option) => ({ ...option, count: perOrigin[option.value] }))}
        onChange={onOriginChange}
      />
      <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
      <FacetFilter
        slot="status"
        label="Status"
        selected={filters.statuses}
        onToggle={(value) => toggle('statuses', value)}
        onClear={() => clear('statuses')}
        options={distinctValues(inView.map((run) => run.status)).map((status) => ({
          value: status,
          label: status,
          count: statusCounts.get(status) ?? 0,
        }))}
        emptyLabel="No tasks to filter"
      />
      <FacetFilter
        slot="workflow"
        label="Workflow"
        selected={filters.workflows}
        onToggle={(value) => toggle('workflows', value)}
        onClear={() => clear('workflows')}
        options={distinctValues(inView.map((run) => workflowLabel(run))).map((workflow) => ({
          value: workflow,
          label: workflow,
          count: workflowCounts.get(workflow) ?? 0,
        }))}
        emptyLabel="No tasks to filter"
      />
      {origin !== 'regular' && automationIds.length > 0 ? (
        <FacetFilter
          slot="automation"
          label="Automation"
          selected={filters.automations}
          onToggle={(value) => toggle('automations', value)}
          onClear={() => clear('automations')}
          options={automationIds.map((id) => ({
            value: id,
            label: automationNames?.get(id) ?? id,
            count: automationCounts.get(id) ?? 0,
          }))}
          emptyLabel="No automation tasks"
        />
      ) : null}
      {active > 0 ? (
        <button
          type="button"
          data-action="clear-filters"
          onClick={() => onFiltersChange(() => NO_TASK_FILTERS)}
          className="inline-flex h-7 items-center gap-1 rounded-full px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <XIcon className="size-3" aria-hidden="true" />
          Clear ({active})
        </button>
      ) : null}
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
  depth,
  childCount,
  subtasksExpanded,
  onToggleSubtasks,
  queuePosition,
  onRename,
  onTogglePin,
  now,
  columns,
  expandedColumns,
}: {
  run: RunRecord
  /** Nesting level under the task that dispatched this one; 0 for a top-level row. */
  depth: number
  /** How many tasks THIS one dispatched — the row's "N subtasks" note. */
  childCount: number
  /** Whether this row's dispatched children are unfolded beneath it (#1110). */
  subtasksExpanded: boolean
  onToggleSubtasks: (id: string) => void
  queuePosition: number | null
  onRename: (id: string, title: string) => void
  onTogglePin?: (run: RunRecord, pinned: boolean) => void
  now: number
  columns: readonly TaskColumnDefinition[]
  expandedColumns: NormalizedExpandedColumns
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
      // The nesting is carried on the ROW, not only in the Task cell's padding: a test (and a
      // stylesheet) should be able to ask how deep a row sits without parsing an indent.
      data-depth={depth}
      onClick={(event) => {
        if ((event.target as Element).closest('a, button, input')) return
        navigate(to)
      }}
      className="group/row cursor-pointer hover:bg-muted"
    >
      {columns.map((column) => {
        if (column.id === 'memory') return null
        if (column.id === 'cpu') {
          const cpuExpanded = isColumnExpanded('cpu', expandedColumns)
          const memoryExpanded = isColumnExpanded('memory', expandedColumns)
          // The queue note borrows the CPU/Mem pair, but only while there is room to borrow: the
          // table is auto-layout, so `#N in queue` under `whitespace-nowrap` would push both folded
          // columns back open (#821). Fold beats the note; one expanded column is enough to carry it.
          return queuePosition !== null && (cpuExpanded || memoryExpanded) ? (
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
              cpuExpanded={cpuExpanded}
              memoryExpanded={memoryExpanded}
            />
          )
        }
        return (
          <TaskTableCell
            key={column.id}
            column={column}
            expanded={isColumnExpanded(column.id, expandedColumns)}
            run={run}
            depth={depth}
            childCount={childCount}
            subtasksExpanded={subtasksExpanded}
            onToggleSubtasks={onToggleSubtasks}
            attention={attention}
            scheduled={scheduled}
            reference={reference}
            cost={cost}
            to={to}
            onRename={onRename}
            onTogglePin={onTogglePin}
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
  depth,
  childCount,
  subtasksExpanded,
  onToggleSubtasks,
  attention,
  scheduled,
  reference,
  cost,
  to,
  onRename,
  onTogglePin,
  now,
}: {
  column: TaskColumnDefinition
  expanded: boolean
  run: RunRecord
  depth: number
  childCount: number
  subtasksExpanded: boolean
  onToggleSubtasks: (id: string) => void
  attention: ReturnType<typeof deriveAttention>
  scheduled: ReturnType<typeof scheduledResume>
  reference: ReturnType<typeof taskReference>
  cost: string
  to: string
  onRename: (id: string, title: string) => void
  onTogglePin?: (run: RunRecord, pinned: boolean) => void
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
          <TitleCell
            run={run}
            depth={depth}
            childCount={childCount}
            subtasksExpanded={subtasksExpanded}
            onToggleSubtasks={onToggleSubtasks}
            to={to}
            onRename={onRename}
            onTogglePin={onTogglePin}
          />
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
  depth,
  childCount,
  subtasksExpanded,
  onToggleSubtasks,
  to,
  onRename,
  onTogglePin,
}: {
  run: RunRecord
  depth: number
  childCount: number
  subtasksExpanded: boolean
  onToggleSubtasks: (id: string) => void
  to: string
  onRename: (id: string, title: string) => void
  onTogglePin?: (run: RunRecord, pinned: boolean) => void
}) {
  const title = runTitle(run)
  const editor = useTitleEditor(title, (next) => onRename(run.id, next))
  // Read/unread (#unread-done-items): promote an unread done item (bright + semibold)
  // and dim a read one, matching the sidebar row exactly so the two surfaces read as one grammar.
  const unread = isUnread(run)
  const readDone = isReadDoneItem(run)

  const subtasks = subtaskLabel(childCount)
  // The indent, as inline style rather than a class: depth is unbounded (a task may dispatch a
  // task that dispatches a task), and Tailwind cannot generate a class per level. 14px a level is
  // the sidebar's own nesting step, so the two lists read as one grammar.
  const indent = depth > 0 ? { paddingLeft: `${depth * 14}px` } : undefined

  if (editor.editing) {
    return (
      <span className="flex min-w-0 items-center" style={indent}>
        <TitleEditInput editor={editor} className="text-[13px] font-medium" />
      </span>
    )
  }

  return (
    <span className="flex min-w-0 items-center gap-1.5" style={indent}>
      {/* The one mark that says this row was ORDERED by the row above it rather than by a
          person. Padding alone reads as an accident at 13px; the tick reads as a branch. */}
      {depth > 0 ? (
        <span
          aria-hidden="true"
          data-slot="subtask-tick"
          className="shrink-0 font-mono text-[11px] leading-none text-soft-foreground"
        >
          &#9492;
        </span>
      ) : null}
      <Link
        to={to}
        title={title}
        className={cn(
          'min-w-0 truncate text-[13px]',
          unread ? 'font-semibold text-foreground' : readDone ? 'font-medium text-muted-foreground' : 'font-medium'
        )}
      >
        {title}
        {unread ? <UnreadMarker /> : null}
      </Link>
      {/* What a DISPATCHED row is for — `review` or `implement` — so a tester can tell a child
          from a task a person typed without opening it. Null on every root. */}
      {dispatchKindLabel(run) ? (
        <span
          data-slot="dispatch-kind"
          className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10.5px] font-medium text-muted-foreground"
        >
          {dispatchKindLabel(run)}
        </span>
      ) : null}
      {/* What this task dispatched, counted rather than listed — and, since #1110, the accordion
          handle for the rows the count stands for: collapsed by default, this click unfolds them. */}
      {subtasks ? (
        <SubtaskToggle
          label={subtasks}
          expanded={subtasksExpanded}
          onToggle={() => onToggleSubtasks(run.id)}
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
      {/* The pin (#935), beside the pencil and revealed the same way — except when the row IS
          pinned, where it stays lit: this table has no `Pinned` header, so the filled pin is the
          whole explanation for why the row sorted to the top.

          `no-hover:` covers the device this table still reaches without a pointer: it is hidden
          below `md`, where the cards take over, but a tablet in landscape is ≥md and cannot
          hover, so without it the pin would be invisible AND unreachable there. */}
      {onTogglePin ? (
        <PinToggle
          pinned={Boolean(run.pinned)}
          onToggle={(pinned) => onTogglePin(run, pinned)}
          className="size-[19px] opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 no-hover:opacity-100 data-[pinned=true]:opacity-100"
        />
      ) : null}
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
  depth,
  childCount,
  subtasksExpanded,
  onToggleSubtasks,
  queuePosition,
  now,
  showTokens,
  showCost,
  onTogglePin,
}: {
  run: RunRecord
  /** Nesting level under the task that dispatched this one; 0 for a top-level card. */
  depth: number
  childCount: number
  /** Whether this card's dispatched children are unfolded beneath it (#1110). */
  subtasksExpanded: boolean
  onToggleSubtasks: (id: string) => void
  queuePosition: number | null
  now: number
  showTokens: boolean
  showCost: boolean
  onTogglePin?: (run: RunRecord, pinned: boolean) => void
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
  const subtasks = subtaskLabel(childCount)
  const hasDirectionalUsage = run.inputTokens !== undefined || run.outputTokens !== undefined

  return (
    <div
      data-slot="task-card"
      data-run-id={run.id}
      data-depth={depth}
      // The card stack's nesting: the child card is inset from the left edge and keeps the whole
      // card width it had, rather than being squeezed — at phone width a shrinking card would
      // cost the title the room the indent was supposed to explain.
      style={depth > 0 ? { marginLeft: `${depth * 14}px` } : undefined}
      onClick={(event) => {
        // `button` as well as `a` since the card grew the pin (#935): a control inside the card
        // owns its own click, exactly as the desktop row has always had it.
        if ((event.target as Element).closest('a, button')) return
        navigate(to)
      }}
      className="cursor-pointer rounded-lg border border-border bg-card px-3.5 py-3 shadow-xs"
    >
      <div className="flex items-start gap-2.5">
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
          {unread ? <UnreadMarker /> : null}
        </Link>
        {/* Same kind chip as the table's Task cell — what this dispatched card is for. */}
        {dispatchKindLabel(run) ? (
          <span
            data-slot="dispatch-kind"
            className="mt-px shrink-0 rounded-full bg-muted px-1.5 py-px text-[10.5px] font-medium text-muted-foreground"
          >
            {dispatchKindLabel(run)}
          </span>
        ) : null}
        {/* Same handle as the table's Task cell (#1110) — the dispatched children are the cards
            this unfolds below. The card's own click already steps around `a, button`. */}
        {subtasks ? (
          <SubtaskToggle
            label={subtasks}
            expanded={subtasksExpanded}
            onToggle={() => onToggleSubtasks(run.id)}
            className="mt-px"
          />
        ) : null}
        <span className="mt-0.5 shrink-0 text-[11.5px] text-soft-foreground tabular-nums">
          {shortAge(run.finishedAt ?? run.createdAt, now)}
        </span>
        {/* Always visible here, not hover-revealed: a card has no hover to speak of on the
            device it exists for, and it is the only place a pin can be set or seen on mobile. */}
        {onTogglePin ? (
          <PinToggle
            pinned={Boolean(run.pinned)}
            onToggle={(pinned) => onTogglePin(run, pinned)}
            className="-mr-1 mt-px"
          />
        ) : null}
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
    onSuccess: (updated) => {
      writePatchedRunToCaches(queryClient, updated)
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  // Pinning (#935) — this page is the scoped project's own table, so no explicit project id.
  const pin = usePinRun()
  const now = useNow(30_000)
  const taskTableColumns = useTaskTableColumns()
  const [origin, setOrigin] = useTaskOrigin()
  // Names for the Automation facet. Only asked for while automations are on AND automation rows
  // are on screen — a project that never ran one pays no request for a facet it will not show.
  const gate = useAutomationsGate()
  const hasAutomationRuns = React.useMemo(
    () => (runs.data ?? []).some((run) => run.automation ?? run.automationTrigger ?? run.automationTracker),
    [runs.data],
  )
  const automationsQuery = useAutomationsQuery(gate.known && !gate.off && hasAutomationRuns && origin !== 'regular')
  const automationNames = React.useMemo(
    () => new Map((automationsQuery.data?.automations ?? []).map((entry) => [entry.id, entry.name])),
    [automationsQuery.data],
  )
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
        : (runs.data ?? []).flatMap((run) =>
            taskReferences(run).map((reference) => ({
              projectId,
              kind: reference.kind,
              number: reference.number,
            })),
          ),
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
        onTogglePin={(run, pinned) =>
          pin.mutate(
            { id: run.id, pinned },
            { onError: (error: Error) => toast(error.message, { tone: 'danger' }) },
          )
        }
        now={now}
        showTokens={metricVisibility.tokens}
        showCost={metricVisibility.cost}
        expandedColumns={taskTableColumns.expandedColumns}
        onToggleColumn={taskTableColumns.toggleColumn}
        columnsPending={taskTableColumns.isPending}
        origin={origin}
        onOriginChange={setOrigin}
        automationNames={automationNames}
      />
    </ReferenceStatusProvider>
  )
}
