import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArchiveIcon,
  CheckCheckIcon,
  EllipsisIcon,
  ListChecksIcon,
  PencilIcon,
  PlusIcon,
  ScaleIcon,
  SearchXIcon,
  SlidersHorizontalIcon,
} from 'lucide-react'
import * as React from 'react'
import { Link, useNavigate } from '@/lib/project-router'

import { archiveFinished, markAllRunsSeen, patchRun } from '@/api/client'
import { useRunUsage } from '@/api/global-events'
import { queryKeys, useHealth, usePinRun, useReferenceProjectId, useRuns, writePatchedRunToCaches } from '@/api/queries'
import type { RunRecord } from '@open-mercato/cezar-api-client'
import { DiffStatLabel } from '@/components/diff-stat'
import { DirectionalUsage } from '@/components/directional-usage'
import { TitleEditInput, useTitleEditor } from '@/components/editable-title'
import {
  LIST_CELL_CLASS,
  LIST_HEAD_CLASS,
  ListEmpty,
  ListFrame,
  ListSearch,
  ListViewTabs,
  TaskStatusBadge,
  useListView,
} from '@/components/list-view'
import { Page, PageBody, PageHeader, PageToolbar } from '@/components/page'
import { PinToggle } from '@/components/pin-toggle'
import { TaskReferenceChip } from '@/components/reference-conflict-action'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { StatusDot } from '@/components/status-dot'
import { SubtaskToggle } from '@/components/subtask-toggle'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/components/ui/toaster'
import { TooltipProvider } from '@/components/ui/tooltip'
import { deriveAttention } from '@/lib/attention'
import { shortAge } from '@/lib/format'
import { isReadDoneItem, isUnread, unreadDoneCount } from '@/lib/read-state'
import {
  isColumnExpanded,
  normalizeExpandedColumns,
  taskColumnsForCapabilities,
  type NormalizedExpandedColumns,
  type TaskColumnId,
} from '@/lib/task-columns'
import { listCounts, queuePositions, runTitle, sortRuns, type ListView } from '@/lib/task-groups'
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

/**
 * What the list shows before anyone has chosen (cockpit concept 2): status, the task with its
 * workflow · branch · reference on a quiet second line, the change size and the age. Spend and
 * live usage are one click away in the Display menu. A stored choice always wins; this only
 * answers for ids the workspace state has never written.
 */
const CALM_DEFAULTS: Partial<Record<TaskColumnId, boolean>> = {
  workflow: true,
  branch: true,
  reference: true,
  diff: true,
  started: true,
  tokens: false,
  cost: false,
  cpu: false,
  memory: false,
}

/** Shown on the task's second line rather than as columns of their own. */
const DETAIL_IDS: readonly TaskColumnId[] = ['workflow', 'branch', 'reference']
/** Real, optional columns — in table order. */
const METRIC_IDS: readonly TaskColumnId[] = ['diff', 'tokens', 'cost', 'cpu', 'memory', 'started']

const DISPLAY_LABELS: Partial<Record<TaskColumnId, string>> = {
  workflow: 'Workflow',
  branch: 'Branch',
  reference: 'Issue or pull request',
  diff: 'Changes',
  tokens: 'Tokens in / out',
  cost: 'Cost',
  cpu: 'CPU',
  memory: 'Memory',
  started: 'Started',
}

const HEAD_LABELS: Partial<Record<TaskColumnId, string>> = {
  diff: 'Changes',
  tokens: 'Tokens in / out',
  cost: 'Cost',
  cpu: 'CPU',
  memory: 'Memory',
  started: 'Started',
}

type Shown = (id: TaskColumnId) => boolean

