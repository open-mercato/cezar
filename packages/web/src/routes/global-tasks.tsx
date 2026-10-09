import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CheckIcon,
  EyeIcon,
  EyeOffIcon,
  FolderGit2Icon,
  LayersIcon,
  ListChecksIcon,
  Rows3Icon,
  SearchXIcon,
  SlidersHorizontalIcon,
  XIcon,
} from 'lucide-react'
import * as React from 'react'
import { Link, useSearchParams } from 'react-router'
import { useGlobalSettings } from '@/components/global-settings'

import { archiveProjectRun, setProjectRunRead } from '@/api/client'
import {
  queryKeys,
  rememberReferenceStatuses,
  useHealth,
  useProjects,
  useRunsIndex,
  workspaceQueryKeys,
} from '@/api/queries'
import type { ProjectListEntry, RunIndexEntry, RunsIndexResponse } from '@open-mercato/cezar-api-client'
import { dispatchKindLabel, subtaskLabel, taskTreeRows, type TaskTreeInput } from '@/lib/task-tree'
import { ContextSidebar } from '@/components/context-sidebar'
import { FacetMenu } from '@/components/facet-filter'
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
import { ReferenceChip } from '@/components/reference-chip'
import { ResolveConflictsForRun } from '@/components/reference-conflict-action'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { StatusDot } from '@/components/status-dot'
import { SubtaskToggle } from '@/components/subtask-toggle'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/components/ui/toaster'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { deriveAttention } from '@/lib/attention'
import { shortAge } from '@/lib/format'
import {
  formatCost,
  taskReferences,
  usageCells,
  type TaskReference,
  type UsageCell,
} from '@/lib/tasks-table'
import {
  GROUP_BY_OPTIONS,
  NO_FILTERS,
  UNTAGGED,
  allStatuses,
  canReset,
  allWorkflows,
  facetCounts,
  filterGlobalTasks,
  urlStateFromSearchParams,
  urlStateToSearchParams,
  groupGlobalTasks,
  hasActiveFilters,
  tagValuesOf,
  tasksExcludingFacet,
  toGlobalTasks,
  toggleFacetValue,
  truncatedProjectNames,
  type FacetId,
  type GlobalTask,
  type GlobalTaskFilters,
  type GlobalTasksUrlState,
  type GroupBy,
} from '@/lib/global-tasks'
import { scopeTo } from '@/lib/project-router'
import { allProjectTags } from '@/lib/project-tags'
import { canBeUnread, isReadDoneItem, isUnread } from '@/lib/read-state'
import { runTitle, type ListView } from '@/lib/task-groups'
import { usageMetricVisibility } from '@/lib/token-metrics'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'

/**
 * The global Tasks page at `/tasks` — every registered project's work in one table.
 *
 * It is deliberately NOT under `/p/:projectId`, for the same reason `/settings/global` is not:
 * "all projects" scoped to one project is a contradiction. That also decides its data. The page
 * reads the workspace-level cross-project index (`GET /api/v1/workspace/runs-index`) — one
 * request for the whole registry — rather than N per-project run lists, which would ship a full
 * `RunRecord` (`steps[]` and all) per run times the registry to paint a title and a dot.
 *
 * The trade that buys: the index is a slim row and a capped one, and it names any project the cap
 * bit rather than presenting a short list as a complete one. It is not stale, though: the one
 * `/workspace/events` stream carries every project's run news, and any of it invalidates this
 * index (`global-events.tsx`) — the interval below is the backstop for what a stream cannot
 * promise, not the mechanism.
 *
 * **Filters and grouping live in the URL** (`?q=&tag=&status=&workflow=&group=`), which makes a
 * filtered view survive a refresh, paste into a colleague's chat, and sit in a bookmark. The URL
 * is the state rather than a mirror of it — there is no second copy to drift — and every write is
 * a `replace`, so Back leaves the page instead of undoing one chip at a time.
 *
 * The Active/Archived split is in there too, as `archived=1` present-or-absent: Active is the
 * default and the common case, so a normal link carries no key for it. The shared
 * `useListView()` context still exists and this page publishes to it, so walking from an
 * archived view into a project keeps answering the same question — but here the URL is the
 * authority and the context follows, not the reverse.
 *
 * Presentational logic lives in `lib/global-tasks.ts`; what is here is markup, the router and the
 * local filter state.
 */

/** How often the page re-reads the cross-project index ON TOP of the stream's invalidations —
 *  the cover for a dropped socket, a frozen tab, or a run that ended while the connection was
 *  down. Slow enough that a forty-project workspace is not re-scanned every few seconds. */
const RUNS_INDEX_POLL_MS = 15_000

/** How long the search box waits before writing the URL. Long enough that a typed word is one
 *  history write rather than eight, short enough that a paste-and-share feels immediate. */
const QUERY_DEBOUNCE_MS = 250

/** How many reference chips a row paints before the rest collapse into a `+N`.
 *
 *  ONE. Two fit on a line but cost ~90px of a column that Task wants more, and nothing is lost
 *  by folding the rest: the `+N` opens on HOVER and lists every reference as a real link, so the
 *  second one is a pointer-move away rather than a click. The strongest reference — the PR a task
 *  created, else the one it is about, else its issue — is the one worth the row's own space. */
const MAX_VISIBLE_REFERENCES = 1

/** How long the `+N` list survives the pointer leaving it. The trigger and the list are separate
 *  elements with a gap between them, so closing instantly would make the list unreachable. */
const HOVER_CLOSE_DELAY_MS = 220

/** What "finished" means for the archive affordance — outcomes, not gates. A `review` run still
 *  wants a human, so it is not swept away, exactly as the per-project broom decides it. */
const ARCHIVABLE_STATUSES: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled'])

/** Archive (or restore) one indexed run, in its own project. */
function useArchiveIndexedRun() {
  return useIndexedRunMutation({
    request: ({ task, archived }: { task: GlobalTask; archived: boolean }) =>
      archiveProjectRun(task.run.projectId, task.run.id, archived),
    patch: ({ archived }) => (run) => ({ ...run, archived }),
  })
}

/**
 * Mark one indexed run read or unread — the same cross-project shape as the archive above.
 *
 * The receipt matters more here than anywhere else: this page is where you notice that something
 * finished while you were not looking, and "I have dealt with that one" needs somewhere to go
 * that is not archiving it. Reading a thread already stamps it; this is the manual half, and its
 * inverse (#775) is what makes an accidental stamp recoverable.
 */
function useReadIndexedRun() {
  return useIndexedRunMutation({
    request: ({ task, read }: { task: GlobalTask; read: boolean }) =>
      setProjectRunRead(task.run.projectId, task.run.id, read),
    patch:
      ({ read }) =>
      (run) => {
        if (read) return { ...run, seenAt: new Date().toISOString() }
        // Cleared as a rest-destructure, not `seenAt: undefined`: the reader is `isUnread`, which
        // keys on the field being ABSENT, and the server never writes an explicit undefined.
        const { seenAt: _dropped, ...rest } = run
        return rest
      },
  })
}

