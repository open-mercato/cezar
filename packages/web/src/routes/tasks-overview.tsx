import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArchiveIcon,
  ArrowUpRightIcon,
  CheckCheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  EllipsisIcon,
  FilterXIcon,
  HandIcon,
  ListChecksIcon,
  LoaderIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
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
import { Page, PageBody, PageHeader } from '@/components/page'
import { PinToggle } from '@/components/pin-toggle'
import { TaskReferenceChip } from '@/components/reference-conflict-action'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { StatusDot } from '@/components/status-dot'
import { SubtaskToggle } from '@/components/subtask-toggle'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/components/ui/toaster'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
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
 * The four questions the page answers before you read a single row — and, clicked, the four
 * cuts of the list. One grammar with the rows: the same `deriveAttention` decides both.
 */
type Focus = 'needs-you' | 'in-progress' | 'finished' | 'failed'

function focusOf(run: RunRecord): Focus | null {
  const { bucket } = deriveAttention(run)
  if (bucket === 'waiting' || bucket === 'permission') return 'needs-you'
  if (bucket === 'error') return 'failed'
  if (bucket === 'running' || run.status === 'queued') return 'in-progress'
  if (run.status === 'done') return 'finished'
  return null
}

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
  // Which summary card is narrowing the list, if any. Local: it is a way of looking, not a setting.
  const [focus, setFocus] = React.useState<Focus | null>(null)
  const all = runs ?? []
  const counts = listCounts(all)
  // The cards count what is on the Active side; Archived is history, and has no cuts.
  const live = all.filter((run) => !run.archived)
  const tally = { 'needs-you': 0, 'in-progress': 0, finished: 0, failed: 0 } satisfies Record<Focus, number>
  let queued = 0
  // Unread among the FINISHED ones only: the card's note has to be about the card's own number.
  let finishedUnread = 0
  for (const run of live) {
    const kind = focusOf(run)
    if (kind) tally[kind] += 1
    if (run.status === 'queued') queued += 1
    if (kind === 'finished' && isUnread(run)) finishedUnread += 1
  }
  const activeFocus = view === 'active' ? focus : null
  const matching = filterRuns(all, query)
  const visible = sortRuns(activeFocus ? matching.filter((run) => focusOf(run) === activeFocus) : matching, view)
  // A live search overrides the fold wholesale: a match the accordion hid would read as a miss.
  const searching = query.trim() !== ''
  // Dispatched children nest under the task that ordered them. One derivation, both layouts.
  const rows = taskTreeRows(visible, (id) => searching || expandedSubtasks.has(id))
  // Tasks a person started, as opposed to the ones those tasks dispatched — the footer counts both.
  const roots = taskTreeRows(visible, () => true).filter((node) => node.depth === 0).length
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
        description="What agents are doing in this project, and what is waiting on you."
        actions={
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
              <DropdownMenuItem data-slot="archive-finished" disabled={!canArchiveFinished} onSelect={onArchiveFinished}>
                <ArchiveIcon aria-hidden="true" />
                Archive finished
                {canArchiveFinished ? <MenuCount>{finished}</MenuCount> : null}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />

      <PageBody className="flex flex-col gap-6">
        {/* The summary: four numbers, each a way to cut the list below. */}
        <ToggleGroup
          type="single"
          value={activeFocus ?? ''}
          onValueChange={(next) => {
            setFocus(next === '' ? null : (next as Focus))
            // A card describes the Active side; picking one from Archived goes there.
            if (next !== '' && view !== 'active') onViewChange('active')
          }}
          spacing={4}
          aria-label="Filter tasks by state"
          data-slot="task-summary"
          className="grid w-full grid-cols-2 xl:grid-cols-4"
        >
          <SummaryCard
            value="needs-you"
            icon={<HandIcon />}
            label="Needs you"
            count={runs === undefined ? null : tally['needs-you']}
            hint={tally['needs-you'] > 0 ? 'Waiting for a reply or a review' : 'All caught up'}
            tone={tally['needs-you'] > 0 ? 'violet' : 'neutral'}
          />
          <SummaryCard
            value="in-progress"
            icon={<LoaderIcon />}
            label="In progress"
            count={runs === undefined ? null : tally['in-progress']}
            hint={queued > 0 ? `${queued} queued` : tally['in-progress'] > 0 ? 'Agents are working' : 'Nothing running'}
          />
          <SummaryCard
            value="finished"
            icon={<CircleCheckIcon />}
            label="Finished"
            count={runs === undefined ? null : tally.finished}
            hint={finishedUnread > 0 ? `${finishedUnread} not opened yet` : 'Ready to review or archive'}
            badge={finishedUnread > 0 ? `${finishedUnread} new` : undefined}
          />
          <SummaryCard
            value="failed"
            icon={<CircleAlertIcon />}
            label="Failed"
            count={runs === undefined ? null : tally.failed}
            hint={tally.failed > 0 ? 'Open one to see why' : 'No failures'}
            tone={tally.failed > 0 ? 'danger' : 'neutral'}
          />
        </ToggleGroup>

        {/* Finished variant groups are a decision waiting on a person, so they sit above the list. */}
        {strips.length > 0 ? (
          <section aria-labelledby="tasks-decisions" className="flex flex-col gap-2">
            <h2 id="tasks-decisions" className="text-[15px] font-semibold text-foreground">
              Waiting for a decision
            </h2>
            <ItemGroup className="gap-2">
              {strips.map((group) => (
                <Item
                  key={group.groupId}
                  variant="outline"
                  data-slot="compare-strip"
                  data-group-id={group.groupId}
                  className="bg-card shadow-xs"
                >
                  <ItemMedia variant="icon" className="rounded-lg border-0 bg-violet/12 text-violet">
                    <ScaleIcon aria-hidden="true" />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{group.title}</ItemTitle>
                    <ItemDescription>{group.count} variants finished — compare them and keep one.</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button asChild variant="outline" size="sm">
                      <Link to={`/compare/${group.groupId}`}>
                        Compare
                        <ArrowUpRightIcon aria-hidden="true" />
                      </Link>
                    </Button>
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          </section>
        ) : null}

        {/* The list: one card holding its own toolbar, the table and a footer line. */}
        <Card flush data-slot="tasks-card">
          <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
            <ListViewTabs view={view} onChange={onViewChange} counts={counts} />
            {activeFocus ? (
              <Badge variant="secondary" data-slot="focus-chip" className="h-7 gap-1 pr-1 pl-2.5 text-[13px] font-medium">
                {FOCUS_LABEL[activeFocus]}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Clear the ${FOCUS_LABEL[activeFocus]} filter`}
                  onClick={() => setFocus(null)}
                  className="size-5 rounded-full"
                >
                  <FilterXIcon aria-hidden="true" />
                </Button>
              </Badge>
            ) : null}
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
          </div>

          {runs === undefined ? (
            <ListSkeleton />
          ) : visible.length === 0 ? (
            <TasksEmptyState
              view={view}
              query={query}
              focus={activeFocus}
              onClearFocus={() => setFocus(null)}
            />
          ) : (
            <>
              {/* ≥md: the table. */}
              <div data-slot="tasks-table" className="hidden md:block">
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
                        <TableHead className={cn(LIST_HEAD_CLASS, 'w-[84px]')}>
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
              </div>

              {/* <md: the same runs as one stacked list. */}
              <div data-slot="task-cards" className="divide-y divide-border md:hidden">
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

              <div
                data-slot="tasks-count"
                className="flex items-center justify-between gap-3 border-t border-border px-5 py-2.5 text-[13px] text-muted-foreground"
              >
                <span className="tabular-nums">
                  {roots} {roots === 1 ? 'task' : 'tasks'}
                  {visible.length > roots ? ` · ${visible.length - roots} subtasks` : ''}
                  {visible.length < counts[view] ? ` · ${counts[view] - visible.length} hidden by the filter` : ''}
                </span>
                {activeFocus || searching ? (
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-[13px] text-muted-foreground"
                    onClick={() => {
                      setFocus(null)
                      setQuery('')
                    }}
                  >
                    Show all
                  </Button>
                ) : null}
              </div>
            </>
          )}
        </Card>
      </PageBody>
    </Page>
  )
}

const FOCUS_LABEL: Record<Focus, string> = {
  'needs-you': 'Needs you',
  'in-progress': 'In progress',
  finished: 'Finished',
  failed: 'Failed',
}

/**
 * One summary number, and a toggle that cuts the list to it. Built on the toggle-group item so
 * the four are one single-choice control for a keyboard, and dressed as a card.
 */
function SummaryCard({
  value,
  icon,
  label,
  count,
  hint,
  badge,
  tone = 'neutral',
}: {
  value: Focus
  icon: React.ReactNode
  label: string
  /** Null while the list has not answered. */
  count: number | null
  hint: string
  /** A small trailing note in the header: "3 new". */
  badge?: string
  /** Colour only when the number is asking for something. */
  tone?: 'neutral' | 'violet' | 'danger'
}) {
  return (
    <ToggleGroupItem
      value={value}
      data-slot="summary-card"
      data-focus={value}
      className={cn(
        'h-auto w-full min-w-0 justify-start rounded-xl border border-border bg-card p-0 text-left font-normal whitespace-normal shadow-xs hover:bg-card hover:text-foreground',
        'data-[state=on]:border-foreground/25 data-[state=on]:bg-card data-[state=on]:ring-[3px] data-[state=on]:ring-ring/25',
        tone === 'violet' && 'border-violet/30 bg-violet/[0.06] hover:bg-violet/[0.06] data-[state=on]:bg-violet/[0.06]',
        tone === 'danger' && 'border-danger/25 bg-danger/[0.05] hover:bg-danger/[0.05] data-[state=on]:bg-danger/[0.05]',
      )}
    >
      <Card className="w-full gap-3 border-0 bg-transparent py-4 shadow-none">
        <CardHeader className="gap-1.5 px-4">
          <CardDescription className="flex items-center gap-1.5 text-[13px]">
            <span
              aria-hidden="true"
              className={cn(
                '[&>svg]:size-3.5',
                tone === 'violet' && 'text-violet',
                tone === 'danger' && 'text-danger',
              )}
            >
              {icon}
            </span>
            {label}
            {badge ? (
              <Badge variant="secondary" className="ml-auto h-5 bg-violet/12 px-1.5 text-[11px] font-medium text-violet">
                {badge}
              </Badge>
            ) : null}
          </CardDescription>
          <CardTitle
            className={cn(
              'text-[28px] leading-8 font-semibold tabular-nums',
              tone === 'violet' && 'text-violet',
              tone === 'danger' && 'text-danger',
            )}
          >
            {count === null ? <Skeleton className="h-8 w-10" /> : count}
          </CardTitle>
        </CardHeader>
        <CardFooter className="px-4 text-xs text-muted-foreground">{hint}</CardFooter>
      </Card>
    </ToggleGroupItem>
  )
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
    <div data-slot="tasks-loading" aria-busy="true" className="divide-y divide-border">
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
    </div>
  )
}

/** What an empty list honestly means, given how it got empty — one variant per cause. */
function TasksEmptyState({
  view,
  query,
  focus = null,
  onClearFocus,
}: {
  view: ListView
  query: string
  /** The summary card narrowing the list, when that is why it is empty. */
  focus?: Focus | null
  onClearFocus?: () => void
}) {
  const needle = query.trim()
  const kind = needle ? 'search-miss' : focus ? 'focus-miss' : view === 'archived' ? 'archive' : 'no-tasks'
  // Inside the list card: the card is the surface, so the empty state brings no frame of its own.
  const bare = 'rounded-none border-0 py-14 md:py-16'
  return (
    <div data-slot="tasks-empty" data-empty-kind={kind} className="flex flex-1 flex-col">
      {kind === 'search-miss' ? (
        <ListEmpty
          icon={<SearchXIcon />}
          title="No matching tasks"
          description={`No tasks match “${needle}”.`}
          className={bare}
        />
      ) : kind === 'focus-miss' && focus ? (
        <ListEmpty
          icon={<FilterXIcon />}
          title={`Nothing under “${FOCUS_LABEL[focus]}”`}
          description="No task is in that state right now."
          className={bare}
          action={
            <Button variant="outline" onClick={onClearFocus}>
              Show all tasks
            </Button>
          }
        />
      ) : kind === 'archive' ? (
        <ListEmpty
          icon={<ArchiveIcon />}
          title="Nothing archived yet"
          description="Finished tasks you archive land here."
          className={bare}
        />
      ) : (
        <ListEmpty
          icon={<ListChecksIcon />}
          tone="primary"
          title="No tasks yet"
          description="Describe a task and an agent picks it up in its own worktree."
          className={bare}
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
  const renaming = React.useRef(false)
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
        // The row menu is portalled, but React still bubbles its clicks through this row.
        if ((event.target as Element).closest('a, button, input, [role="menu"]')) return
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
          {/* A pinned row keeps its pin lit: it is the whole explanation for why the row sorted
              to the top. Everything else a row can do is in its menu. */}
          {onTogglePin && run.pinned ? (
            <PinToggle pinned onToggle={(pinned) => onTogglePin(run, pinned)} className="size-7 hover:bg-muted" />
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                data-slot="row-actions"
                aria-label={`Actions for ${title}`}
                className="size-7 text-muted-foreground data-[state=open]:bg-muted"
              >
                <EllipsisIcon className="size-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="min-w-44"
              // Rename puts the caret in the title field; handing focus back to the trigger on
              // close would blur that field and cancel the edit it just started.
              onCloseAutoFocus={(event) => {
                if (!renaming.current) return
                renaming.current = false
                event.preventDefault()
                // The field mounted while the menu still held focus, so its own autofocus lost;
                // give it the caret now that the menu has let go.
                const field = document.querySelector<HTMLInputElement>(
                  `[data-slot="task-table-row"][data-run-id="${run.id}"] input`,
                )
                field?.focus()
                field?.select()
              }}
            >
              <DropdownMenuItem asChild>
                <Link to={to}>
                  <ArrowUpRightIcon aria-hidden="true" />
                  Open
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem
                data-slot="row-rename"
                onSelect={() => {
                  renaming.current = true
                  editor.begin()
                }}
              >
                <PencilIcon aria-hidden="true" />
                Rename
              </DropdownMenuItem>
              {onTogglePin ? (
                <DropdownMenuItem onSelect={() => onTogglePin(run, !run.pinned)}>
                  {run.pinned ? <PinOffIcon aria-hidden="true" /> : <PinIcon aria-hidden="true" />}
                  {run.pinned ? 'Unpin' : 'Pin to top'}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
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