/**
 * The Tasks overview — a project's home (`/`). The Active/Archived switch is the *same state*
 * as the sidebar quick-list's.
 *
 * Presentational: sorting, search, queue numbers, usage-cell decisions and the compare tiles
 * all come from the pure modules (`lib/task-groups.ts`, `lib/tasks-table.ts`,
 * `lib/attention.ts`). What lives here is markup, the router, and the local search text.
 *
 * Below `md` the table becomes a stacked list plus a New-task FAB — same rows, same order.
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
}: {
  /** Undefined while `/api/runs` has not answered: the frame renders, the body is a skeleton —
   *  an empty state before we know there are no runs would be a lie. */
  runs: RunRecord[] | undefined
  view: ListView
  onViewChange: (view: ListView) => void
  onArchiveFinished: () => void
  /** "Mark all read" (#unread-done-items) — stamps every unread finished run. */
  onMarkAllRead: () => void
  /** Inline rename from the row — wired to `PATCH /api/runs/:id`. */
  onRename: (id: string, title: string) => void
  /** Pin/unpin one task (#935). Pinned rows sort to the top (`sortRuns`). */
  onTogglePin?: (run: RunRecord, pinned: boolean) => void
  /** Injected so the ages are not racing the clock in tests. */
  now?: number
  /** Presentation capability; defaults visible for older health responses and direct renders. */
  showTokens?: boolean
  showCost?: boolean
  /** Workspace-global display choices; absent ids use `CALM_DEFAULTS`. */
  expandedColumns?: NormalizedExpandedColumns
  onToggleColumn?: (id: TaskColumnId) => void
  /** Prevent a shallow write before the authoritative workspace state can preserve siblings. */
  columnsPending?: boolean
}) {
  const [query, setQuery] = React.useState('')
  // The subtask accordion (#1110): ids of the parents whose dispatched rows are unfolded.
  // Session-local on purpose: "collapsed by default" is the contract.
  const [expandedSubtasks, setExpandedSubtasks] = React.useState<ReadonlySet<string>>(new Set())
  const toggleSubtasks = (id: string) =>
    setExpandedSubtasks((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  const all = runs ?? []
  const counts = listCounts(all)
  const visible = sortRuns(filterRuns(all, query), view)
  // A live search overrides the fold wholesale: a match the accordion hid would read as a miss.
  const searching = query.trim() !== ''
  // Dispatched children nest under the task that ordered them. One derivation, both layouts.
  const rows = taskTreeRows(visible, (id) => searching || expandedSubtasks.has(id))
  // Positions come from the full list, never the filtered one: a search must not renumber the
  // queue the engine is actually going to drain.
  const positions = queuePositions(all)
  const strips = compareGroups(filterRuns(all, query), view)
  const finished = finishedRunCount(all)
  const columns = taskColumnsForCapabilities({ tokens: showTokens, cost: showCost })
  const available = new Set(columns.map((column) => column.id))
  const unread = unreadDoneCount(all)
  // The archived view withholds the pin: `sortRuns` skips the pin comparator there, so the
  // button would be an action with nowhere to show its result.
  const pinToggle = view === 'archived' ? undefined : onTogglePin

  const shown: Shown = (id) => available.has(id) && (expandedColumns[id] ?? CALM_DEFAULTS[id] ?? true)
  // The stored model toggles against the registry's own defaults, which are not the calm ones.
  // Where the two disagree about an id nobody has written yet, the first toggle only makes the
  // current look explicit and the second one flips it.
  const setShown = (id: TaskColumnId) => {
    const agrees = isColumnExpanded(id, expandedColumns) === shown(id)
    onToggleColumn(id)
    if (!agrees) onToggleColumn(id)
  }
  const metricColumns = METRIC_IDS.filter(shown)
  const canArchiveFinished = view === 'active' && finished > 0

  return (
    <Page data-route="tasks">
      <PageHeader
        title="Tasks"
        description={runs === undefined ? 'Everything agents are working on in this project.' : summaryOf(all)}
        actions={
          <>
            {/* No New-task button here: the sidebar's is the screen's one accent CTA. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label="List actions" data-slot="list-actions">
                  <EllipsisIcon aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-52">
                {/* Disabled rather than hidden when there is nothing to clear or sweep, so the
                    menu always says what it can do. */}
                <DropdownMenuItem data-slot="mark-all-read" disabled={unread === 0} onSelect={onMarkAllRead}>
                  <CheckCheckIcon aria-hidden="true" />
                  Mark all read
                  {unread > 0 ? <MenuCount>{unread}</MenuCount> : null}
                </DropdownMenuItem>
                <DropdownMenuItem
                  data-slot="archive-finished"
                  disabled={!canArchiveFinished}
                  onSelect={onArchiveFinished}
                >
                  <ArchiveIcon aria-hidden="true" />
                  Archive finished
                  {canArchiveFinished ? <MenuCount>{finished}</MenuCount> : null}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <PageToolbar>
        <ListViewTabs view={view} onChange={onViewChange} counts={counts} />
        <div className="flex-1" />
        <ListSearch value={query} onChange={setQuery} placeholder="Search tasks…" label="Search tasks" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" data-slot="display-menu" className="hidden md:inline-flex">
              <SlidersHorizontalIcon aria-hidden="true" />
              Display
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-56">
            <DropdownMenuLabel>Under the title</DropdownMenuLabel>
            {DETAIL_IDS.filter((id) => available.has(id)).map((id) => (
              <DisplayItem key={id} id={id} checked={shown(id)} disabled={columnsPending} onToggle={setShown} />
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Columns</DropdownMenuLabel>
            {METRIC_IDS.filter((id) => available.has(id)).map((id) => (
              <DisplayItem key={id} id={id} checked={shown(id)} disabled={columnsPending} onToggle={setShown} />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </PageToolbar>

      <PageBody className="flex flex-col gap-4 pb-[calc(96px+env(safe-area-inset-bottom))] md:pb-10">
        {/* Finished variant groups are a decision waiting on a person, so they sit above the list. */}
        {strips.length > 0 ? (
          <ListFrame className="divide-y divide-border">
            {strips.map((group) => (
              <div
                key={group.groupId}
                data-slot="compare-strip"
                data-group-id={group.groupId}
                className="flex flex-wrap items-center gap-3 px-4 py-3 md:px-5"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-violet/12 text-violet">
                  <ScaleIcon className="size-4" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{group.title}</p>
                  <p className="text-[13px] text-muted-foreground">
                    {group.count} variants finished — compare them and keep one.
                  </p>
                </div>
                <Button asChild variant="outline" size="sm">
                  <Link to={`/compare/${group.groupId}`}>Compare</Link>
                </Button>
              </div>
            ))}
          </ListFrame>
        ) : null}

        {runs === undefined ? (
          <ListSkeleton />
        ) : visible.length === 0 ? (
          <TasksEmptyState view={view} query={query} />
        ) : (
          <>
            {/* ≥md: the table. */}
            <ListFrame
              data-slot="tasks-table"
              // A container: the optional columns leave one by one as the TABLE runs out of room
              // (the open sidebar narrows it as much as a small window does), least-read first,
              // so the list never scrolls sideways. They are all still one click away in Display.
              className={cn(
                '@container hidden md:block',
                '@max-5xl:[&_[data-column-id=memory]]:hidden @max-5xl:[&_[data-column-id=cpu]]:hidden',
                '@max-4xl:[&_[data-column-id=tokens]]:hidden @max-3xl:[&_[data-column-id=cost]]:hidden',
                '@max-2xl:[&_[data-column-id=diff]]:hidden @max-xl:[&_[data-column-id=status]]:w-auto',
              )}
            >
              <TooltipProvider>
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead data-column-id="status" className={cn(LIST_HEAD_CLASS, 'w-[150px]')}>
                        Status
                      </TableHead>
                      <TableHead data-column-id="task" className={LIST_HEAD_CLASS}>
                        Task
                      </TableHead>
                      {metricColumns.map((id) => (
                        <TableHead
                          key={id}
                          data-column-id={id}
                          className={cn(LIST_HEAD_CLASS, id !== 'diff' && 'text-right')}
                        >
                          {HEAD_LABELS[id]}
                        </TableHead>
                      ))}
                      <TableHead className={cn(LIST_HEAD_CLASS, 'w-[76px]')}>
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((node) => (
                      <TaskRow
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
                        shown={shown}
                        metricColumns={metricColumns}
                      />
                    ))}
                  </TableBody>
                </Table>
              </TooltipProvider>
            </ListFrame>

            {/* <md: the same runs as one stacked list. */}
            <ListFrame data-slot="task-cards" className="divide-y divide-border md:hidden">
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
            </ListFrame>
          </>
        )}
      </PageBody>

      {/* The mobile New-task FAB. The desktop CTA lives in the sidebar. */}
      <Link
        to="/new"
        data-slot="new-task-fab"
        aria-label="New task"
        className="fixed right-4 bottom-[calc(16px+env(safe-area-inset-bottom))] z-20 inline-flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg md:hidden"
      >
        <PlusIcon className="size-[22px]" aria-hidden="true" />
      </Link>
    </Page>
  )
}

/** The header's one-line answer to "what is going on here?" — counted from the same attention
 *  grammar the rows wear. */
function summaryOf(runs: readonly RunRecord[]): string {
  let needsYou = 0
  let running = 0
  let queued = 0
  let failed = 0
  for (const run of runs) {
    if (run.archived) continue
    const { bucket } = deriveAttention(run)
    if (bucket === 'waiting' || bucket === 'permission') needsYou += 1
    else if (bucket === 'running') running += 1
    else if (bucket === 'error') failed += 1
    else if (run.status === 'queued') queued += 1
  }
  const unread = unreadDoneCount(runs)
  const parts = [
    needsYou > 0 ? `${needsYou} ${needsYou === 1 ? 'needs' : 'need'} you` : null,
    running > 0 ? `${running} running` : null,
    queued > 0 ? `${queued} queued` : null,
    failed > 0 ? `${failed} failed` : null,
    unread > 0 ? `${unread} unread` : null,
  ].filter((part): part is string => part !== null)
  if (parts.length > 0) return parts.join(' · ')
  return runs.length === 0 ? 'Everything agents are working on in this project.' : 'Nothing needs you right now.'
}

function MenuCount({ children }: { children: React.ReactNode }) {
  return <span className="ml-auto pl-4 text-xs text-muted-foreground tabular-nums">{children}</span>
}

function DisplayItem({
  id,
  checked,
  disabled,
  onToggle,
}: {
  id: TaskColumnId
  checked: boolean
  disabled: boolean
  onToggle: (id: TaskColumnId) => void
}) {
  return (
    <DropdownMenuCheckboxItem
      data-column-id={id}
      checked={checked}
      disabled={disabled}
      onCheckedChange={() => onToggle(id)}
      // Several ticks in a row is the common case — keep the menu open.
      onSelect={(event) => event.preventDefault()}
    >
      {DISPLAY_LABELS[id]}
    </DropdownMenuCheckboxItem>
  )
}

function ListSkeleton() {
  return (
    <ListFrame data-slot="tasks-loading" aria-busy="true" className="divide-y divide-border">
      {[0, 1, 2, 3, 4].map((row) => (
        <div key={row} className="flex items-center gap-4 px-5 py-3.5">
          <Skeleton className="h-6 w-24 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3 w-1/4" />
          </div>
          <Skeleton className="h-3.5 w-12" />
        </div>
      ))}
    </ListFrame>
  )
}

/** What an empty list honestly means, given how it got empty — one variant per cause. */
function TasksEmptyState({ view, query }: { view: ListView; query: string }) {
  const needle = query.trim()
  const kind = needle ? 'search-miss' : view === 'archived' ? 'archive' : 'no-tasks'
  return (
    <div data-slot="tasks-empty" data-empty-kind={kind} className="flex flex-1 flex-col">
      {kind === 'search-miss' ? (
        <ListEmpty
          icon={<SearchXIcon />}
          title="No matching tasks"
          description={`No tasks match “${needle}”.`}
        />
      ) : kind === 'archive' ? (
        <ListEmpty
          icon={<ArchiveIcon />}
          title="Nothing archived yet"
          description="Finished tasks you archive land here."
        />
      ) : (
        <ListEmpty
          icon={<ListChecksIcon />}
          tone="primary"
          title="No tasks yet"
          description="Describe a task and an agent picks it up in its own worktree."
          action={
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

const titleTone = (run: RunRecord) =>
  // Read/unread (#unread-done-items): promote an unread done item, dim a read one — the same
  // grammar as the sidebar row.
  isUnread(run) ? 'font-semibold text-foreground' : isReadDoneItem(run) ? 'font-medium text-muted-foreground' : 'font-medium text-foreground'

function DispatchKind({ run, className }: { run: RunRecord; className?: string }) {
  const kind = dispatchKindLabel(run)
  // What a DISPATCHED row is for — `review` or `implement`. Null on every root.
  return kind ? (
    <Badge variant="secondary" data-slot="dispatch-kind" className={cn('h-5 px-1.5 font-normal text-muted-foreground', className)}>
      {kind}
    </Badge>
  ) : null
}

function UnreadDot({ className }: { className?: string }) {
  return (
    <StatusDot
      tone="violet"
      role="img"
      aria-label="unread"
      title="Unread — not opened since it finished"
      className={cn('shrink-0', className)}
    />
  )
}

/**
 * One run, one row.
 *
 * The whole row is a click target for `/tasks/:id` — but a click that lands on any anchor,
 * button or input inside it belongs to that control and is not hijacked. The title is a true
 * `<Link>` so the row's destination exists for keyboards and middle-clicks too.
 */
function TaskRow({
  run,
  depth,
  childCount,
  subtasksExpanded,
  onToggleSubtasks,
  queuePosition,
  onRename,
  onTogglePin,
  now,
  shown,
  metricColumns,
}: {
  run: RunRecord
  /** Nesting level under the task that dispatched this one; 0 for a top-level row. */
  depth: number
  /** How many tasks THIS one dispatched — the row's "N subtasks" handle. */
  childCount: number
  /** Whether this row's dispatched children are unfolded beneath it (#1110). */
  subtasksExpanded: boolean
  onToggleSubtasks: (id: string) => void
  queuePosition: number | null
  onRename: (id: string, title: string) => void
  onTogglePin?: (run: RunRecord, pinned: boolean) => void
  now: number
  shown: Shown
  metricColumns: readonly TaskColumnId[]
}) {
  const navigate = useNavigate()
  const attention = deriveAttention(run)
  const scheduled = scheduledResume(run)
  const to = `/tasks/${run.id}`
  const cost = formatCost(run.costUsd)
  const reference = taskReference(run)
  const title = runTitle(run)
  // Same machine as the run header's title — one edit, one PATCH.
  const editor = useTitleEditor(title, (next) => onRename(run.id, next))
  const subtasks = subtaskLabel(childCount)
  // Inline style: depth is unbounded and Tailwind cannot generate a class per level. 14px a
  // level is the sidebar's own nesting step.
  const indent = depth > 0 ? { paddingLeft: `${depth * 14}px` } : undefined
  const details = [
    shown('workflow') ? <span key="workflow">{workflowLabel(run)}</span> : null,
    shown('branch') && run.branch ? (
      <span key="branch" className="truncate font-mono text-xs">
        {run.branch}
      </span>
    ) : null,
    queuePosition !== null ? (
      <span key="queue" data-slot="queue-note" className="tabular-nums">
        #{queuePosition} in queue
      </span>
    ) : null,
  ].filter((part) => part !== null)

  return (
    <TableRow
      data-slot="task-table-row"
      data-run-id={run.id}
      data-depth={depth}
      onClick={(event) => {
        if ((event.target as Element).closest('a, button, input')) return
        navigate(to)
      }}
      className="group/row cursor-pointer"
    >
      <TableCell data-column-id="status" className={LIST_CELL_CLASS}>
        {/* A scheduled run wears its appointment in the badge. */}
        <TaskStatusBadge attention={attention} title={scheduled?.title}>
          {scheduled ? <span className="tabular-nums">{scheduled.label}</span> : null}
        </TaskStatusBadge>
      </TableCell>

      <TableCell data-column-id="task" className={cn(LIST_CELL_CLASS, 'w-full max-w-0 min-w-[260px]')}>
        <div className="flex min-w-0 flex-col gap-0.5" style={indent}>
          {editor.editing ? (
            <TitleEditInput editor={editor} className="text-sm font-medium" />
          ) : (
            <div className="flex min-w-0 items-center gap-2">
              {/* The mark that says this row was ORDERED by the row above it, not by a person. */}
              {depth > 0 ? (
                <span
                  aria-hidden="true"
                  data-slot="subtask-tick"
                  className="shrink-0 font-mono text-xs leading-none text-soft-foreground"
                >
                  &#9492;
                </span>
              ) : null}
              <Link to={to} title={title} className={cn('min-w-0 truncate text-sm', titleTone(run))}>
                {title}
              </Link>
              {isUnread(run) ? <UnreadDot /> : null}
              <DispatchKind run={run} />
              {subtasks ? (
                <SubtaskToggle
                  label={subtasks}
                  expanded={subtasksExpanded}
                  onToggle={() => onToggleSubtasks(run.id)}
                />
              ) : null}
            </div>
          )}
          {details.length > 0 || (shown('reference') && reference) ? (
            <div
              data-slot="task-details"
              className={cn('flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground', depth > 0 && 'pl-5')}
            >
              {details.map((part, index) => (
                <React.Fragment key={index}>
                  {index > 0 ? <Sep /> : null}
                  {part}
                </React.Fragment>
              ))}
              {shown('reference') && reference ? (
                <span className={cn('flex shrink-0 items-center gap-1', details.length > 0 && 'ml-1')}>
                  <TaskReferenceChip run={run} reference={reference} className="h-5" />
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </TableCell>

      {metricColumns.map((id) => {
        switch (id) {
          case 'diff':
            return (
              <TableCell key={id} data-column-id={id} className={LIST_CELL_CLASS}>
                {run.diffStat ? <DiffStatLabel stat={run.diffStat} /> : <Dash />}
              </TableCell>
            )
          case 'tokens':
            return (
              <TableCell key={id} data-column-id={id} className={cn(LIST_CELL_CLASS, 'text-right text-xs text-muted-foreground')}>
                <DirectionalUsage
                  inputTokens={run.inputTokens}
                  outputTokens={run.outputTokens}
                  variant="table"
                  omitWhenUnknown={false}
                />
              </TableCell>
            )
          case 'cost':
            return (
              <TableCell
                key={id}
                data-column-id={id}
                className={cn(LIST_CELL_CLASS, 'text-right text-[13px] text-muted-foreground tabular-nums')}
              >
                {cost || <Dash />}
              </TableCell>
            )
          case 'cpu':
          case 'memory':
            return <UsageTd key={id} run={run} column={id} />
          case 'started':
            return (
              <TableCell
                key={id}
                data-column-id={id}
                className={cn(LIST_CELL_CLASS, 'text-right text-[13px] text-muted-foreground tabular-nums')}
              >
                {shortAge(run.startedAt ?? run.createdAt, now)}
              </TableCell>
            )
          default:
            return null
        }
      })}

      <TableCell className={cn(LIST_CELL_CLASS, 'text-right')}>
        <span className="inline-flex items-center justify-end gap-0.5">
          {/* Revealed on hover so a resting list stays quiet; `no-hover:` covers a tablet. */}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            data-slot="row-rename"
            aria-label="Rename task"
            title="Rename"
            onClick={editor.begin}
            className="size-7 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 no-hover:opacity-100"
          >
            <PencilIcon className="size-3.5" aria-hidden="true" />
          </Button>
          {/* A pinned row keeps its pin lit: it is the whole explanation for why the row sorted
              to the top. */}
          {onTogglePin ? (
            <PinToggle
              pinned={Boolean(run.pinned)}
              onToggle={(pinned) => onTogglePin(run, pinned)}
              className="size-7 hover:bg-muted opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 no-hover:opacity-100 data-[pinned=true]:opacity-100"
            />
          ) : null}
        </span>
      </TableCell>
    </TableRow>
  )
}

/**
 * One live CPU or Memory cell, read from the global usage stream (`useRunUsage`, never
 * `run.usage` — the REST snapshot goes stale between refetches). Selected per run, so a tick
 * that says nothing about this run re-renders nothing.
 */
function UsageTd({ run, column }: { run: RunRecord; column: 'cpu' | 'memory' }) {
  const sample = useRunUsage(run.id)
  const cells = usageCells(run, sample)
  const cell: UsageCell = column === 'cpu' ? cells.cpu : cells.mem
  return (
    <TableCell
      data-usage={column === 'memory' ? 'mem' : column}
      data-column-id={column}
      data-usage-kind={cell.kind}
      title={cell.title}
      className={cn(
        LIST_CELL_CLASS,
        'text-right text-[13px] tabular-nums',
        cell.kind === 'live' ? 'font-medium text-foreground' : 'text-muted-foreground',
      )}
    >
      {cell.text || '—'}
    </TableCell>
  )
}

/** One run, one stacked row — the `<md` framing of the same data. */
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
  const cost = formatCost(run.costUsd)
  const subtasks = subtaskLabel(childCount)
  const hasDirectionalUsage = run.inputTokens !== undefined || run.outputTokens !== undefined

  return (
    <div
      data-slot="task-card"
      data-run-id={run.id}
      data-depth={depth}
      style={depth > 0 ? { paddingLeft: `${16 + depth * 14}px` } : undefined}
      onClick={(event) => {
        // A control inside the card owns its own click.
        if ((event.target as Element).closest('a, button')) return
        navigate(to)
      }}
      className="cursor-pointer px-4 py-3.5 active:bg-muted/50"
    >
      <div className="flex items-start gap-2">
        <Link to={to} className={cn('min-w-0 flex-1 text-sm leading-snug', titleTone(run))}>
          {runTitle(run)}
        </Link>
        {isUnread(run) ? <UnreadDot className="mt-1.5" /> : null}
        <span className="mt-px shrink-0 text-xs text-muted-foreground tabular-nums">
          {shortAge(run.finishedAt ?? run.createdAt, now)}
        </span>
        {/* Always visible here: a card has no hover on the device it exists for. */}
        {onTogglePin ? (
          <PinToggle
            pinned={Boolean(run.pinned)}
            onToggle={(pinned) => onTogglePin(run, pinned)}
            className="-mt-1 -mr-1.5 size-7"
          />
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <TaskStatusBadge attention={attention} title={scheduled?.title}>
          {scheduled ? <span className="tabular-nums">{scheduled.label}</span> : null}
        </TaskStatusBadge>
        <DispatchKind run={run} />
        {subtasks ? (
          <SubtaskToggle
            label={subtasks}
            expanded={subtasksExpanded}
            onToggle={() => onToggleSubtasks(run.id)}
          />
        ) : null}
        {run.diffStat ? <DiffStatLabel stat={run.diffStat} /> : null}
        {reference ? <TaskReferenceChip run={run} reference={reference} className="h-5" /> : null}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
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
                <span className="font-mono">{run.branch}</span>
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
      </div>
    </div>
  )
}

/** An honest em dash: this cell has nothing true to show. */
function Dash() {
  return <span className="text-[13px] text-soft-foreground">—</span>
}

function Sep() {
  return (
    <span className="text-soft-foreground" aria-hidden="true">
      ·
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
      />
    </ReferenceStatusProvider>
  )
}