/**
 * The shape both row actions share: act on a run in ITS OWN project, move the row optimistically
 * so the click lands immediately, reconcile afterwards, and roll back with the server's reason if
 * it refused.
 *
 * Two things are cross-project rather than scoped, and both follow from standing outside every
 * `/p/:projectId`: the request names the project explicitly (`queryScope()` would answer with the
 * BOOT project, so an action on another project's row would 404 or — with a colliding id — land
 * on the wrong task), and the cache patched is the workspace index rather than the project's own
 * run list, which may not even be loaded here.
 */
function useIndexedRunMutation<V extends { task: GlobalTask }>({
  request,
  patch,
}: {
  request: (variables: V) => Promise<unknown>
  patch: (variables: V) => (run: RunIndexEntry) => RunIndexEntry
}) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: request,
    onMutate: async (variables: V) => {
      await queryClient.cancelQueries({ queryKey: workspaceQueryKeys.runsIndex })
      const previous = queryClient.getQueryData<RunsIndexResponse>(workspaceQueryKeys.runsIndex)
      const apply = patch(variables)
      const { task } = variables
      queryClient.setQueryData<RunsIndexResponse>(workspaceQueryKeys.runsIndex, (current) =>
        current === undefined
          ? current
          : {
              ...current,
              runs: current.runs.map((run) =>
                run.projectId === task.run.projectId && run.id === task.run.id ? apply(run) : run,
              ),
            },
      )
      return { previous }
    },
    onError: (error: Error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(workspaceQueryKeys.runsIndex, context.previous)
      }
      toast(error.message, { tone: 'danger' })
    },
    onSettled: (_data, _error, { task }) => {
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.runsIndex })
      // The run's own project may be the active scope (its list is `queryKeys.runs.all`) or a
      // sidebar group's explicit key — invalidate both spellings so neither shows a row this
      // page has just changed.
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
      void queryClient.invalidateQueries({ queryKey: [task.run.projectId, 'runs', 'list'] })
    },
  })
}

const sentenceCase = (label: string) => label.charAt(0).toUpperCase() + label.slice(1)

/** Spend and live usage: real columns, off until asked for (cockpit concept 2). */
const OPTIONAL_COLUMNS = [
  { id: 'cost', label: 'Cost' },
  { id: 'cpu', label: 'CPU' },
  { id: 'memory', label: 'Memory' },
] as const
type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number]['id']

const COLUMNS_STORAGE_KEY = 'cez-global-tasks-columns'

/** Per-browser on purpose: this page has no workspace-state slot, and a column choice is a
 *  viewing convenience that must never be required for the page to render. */
function useOptionalColumns(): [ReadonlySet<OptionalColumn>, (id: OptionalColumn) => void] {
  const [shown, setShown] = React.useState<ReadonlySet<OptionalColumn>>(() => {
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(COLUMNS_STORAGE_KEY) ?? '[]')
      const known = new Set<string>(OPTIONAL_COLUMNS.map((column) => column.id))
      return new Set(
        Array.isArray(raw) ? raw.filter((id): id is OptionalColumn => typeof id === 'string' && known.has(id)) : [],
      )
    } catch {
      return new Set()
    }
  })
  const toggle = (id: OptionalColumn) =>
    setShown((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      try {
        localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify([...next]))
      } catch {
        // Private window or blocked storage: the choice simply lasts for this visit.
      }
      return next
    })
  return [shown, toggle]
}

export function GlobalTasksRoute() {
  const projects = useProjects()
  // The same host gate the per-project table honours: `CEZ_HIDE_COST` and friends turn these
  // columns off everywhere, and a cross-project view is not an exception.
  const metrics = usageMetricVisibility(useHealth().data)
  // Always enabled here — unlike the ⌘K palette, which parks it in a single-project workspace:
  // this page IS the index, so there is nothing else for it to fall back to. The interval is this
  // page's alone (see `useRunsIndex`), and it is now a BACKSTOP rather than the mechanism: any
  // project's run event invalidates this index through the one workspace stream, so a task that
  // is renamed or finishes while you watch updates on its own.
  const index = useRunsIndex(true, RUNS_INDEX_POLL_MS)
  // The URL is the state, not a mirror of it: read here, written by the setters below. One
  // source of truth means a refresh, a pasted link and the Back button all land on the same
  // filtered view, with no effect syncing two copies that can disagree.
  const [searchParams, setSearchParams] = useSearchParams()
  const { filters, groupBy, view } = React.useMemo(
    () => urlStateFromSearchParams(searchParams),
    [searchParams],
  )
  // …and the Active/Archived split is published to the SHARED filter context, one way. That
  // context is what keeps this page, the per-project table and the sidebar quick-list answering
  // one question; here the URL is the authority, so the context follows it rather than the other
  // way round. Nothing else on this route can change it — the multi-project sidebar's groups
  // only READ the view — so there is no loop to break.
  const [sharedView, setSharedView] = useListView()
  React.useEffect(() => {
    if (sharedView !== view) setSharedView(view)
  }, [view, sharedView, setSharedView])
  const now = useNow(30_000)
  const [optionalColumns, toggleOptionalColumn] = useOptionalColumns()

  /**
   * `replace`, always: filtering is one continuous gesture, and a history entry per click would
   * turn Back into "undo one chip" instead of "leave this page".
   *
   * The whole state is re-decoded from the params INSIDE the updater rather than read from this
   * render's closure, so two changes landing in one tick compose instead of the second silently
   * reverting the first.
   */
  const commit = (next: (current: GlobalTasksUrlState) => GlobalTasksUrlState) =>
    setSearchParams((current) => urlStateToSearchParams(next(urlStateFromSearchParams(current))), {
      replace: true,
    })
  const setFilters = (next: (current: GlobalTaskFilters) => GlobalTaskFilters) =>
    commit((state) => ({ ...state, filters: next(state.filters) }))
  const setGroupBy = (groupBy: GroupBy) => commit((state) => ({ ...state, groupBy }))
  const setView = (nextView: ListView) => commit((state) => ({ ...state, view: nextView }))

  /**
   * The search box types locally and reaches the URL on a delay.
   *
   * Every other control writes the URL on the click that changed it, which is exactly right for
   * a discrete gesture. A text field is not discrete: writing per keystroke means a
   * `history.replaceState` per keystroke, and browsers rate-limit that (Safari drops calls past
   * ~100 in 30s) — so a fast typist's URL would silently stop tracking the box.
   *
   * The guard is what keeps two copies of one string honest: the URL is adopted back into the
   * draft only when it changed for a reason that is NOT this input — Back, a pasted link, Clear
   * filters — never when it is simply catching up to what was typed. Without it, a flush landing
   * mid-word would overwrite the characters typed since.
   */
  const [queryDraft, setQueryDraft] = React.useState(filters.query)
  // The subtask accordion (#1110), same contract as the per-project table: collapsed by default,
  // the parent row's chip is the handle. Held at page level and keyed by run id so regrouping or
  // refiltering re-buckets the rows without forgetting which parents were open. A live search
  // overrides the fold wholesale — a match must never hide under a collapsed parent.
  const [expandedSubtasks, setExpandedSubtasks] = React.useState<ReadonlySet<string>>(new Set())
  const toggleSubtasks = (id: string) =>
    setExpandedSubtasks((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  const searching = filters.query.trim() !== ''
  const isSubtasksExpanded = (id: string) => searching || expandedSubtasks.has(id)
  const sentQuery = React.useRef(filters.query)
  React.useEffect(() => {
    if (filters.query !== sentQuery.current) setQueryDraft(filters.query)
    sentQuery.current = filters.query
  }, [filters.query])
  React.useEffect(() => {
    if (queryDraft === sentQuery.current) return
    const timer = setTimeout(() => {
      sentQuery.current = queryDraft
      setFilters((current) => ({ ...current, query: queryDraft }))
    }, QUERY_DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // `setFilters` is re-created every render (it closes over `setSearchParams` only, which is
    // stable) — depending on it would restart the timer on every render and never fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryDraft])

  // Statuses the server already had, riding along with the rows that carry the references — so
  // the chips are coloured in the SAME paint as the table rather than a round trip later. Cold
  // references are simply absent here; `ReferenceStatusProvider` below still asks for those.
  const indexedStatuses = index.data?.referenceStatuses
  React.useEffect(() => {
    if (indexedStatuses) rememberReferenceStatuses(indexedStatuses)
  }, [indexedStatuses])
  const registry = React.useMemo(() => projects.data?.projects ?? [], [projects.data])
  const tasks = React.useMemo(
    () => toGlobalTasks(index.data?.runs ?? [], registry),
    [index.data, registry],
  )
  const visible = React.useMemo(
    () => filterGlobalTasks(tasks, filters, view),
    [tasks, filters, view],
  )
  const groups = React.useMemo(() => groupGlobalTasks(visible, groupBy), [visible, groupBy])
  /**
   * Every tracker reference on screen, asked about ONCE.
   *
   * Collected here rather than per row for the obvious reason — a row-level hook would be a
   * request per chip, and this page routinely paints hundreds — and for a less obvious one: the
   * batching is per PROJECT, and only this level can see that forty rows belong to six repos.
   * A row that arrives after the cap, or whose forge is unreachable, keeps the neutral chip it
   * had before statuses existed.
   */
  const referenceRequests = React.useMemo(
    () =>
      visible.flatMap((task) =>
        taskReferences(task.run, task.project?.repoUrl).map((reference) => ({
          projectId: task.run.projectId,
          kind: reference.kind,
          number: reference.number,
        })),
      ),
    [visible],
  )
  const truncated = truncatedProjectNames(index.data?.truncated ?? [], registry)

  const toggle = (facet: FacetId, value: string) =>
    setFilters((current) => ({ ...current, [facet]: toggleFacetValue(current[facet], value) }))
  const clearFacet = (facet: FacetId) => setFilters((current) => ({ ...current, [facet]: [] }))
  const archive = useArchiveIndexedRun()
  const setRead = useReadIndexedRun()

  if (index.isError || projects.isError) {
    return (
      <Page data-route="global-tasks">
        <PageHeader title="All tasks" description="Work across every project in this workspace." />
        <PageBody>
          <ListEmpty
            icon={<LayersIcon />}
            tone="danger"
            title="Tasks across projects did not load"
            description={(index.error ?? projects.error)?.message}
          />
        </PageBody>
      </Page>
    )
  }

  const clearAll = () => {
    setQueryDraft('')
    // Filters AND grouping — "Clear all" is the one way back to a plain list.
    commit((state) => ({ ...state, filters: NO_FILTERS, groupBy: 'none' }))
  }
  // The host gate decides whether Cost may be offered at all.
  const offered = OPTIONAL_COLUMNS.filter((column) => column.id !== 'cost' || metrics.cost)
  const extraColumns = offered.filter((column) => optionalColumns.has(column.id)).map((column) => column.id)

  return (
    <Page data-route="global-tasks">
      <GlobalTasksSidebar
        view={view}
        onViewChange={setView}
        groupBy={groupBy}
        onGroupByChange={setGroupBy}
        filters={filters}
        onToggle={toggle}
        onClear={hasActiveFilters(filters) || groupBy !== 'none' ? clearAll : undefined}
        projects={registry}
        tasks={tasks}
        shown={visible.length}
      />
      <PageHeader title="All tasks" description="Work across every project in this workspace." />

      <PageToolbar>
        {/* From `md` up these three live in the contextual sidebar; a phone keeps them here. */}
        <div className="contents md:hidden">
          <ListViewTabs view={view} onChange={setView} />
          <FilterMenu filters={filters} onToggle={toggle} projects={registry} tasks={tasks} view={view} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" data-slot="group-by" aria-label="Group tasks by">
                <Rows3Icon aria-hidden="true" />
                {groupBy === 'none' ? (
                  'Group'
                ) : (
                  <>
                    <span className="text-muted-foreground">Group:</span>
                    {GROUP_BY_OPTIONS.find((option) => option.value === groupBy)?.label}
                  </>
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-44">
              <DropdownMenuLabel>Group by</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={groupBy} onValueChange={(next) => setGroupBy(next as GroupBy)}>
                <DropdownMenuRadioItem value="none">None</DropdownMenuRadioItem>
                {GROUP_BY_OPTIONS.map((option) => (
                  <DropdownMenuRadioItem key={option.value} value={option.value} data-value={option.value}>
                    {option.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="flex-1" />
        <span data-slot="global-tasks-count" className="hidden text-[13px] text-muted-foreground tabular-nums sm:inline">
          {visible.length} of {tasks.length}
        </span>
        <ListSearch
          value={queryDraft}
          onChange={setQueryDraft}
          placeholder="Search every project…"
          label="Search tasks across projects"
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" data-slot="display-menu" className="hidden md:inline-flex">
              <SlidersHorizontalIcon aria-hidden="true" />
              Display
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuLabel>Columns</DropdownMenuLabel>
            {offered.map((column) => (
              <DropdownMenuCheckboxItem
                key={column.id}
                data-column-id={column.id}
                checked={optionalColumns.has(column.id)}
                onCheckedChange={() => toggleOptionalColumn(column.id)}
                onSelect={(event) => event.preventDefault()}
              >
                {column.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </PageToolbar>

      <PageBody className="flex flex-col gap-4">
        <ActiveFilters
          filters={filters}
          groupBy={groupBy}
          onRemove={toggle}
          onClearQuery={() => {
            setQueryDraft('')
            setFilters((current) => ({ ...current, query: '' }))
          }}
          onClearAll={clearAll}
        />

        {truncated.length > 0 ? (
          <p data-slot="global-tasks-truncated" className="text-[13px] text-muted-foreground">
            Showing the newest {index.data?.perProjectLimit} tasks per project — older ones in{' '}
            {truncated.join(', ')} are only in that project&rsquo;s own Tasks page.
          </p>
        ) : null}

        {index.data === undefined ? (
          <ListFrame aria-busy="true" className="divide-y divide-border">
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
        ) : visible.length === 0 ? (
          <GlobalTasksEmptyState
            view={view}
            filtered={hasActiveFilters(filters)}
            onClear={canReset({ filters, groupBy }) ? clearAll : undefined}
          />
        ) : (
          // No `projectId` on the provider, uniquely on this page: every chip under it names its
          // own, because the rows next to each other belong to different repositories.
          <ReferenceStatusProvider requests={referenceRequests}>
            <div className="flex flex-col gap-8">
              {groups.map((group) => (
                <section key={group.key} data-slot="task-group" data-group-key={group.key} className="space-y-3">
                  {groupBy === 'none' ? null : (
                    <h2 className="flex items-baseline gap-2 text-[15px] font-semibold text-foreground">
                      {/* A project heading is a DOOR, not a label: that project's own Tasks page
                          is the better version of "just this project". */}
                      {groupBy === 'project' ? (
                        <Link
                          to={scopeTo(group.key, '/')}
                          data-slot="group-project-link"
                          className="underline-offset-4 hover:underline"
                        >
                          {group.label}
                        </Link>
                      ) : groupBy === 'status' ? (
                        sentenceCase(group.label)
                      ) : (
                        group.label
                      )}
                      <span className="text-[13px] font-normal text-muted-foreground tabular-nums">
                        {group.tasks.length}
                      </span>
                    </h2>
                  )}
                  <TaskTable
                    tasks={group.tasks}
                    now={now}
                    isSubtasksExpanded={isSubtasksExpanded}
                    onToggleSubtasks={toggleSubtasks}
                    showProject={groupBy !== 'project'}
                    onArchive={(task, archived) => archive.mutate({ task, archived })}
                    onSetRead={(task, read) => setRead.mutate({ task, read })}
                    busy={archive.isPending || setRead.isPending}
                    extraColumns={extraColumns}
                  />
                </section>
              ))}
            </div>
          </ReferenceStatusProvider>
        )}
      </PageBody>
    </Page>
  )
}

/**
 * What each filter option would leave, counted against the list as the OTHER facets narrow it.
 * One `tasksExcludingFacet` per facet: the counts a facet shows must not already assume that
 * facet's own ticks, or unticking a value would promise fewer rows than it delivers.
 */
function useFacetCounts(tasks: readonly GlobalTask[], filters: GlobalTaskFilters, view: ListView) {
  return React.useMemo(() => {
    const per = (facet: FacetId, valueOf: (task: GlobalTask) => readonly string[]) =>
      facetCounts(tasksExcludingFacet(tasks, filters, view, facet), valueOf)
    return {
      tags: per('tags', tagValuesOf),
      statuses: per('statuses', (task) => [task.run.status]),
      workflows: per('workflows', (task) => [task.run.workflow]),
    }
  }, [tasks, filters, view])
}

/**
 * All tasks' contextual sidebar: how the cross-project list is cut. Active | Archived, the
 * grouping, the three facets as tickable rows with live counts, and the projects themselves —
 * as links, not a filter, because one project's tasks are that project's own Tasks page.
 * Everything here writes the same URL state the page reads, so it is the toolbar's controls in
 * a roomier place rather than a second copy of them.
 */
function GlobalTasksSidebar({
  view,
  onViewChange,
  groupBy,
  onGroupByChange,
  filters,
  onToggle,
  onClear,
  projects,
  tasks,
  shown,
}: {
  view: ListView
  onViewChange: (view: ListView) => void
  groupBy: GroupBy
  onGroupByChange: (groupBy: GroupBy) => void
  filters: GlobalTaskFilters
  onToggle: (facet: FacetId, value: string) => void
  /** Present only while a filter or a grouping is on. */
  onClear?: () => void
  projects: readonly ProjectListEntry[]
  tasks: readonly GlobalTask[]
  /** How many rows the current cut leaves. */
  shown: number
}) {
  const globalSettings = useGlobalSettings()
  const tags = React.useMemo(() => allProjectTags(projects), [projects])
  const counts = useFacetCounts(tasks, filters, view)
  const perProject = React.useMemo(() => {
    const map = new Map<string, number>()
    for (const task of filterGlobalTasks(tasks, NO_FILTERS, view)) {
      map.set(task.run.projectId, (map.get(task.run.projectId) ?? 0) + 1)
    }
    return map
  }, [tasks, view])
  const tagChecked = (tag: string) => filters.tags.some((picked) => picked.toLowerCase() === tag.toLowerCase())

  return (
    <ContextSidebar>
      <SidebarHeader className="gap-3 p-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="px-1 text-[15px] font-semibold text-foreground">All tasks</h2>
          <span className="px-1 text-xs text-muted-foreground tabular-nums">
            {shown} of {tasks.length}
          </span>
        </div>
        <Tabs value={view} onValueChange={(next) => onViewChange(next as ListView)}>
          <TabsList className="w-full">
            <TabsTrigger value="active">Active</TabsTrigger>
            <TabsTrigger value="archived">Archived</TabsTrigger>
          </TabsList>
        </Tabs>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="pt-0">
          <SidebarGroupLabel>Group by</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {[{ value: 'none' as GroupBy, label: 'None' }, ...GROUP_BY_OPTIONS].map((option) => (
                <SidebarMenuItem key={option.value}>
                  <SidebarMenuButton
                    isActive={groupBy === option.value}
                    aria-pressed={groupBy === option.value}
                    data-slot="sidebar-group-by"
                    data-value={option.value}
                    onClick={() => onGroupByChange(option.value)}
                  >
                    <span>{option.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <FacetGroup
          label="Status"
          options={allStatuses(tasks).map((status) => ({
            value: status,
            label: sentenceCase(status),
            count: counts.statuses.get(status) ?? 0,
            checked: filters.statuses.includes(status),
          }))}
          onToggle={(value) => onToggle('statuses', value)}
        />
        <FacetGroup
          label="Workflow"
          options={allWorkflows(tasks).map((workflow) => ({
            value: workflow,
            label: workflow,
            count: counts.workflows.get(workflow) ?? 0,
            checked: filters.workflows.includes(workflow),
          }))}
          onToggle={(value) => onToggle('workflows', value)}
        />
        <FacetGroup
          label="Tag"
          options={
            tags.length === 0
              ? []
              : [
                  ...tags.map((tag) => ({
                    value: tag,
                    label: tag,
                    count: counts.tags.get(tag) ?? 0,
                    checked: tagChecked(tag),
                  })),
                  {
                    value: UNTAGGED,
                    label: 'Untagged',
                    count: counts.tags.get(UNTAGGED) ?? 0,
                    checked: filters.tags.includes(UNTAGGED),
                  },
                ]
          }
          onToggle={(value) => onToggle('tags', value)}
          empty={
            <button
              type="button"
              onClick={() => globalSettings.open('projects')}
              className="px-2 text-left text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              Tag your projects to filter and group by tag
            </button>
          }
        />

        <SidebarGroup>
          <SidebarGroupLabel>Projects</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {projects.map((project) => (
                <SidebarMenuItem key={project.id}>
                  <SidebarMenuButton asChild title={`Open ${project.name}'s tasks`}>
                    <Link to={scopeTo(project.id, '/')}>
                      <FolderGit2Icon aria-hidden="true" />
                      <span>{project.name}</span>
                    </Link>
                  </SidebarMenuButton>
                  <SidebarMenuBadge>{perProject.get(project.id) ?? 0}</SidebarMenuBadge>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      {onClear ? (
        <SidebarFooter className="border-t border-border/70 p-3">
          <Button variant="outline" size="sm" onClick={onClear}>
            Clear filters and grouping
          </Button>
        </SidebarFooter>
      ) : null}
    </ContextSidebar>
  )
}

/** One facet as a group of tickable rows; an option that would leave nothing dims. */
function FacetGroup({
  label,
  options,
  onToggle,
  empty,
}: {
  label: string
  options: readonly { value: string; label: string; count: number; checked: boolean }[]
  onToggle: (value: string) => void
  /** Shown instead of the rows when the facet has no options at all. */
  empty?: React.ReactNode
}) {
  if (options.length === 0 && !empty) return null
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        {options.length === 0 ? (
          empty
        ) : (
          <SidebarMenu>
            {options.map((option) => (
              <SidebarMenuItem key={option.value}>
                <SidebarMenuButton
                  role="checkbox"
                  aria-checked={option.checked}
                  data-slot="sidebar-facet-option"
                  data-facet={label.toLowerCase()}
                  onClick={() => onToggle(option.value)}
                  className={cn(option.count === 0 && !option.checked && 'text-muted-foreground')}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'flex size-4 shrink-0 items-center justify-center rounded-[5px] border border-input bg-card',
                      option.checked && 'border-contrast bg-contrast text-contrast-foreground',
                    )}
                  >
                    {option.checked ? <CheckIcon className="size-3" /> : null}
                  </span>
                  <span>{option.label}</span>
                </SidebarMenuButton>
                <SidebarMenuBadge>{option.count}</SidebarMenuBadge>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        )}
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

/**
 * The filters, behind one button.
 *
 * Every option carries the number of rows it would leave, counted against the list as the OTHER
 * facets narrow it — so a filter that would empty the table says so before it is clicked. Status
 * and workflow options are derived from the tasks ACTUALLY on the page; tags come from the
 * registry, because a tag on a project with no tasks yet is still the answer to "which repos are
 * in this group?". No project facet, deliberately — narrowing to one project is that project's
 * own Tasks page, which every project name here links to.
 */
function FilterMenu({
  filters,
  onToggle,
  projects,
  tasks,
  view,
}: {
  filters: GlobalTaskFilters
  onToggle: (facet: FacetId, value: string) => void
  projects: readonly ProjectListEntry[]
  tasks: readonly GlobalTask[]
  view: ListView
}) {
  const globalSettings = useGlobalSettings()
  const tags = React.useMemo(() => allProjectTags(projects), [projects])
  const counts = useFacetCounts(tasks, filters, view)

  const tagChecked = (tag: string) => filters.tags.some((picked) => picked.toLowerCase() === tag.toLowerCase())

  return (
    <div data-slot="global-tasks-filters" className="contents">
      <FacetMenu
        activeCount={filters.statuses.length + filters.workflows.length + filters.tags.length}
        emptyLabel="No tasks to filter"
        groups={[
          {
            id: 'status',
            label: 'Status',
            onToggle: (value) => onToggle('statuses', value),
            options: allStatuses(tasks).map((status) => ({
              value: status,
              label: sentenceCase(status),
              count: counts.statuses.get(status) ?? 0,
              checked: filters.statuses.includes(status),
            })),
          },
          {
            id: 'workflow',
            label: 'Workflow',
            onToggle: (value) => onToggle('workflows', value),
            options: allWorkflows(tasks).map((workflow) => ({
              value: workflow,
              label: workflow,
              count: counts.workflows.get(workflow) ?? 0,
              checked: filters.workflows.includes(workflow),
            })),
          },
          {
            id: 'tag',
            label: 'Tag',
            onToggle: (value) => onToggle('tags', value),
            // "Untagged" last, and only once tags exist: "which repos still need labelling?".
            options:
              tags.length === 0
                ? []
                : [
                    ...tags.map((tag) => ({
                      value: tag,
                      label: tag,
                      count: counts.tags.get(tag) ?? 0,
                      checked: tagChecked(tag),
                    })),
                    {
                      value: UNTAGGED,
                      label: 'Untagged',
                      count: counts.tags.get(UNTAGGED) ?? 0,
                      checked: filters.tags.includes(UNTAGGED),
                    },
                  ],
          },
        ]}
        footer={
          tags.length === 0 ? (
            // A workspace with no tags anywhere is the ONE state where the feature is invisible.
            <p data-slot="no-tags-hint">
              Tag connected repositories in{' '}
              <button
                type="button"
                onClick={() => globalSettings.open('projects')}
                className="font-medium text-foreground underline underline-offset-4"
              >
                Settings → Projects
              </button>{' '}
              to filter and group their tasks here.
            </p>
          ) : undefined
        }
      />
    </div>
  )
}

/** What is narrowing the list right now, each piece removable on its own. */
function ActiveFilters({
  filters,
  groupBy,
  onRemove,
  onClearQuery,
  onClearAll,
}: {
  filters: GlobalTaskFilters
  groupBy: GroupBy
  onRemove: (facet: FacetId, value: string) => void
  onClearQuery: () => void
  onClearAll: () => void
}) {
  if (!hasActiveFilters(filters)) return null
  const chips: { key: string; label: string; value: string; onRemove: () => void }[] = [
    ...filters.statuses.map((value) => ({
      key: `status:${value}`,
      label: 'Status',
      value: sentenceCase(value),
      onRemove: () => onRemove('statuses', value),
    })),
    ...filters.workflows.map((value) => ({
      key: `workflow:${value}`,
      label: 'Workflow',
      value,
      onRemove: () => onRemove('workflows', value),
    })),
    ...filters.tags.map((value) => ({
      key: `tag:${value}`,
      label: 'Tag',
      value: value === UNTAGGED ? 'Untagged' : value,
      onRemove: () => onRemove('tags', value),
    })),
    ...(filters.query.trim()
      ? [{ key: 'query', label: 'Search', value: `“${filters.query.trim()}”`, onRemove: onClearQuery }]
      : []),
  ]
  return (
    <div data-slot="active-filters" className="flex flex-wrap items-center gap-1.5">
      {chips.map((chip) => (
        <Badge
          key={chip.key}
          variant="secondary"
          data-slot="active-filter"
          data-filter={chip.key}
          className="h-7 gap-1 py-0 pr-1 pl-2.5 text-[13px] font-normal"
        >
          <span className="text-muted-foreground">{chip.label}</span>
          <span className="max-w-40 truncate font-medium">{chip.value}</span>
          <button
            type="button"
            aria-label={`Remove ${chip.label.toLowerCase()} filter ${chip.value}`}
            onClick={chip.onRemove}
            className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <XIcon className="size-3" aria-hidden="true" />
          </button>
        </Badge>
      ))}
      {canReset({ filters, groupBy }) ? (
        <Button variant="ghost" size="sm" data-action="clear-filters" onClick={onClearAll} className="h-7">
          Clear all
        </Button>
      ) : null}
    </div>
  )
}

/**
 * Who dispatched this row's task, when the wire says (spec `.ai/specs/2026-09-10-dispatch.md`).
 *
 * Read through a cast because `RunIndexEntry` — the deliberately SLIM cross-project row — does
 * not carry `dispatch` today, so this page currently nests nothing and every row is a root, which
 * is the honest rendering of a wire that does not say otherwise. The read is here rather than
 * absent so that the day the index grows the field, this list nests exactly like the per-project
 * table without a second nesting rule being written for it.
 */
const dispatchOf = (run: RunIndexEntry): TaskTreeInput['dispatch'] =>
  (run as { dispatch?: TaskTreeInput['dispatch'] }).dispatch

/** The rows. One table per group, so a group heading owns its own header row. */
function TaskTable({
  tasks,
  now,
  isSubtasksExpanded,
  onToggleSubtasks,
  showProject,
  onArchive,
  onSetRead,
  busy,
  extraColumns,
}: {
  tasks: readonly GlobalTask[]
  now: number
  /** The page-level accordion (#1110): whether a parent's dispatched rows are unfolded. */
  isSubtasksExpanded: (id: string) => boolean
  onToggleSubtasks: (id: string) => void
  showProject: boolean
  onArchive: (task: GlobalTask, archived: boolean) => void
  onSetRead: (task: GlobalTask, read: boolean) => void
  busy: boolean
  /** The optional columns the Display menu has switched on, in table order. */
  extraColumns: readonly OptionalColumn[]
}) {
  return (
    <ListFrame data-slot="global-tasks-table">
      <TooltipProvider>
        <Table>
          <TableHeader>
            {/* Task is the only column with no width, so it grows on what the others give up: a
                cross-project list is scanned by title. */}
            <TableRow className="hover:bg-transparent">
              <TableHead className={cn(LIST_HEAD_CLASS, 'hidden w-[150px] md:table-cell')}>Status</TableHead>
              <TableHead className={LIST_HEAD_CLASS}>Task</TableHead>
              {extraColumns.map((id) => (
                <TableHead key={id} className={cn(LIST_HEAD_CLASS, 'hidden text-right md:table-cell')}>
                  {OPTIONAL_COLUMNS.find((column) => column.id === id)?.label}
                </TableHead>
              ))}
              <TableHead className={cn(LIST_HEAD_CLASS, 'text-right')}>Started</TableHead>
              <TableHead className={cn(LIST_HEAD_CLASS, 'w-[84px]')}>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {/* Dispatched children nest under the task that ordered them. Per TABLE, which is
                per group: a child grouped away from its parent stands on its own. */}
            {taskTreeRows(
              tasks.map((task) => ({
                id: task.run.id,
                dispatch: dispatchOf(task.run),
                task,
              })),
              isSubtasksExpanded,
            ).map((node) => (
              <TaskRow
                key={`${node.run.task.run.projectId}/${node.run.task.run.id}`}
                task={node.run.task}
                depth={node.depth}
                childCount={node.childCount}
                subtasksExpanded={isSubtasksExpanded(node.run.id)}
                onToggleSubtasks={onToggleSubtasks}
                now={now}
                showProject={showProject}
                onArchive={onArchive}
                onSetRead={onSetRead}
                busy={busy}
                extraColumns={extraColumns}
              />
            ))}
          </TableBody>
        </Table>
      </TooltipProvider>
    </ListFrame>
  )
}

/**
 * One cross-project run.
 *
 * The title is a real `<Link>` — a plain router one, explicitly scoped with `scopeTo`: this page
 * renders outside every `/p/:projectId`, and each row points at a DIFFERENT project anyway.
 */
function TaskRow({
  task,
  depth,
  childCount,
  subtasksExpanded,
  onToggleSubtasks,
  now,
  showProject,
  onArchive,
  onSetRead,
  busy,
  extraColumns,
}: {
  task: GlobalTask
  /** Nesting level under the task that dispatched this one; 0 for a top-level row. */
  depth: number
  /** How many tasks THIS one dispatched — the row's "N subtasks" handle. */
  childCount: number
  /** Whether this row's dispatched children are unfolded beneath it (#1110). */
  subtasksExpanded: boolean
  onToggleSubtasks: (id: string) => void
  now: number
  showProject: boolean
  onArchive: (task: GlobalTask, archived: boolean) => void
  onSetRead: (task: GlobalTask, read: boolean) => void
  busy: boolean
  extraColumns: readonly OptionalColumn[]
}) {
  const { run } = task
  const attention = deriveAttention(run)
  const to = scopeTo(run.projectId, `/tasks/${run.id}`)
  const unread = isUnread(run)
  const readDone = isReadDoneItem(run)
  // The SAME rule every other surface applies (#407, #526). Plural here because a task genuinely
  // has several references; the project's own repo root is what makes one known only by NUMBER
  // clickable, which is why the registry entry carries `repoUrl`.
  const references = taskReferences(run, task.project?.repoUrl)
  const subtasks = subtaskLabel(childCount)
  // The live sample rides the index row itself (`run.usage`, attached server-side per poll): the
  // run event stream is project-scoped and cannot reach forty projects at once.
  const usage = usageCells(run, run.usage)
  const kind = dispatchKindLabel(run)

  return (
    <TableRow
      data-slot="global-task-row"
      data-run-id={run.id}
      data-project={run.projectId}
      data-depth={depth}
      className="group/row"
    >
      <TableCell className={cn(LIST_CELL_CLASS, 'hidden md:table-cell')}>
        <TaskStatusBadge attention={attention} />
      </TableCell>
      <TableCell className={cn(LIST_CELL_CLASS, 'w-full max-w-0 min-w-[200px] md:min-w-[320px]')}>
        {/* Inline padding, not a class: depth is unbounded. 14px a level — the same step the
            per-project table and the sidebar use. */}
        <div
          className="flex min-w-0 flex-col gap-0.5"
          style={depth > 0 ? { paddingLeft: `${depth * 14}px` } : undefined}
        >
          <div className="flex min-w-0 items-center gap-2">
            {depth > 0 ? (
              <span
                aria-hidden="true"
                data-slot="subtask-tick"
                className="shrink-0 font-mono text-xs leading-none text-soft-foreground"
              >
                &#9492;
              </span>
            ) : null}
            <Link
              to={to}
              title={runTitle(run)}
              className={cn(
                'min-w-0 truncate text-sm',
                unread
                  ? 'font-semibold text-foreground'
                  : readDone
                    ? 'font-medium text-muted-foreground'
                    : 'font-medium text-foreground',
              )}
            >
              {runTitle(run)}
            </Link>
            {unread ? (
              <StatusDot
                tone="violet"
                role="img"
                aria-label="unread"
                title="Unread — not opened since it finished"
                className="shrink-0"
              />
            ) : null}
            {/* What a DISPATCHED row is for — `review` or `implement`. Null on every root. */}
            {kind ? (
              <Badge
                variant="secondary"
                data-slot="dispatch-kind"
                className="h-5 px-1.5 font-normal text-muted-foreground"
              >
                {kind}
              </Badge>
            ) : null}
            {subtasks ? (
              <SubtaskToggle
                label={subtasks}
                expanded={subtasksExpanded}
                onToggle={() => onToggleSubtasks(run.id)}
              />
            ) : null}
          </div>
          <div
            data-slot="task-details"
            className={cn(
              'flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-muted-foreground',
              depth > 0 && 'pl-5',
            )}
          >
            {/* Below `md` the Status column folds into this line. */}
            <TaskStatusBadge attention={attention} className="mr-1 md:hidden" />
            {showProject ? (
              <>
                <Link to={scopeTo(run.projectId, '/')} className="truncate hover:text-foreground hover:underline">
                  {task.projectName}
                </Link>
                <span aria-hidden="true" className="text-soft-foreground">
                  ·
                </span>
              </>
            ) : null}
            <span className="truncate">{run.workflow}</span>
            {task.tags.map((tag) => (
              <TagChip key={tag} tag={tag} />
            ))}
            {references.length > 0 ? <ReferenceChips references={references} run={run} /> : null}
          </div>
        </div>
      </TableCell>
      {extraColumns.map((id) =>
        id === 'cost' ? (
          <TableCell
            key={id}
            className={cn(LIST_CELL_CLASS, 'hidden text-right text-[13px] text-muted-foreground tabular-nums md:table-cell')}
          >
            {formatCost(run.costUsd) || <Dash />}
          </TableCell>
        ) : (
          <UsageTd key={id} column={id} cell={id === 'cpu' ? usage.cpu : usage.mem} />
        ),
      )}
      <TableCell className={cn(LIST_CELL_CLASS, 'text-right text-[13px] text-muted-foreground tabular-nums')}>
        {shortAge(run.startedAt ?? run.createdAt, now)}
      </TableCell>
      <TableCell className={cn(LIST_CELL_CLASS, 'text-right')}>
        {/* Revealed on hover so a resting list stays quiet; always there without a pointer. */}
        <span className="inline-flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100 no-hover:opacity-100">
          <ReadToggle task={task} busy={busy} onSetRead={onSetRead} />
          <ArchiveToggle task={task} busy={busy} onArchive={onArchive} />
        </span>
      </TableCell>
    </TableRow>
  )
}

/**
 * Mark one row read or unread — an open eye to stamp the receipt, a closed one to take it back.
 *
 * Offered only where a read state EXISTS: `canBeUnread` is the same decider behind the unread dot
 * itself, so the button appears on exactly the rows that can wear one — finished, not archived,
 * not a task merely waiting out a usage limit. A running task has nothing to have read yet, and a
 * button that did nothing would say otherwise.
 *
 * The icon shows the ACTION, not the state: unread rows offer the open eye ("mark read"), read
 * ones the closed eye ("mark unread"). The state is already visible a few columns left, as the
 * violet dot beside the title.
 */
function ReadToggle({
  task,
  busy,
  onSetRead,
}: {
  task: GlobalTask
  busy: boolean
  onSetRead: (task: GlobalTask, read: boolean) => void
}) {
  if (!canBeUnread(task.run)) return null
  const unread = isUnread(task.run)
  const title = runTitle(task.run)
  const label = unread ? `Mark ${title} read` : `Mark ${title} unread`
  const Icon = unread ? EyeIcon : EyeOffIcon
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-action={unread ? 'mark-read' : 'mark-unread'}
          aria-label={label}
          disabled={busy}
          onClick={() => onSetRead(task, unread)}
          className={cn(
            'inline-flex size-7 items-center justify-center rounded-sm transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-wait disabled:opacity-50',
            unread ? 'text-violet' : 'text-muted-foreground',
          )}
        >
          <Icon className="size-3.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">{unread ? 'Mark read' : 'Mark unread'}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Archive / restore one row, without leaving the page.
 *
 * Per-row rather than the per-project table's count-gated "Archive finished" broom: a sweep that
 * crossed project boundaries would be one click firing N writes into N repos, and "finished" is a
 * judgement each project's own page is better placed to make. One row, one deliberate click.
 *
 * The button only exists for a run that is actually FINISHED (or already archived). Archiving
 * something still running would be answered by the server anyway, but offering it invites the
 * question of whether it also cancels — which it does not.
 */
function ArchiveToggle({
  task,
  busy,
  onArchive,
}: {
  task: GlobalTask
  busy: boolean
  onArchive: (task: GlobalTask, archived: boolean) => void
}) {
  const archived = task.run.archived
  if (!archived && !ARCHIVABLE_STATUSES.has(task.run.status)) return null
  const label = archived
    ? `Restore ${runTitle(task.run)} to the active list`
    : `Archive ${runTitle(task.run)}`
  const Icon = archived ? ArchiveRestoreIcon : ArchiveIcon
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-action={archived ? 'unarchive-run' : 'archive-run'}
          aria-label={label}
          disabled={busy}
          onClick={() => onArchive(task, !archived)}
          className="inline-flex size-7 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-wait disabled:opacity-50"
        >
          <Icon className="size-3.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">{archived ? 'Restore' : 'Archive'}</TooltipContent>
    </Tooltip>
  )
}

/**
 * A task's tracker references — all of them.
 *
 * Bounded rather than unbounded: `taskReferences` reads only real fields (never the transcript
 * candidate lists, see #526) so three is already a lot, but a table cell must not be able to
 * grow without limit on one odd record. Past the cap the rest collapse into a `+N` that NAMES
 * them in its tooltip, so nothing becomes invisible — it only stops taking vertical space.
 */
function ReferenceChips({
  references,
  run,
}: {
  references: readonly TaskReference[]
  run: RunIndexEntry
}) {
  const shown = references.slice(0, MAX_VISIBLE_REFERENCES)
  const hidden = references.length - shown.length
  const title = runTitle(run)
  return (
    // `flex-nowrap` and `shrink-0`, both load-bearing: wrapping put the chips on two lines AND
    // broke `Issue #5119` across its own fixed-height pill, so the text sat outside the border.
    // A reference is one atom — it either fits on the row or it moves into the `+N` popover.
    <span className="flex flex-nowrap items-center gap-1">
      {shown.map((reference) => (
        <ReferenceChip
          key={`${reference.kind}#${reference.number}`}
          reference={reference}
          taskTitle={title}
          // Named per chip HERE and nowhere else: this page's rows come from different projects,
          // and two of them may each have a #42.
          projectId={run.projectId}
          // Same panel, same button, same prompt as the task's own page. The run record it needs
          // is fetched by the action itself, and only once the panel is open — this page's index
          // row is deliberately too slim to answer whether the task can be reopened.
          conflictAction={
            <ResolveConflictsForRun
              projectId={run.projectId}
              runId={run.id}
              prNumber={reference.number}
            />
          }
          className="h-5 shrink-0"
        />
      ))}
      {hidden > 0 ? (
        <ReferenceOverflow
          references={references}
          taskTitle={title}
          hidden={hidden}
          projectId={run.projectId}
        />
      ) : null}
    </span>
  )
}

/**
 * The `+N`, opened.
 *
 * A tooltip listing the hidden references told you they existed and then refused to let you go
 * to them — which is worse than not mentioning them. This is a popover of real links instead.
 *
 * It opens on HOVER where hovering exists and on click everywhere — including touch, which has no
 * hover, and the keyboard, where the trigger is a real button. Radix's HoverCard would have given
 * the first for free but not the other two: it is explicitly not a touch affordance. So this is a
 * Popover (click-and-keyboard by construction) with hover layered on, which is the combination
 * that leaves no input method without a way in.
 *
 * It lists EVERY reference, not only the hidden ones: at the moment you open it you are asking
 * "what does this task point at?", and answering with the leftovers would make you reassemble
 * the set from two places. The rows are `ReferenceChip`s, so the http-only guard, the accessible
 * names and the `target`/`rel` handling are the same ones every other reference link uses rather
 * than a second, subtly different implementation.
 */
function ReferenceOverflow({
  references,
  taskTitle,
  hidden,
  projectId,
}: {
  references: readonly TaskReference[]
  taskTitle: string
  hidden: number
  projectId: string
}) {
  const [open, setOpen] = React.useState(false)
  // How it was opened decides whether focus moves into the list. A CLICK should hand the keyboard
  // the links; a hover must not yank focus out of whatever the reader was doing.
  const openedByHover = React.useRef(false)
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  React.useEffect(() => () => clearTimeout(closeTimer.current), [])

  // Touch has no hover: a tap fires `pointerenter` first, so without this guard the list would
  // open under the finger and then be toggled shut again by the click that follows. Excluded
  // rather than allow-listing `mouse`, so a pen (which does hover) and any device that reports
  // nothing still get the hover behaviour.
  const isHover = (event: React.PointerEvent) => event.pointerType !== 'touch'
  const cancelClose = () => clearTimeout(closeTimer.current)
  const onPointerEnter = (event: React.PointerEvent) => {
    if (!isHover(event)) return
    cancelClose()
    openedByHover.current = true
    setOpen(true)
  }
  // On a DELAY, and the same handler on the trigger and the content: the two are separate
  // elements with a 4px gap between them, so an instant close would make the list impossible to
  // reach with the pointer.
  const onPointerLeave = (event: React.PointerEvent) => {
    if (!isHover(event)) return
    cancelClose()
    closeTimer.current = setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY_MS)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="reference-overflow"
          aria-label={`Show all ${references.length} references for ${taskTitle}`}
          onPointerEnter={onPointerEnter}
          onPointerLeave={onPointerLeave}
          // A real press — mouse, tap or keyboard — is not a hover, whatever happened before it.
          onPointerDown={() => {
            openedByHover.current = false
          }}
          onClick={() => {
            openedByHover.current = false
          }}
          className="shrink-0 rounded-full px-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          +{hidden}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-auto min-w-40 p-1.5"
        data-slot="reference-overflow-list"
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onOpenAutoFocus={(event) => {
          if (openedByHover.current) event.preventDefault()
        }}
        onCloseAutoFocus={(event) => {
          if (openedByHover.current) event.preventDefault()
        }}
      >
        <p className="px-1 pb-1.5 text-xs text-muted-foreground">References</p>
        <span className="flex flex-col items-start gap-1">
          {references.map((reference) => (
            <ReferenceChip
              key={`${reference.kind}#${reference.number}`}
              reference={reference}
              taskTitle={taskTitle}
              projectId={projectId}
            />
          ))}
        </span>
      </PopoverContent>
    </Popover>
  )
}

/**
 * A project's tag, in a table cell.
 *
 * Deliberately QUIET — muted, like the branch chip beside it. Tags repeat on every row of a
 * project, so painting them in the accent turned a whole column into the loudest thing on the
 * page while saying the least: they are context for the row, not its status. The violet is spent
 * where it earns attention instead — the status dot, the reference chips, and a tag chip in the
 * FILTER bar, where being selected is a state worth seeing.
 */
export function TagChip({ tag, className }: { tag: string; className?: string }) {
  return (
    <Badge
      variant="secondary"
      data-slot="project-tag"
      className={cn('h-5 max-w-full truncate px-1.5 font-normal text-muted-foreground', className)}
    >
      {tag}
    </Badge>
  )
}

/**
 * One CPU or Memory cell — the per-project table's grammar: a LIVE sample is emphasized, a
 * finished run's persisted peak is quiet, anything else is an honest em dash.
 */
function UsageTd({ column, cell }: { column: 'cpu' | 'memory'; cell: UsageCell }) {
  return (
    <TableCell
      data-usage={column === 'memory' ? 'mem' : column}
      data-usage-kind={cell.kind}
      title={cell.title}
      className={cn(
        LIST_CELL_CLASS,
        'hidden text-right text-[13px] tabular-nums md:table-cell',
        cell.kind === 'live' ? 'font-medium text-foreground' : 'text-muted-foreground',
      )}
    >
      {cell.text || '—'}
    </TableCell>
  )
}

function Dash() {
  return <span className="text-[13px] text-soft-foreground">—</span>
}

/** What an empty global list honestly means, given how it got empty. */
function GlobalTasksEmptyState({
  view,
  filtered,
  onClear,
}: {
  view: ListView
  filtered: boolean
  onClear?: () => void
}) {
  if (filtered) {
    return (
      <ListEmpty
        icon={<SearchXIcon />}
        title="No matching tasks"
        description="No task in any project matches these filters."
        action={
          onClear ? (
            <Button variant="outline" onClick={onClear}>
              Clear filters
            </Button>
          ) : undefined
        }
      />
    )
  }
  return view === 'archived' ? (
    <ListEmpty
      icon={<ArchiveIcon />}
      title="Nothing archived yet"
      description="Finished tasks you archive land here, from every project."
    />
  ) : (
    <ListEmpty
      icon={<ListChecksIcon />}
      title="No tasks yet"
      description="Start a task in any project and it shows up here."
    />
  )
}
