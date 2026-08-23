import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  EyeIcon,
  EyeOffIcon,
  LayersIcon,
  ListChecksIcon,
  SearchIcon,
  SearchXIcon,
  XIcon,
} from 'lucide-react'
import * as React from 'react'
import { Link, useSearchParams } from 'react-router'

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
import { CenteredState } from '@/components/centered-state'
import { FacetFilter, SegmentedControl, ToggleChip } from '@/components/facet-filter'
import { useListView } from '@/components/list-view'
import { Pill } from '@/components/pill'
import { ReferenceChip } from '@/components/reference-chip'
import { ResolveConflictsForRun } from '@/components/reference-conflict-action'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { StatusDot } from '@/components/status-dot'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
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
  resetCount,
  toGlobalTasks,
  toggleFacetValue,
  toggleGroupBy,
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
      <div data-route="global-tasks" className="flex min-h-full flex-col">
        <CenteredState
          icon={<LayersIcon />}
          tone="danger"
          title="Tasks across projects did not load"
          subtitle={(index.error ?? projects.error)?.message}
        />
      </div>
    )
  }

  const search = (
    <div className="relative w-full md:w-60">
      <SearchIcon
        className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-soft-foreground"
        aria-hidden="true"
      />
      <input
        type="text"
        value={queryDraft}
        onChange={(event) => setQueryDraft(event.target.value)}
        placeholder="Search every project…"
        aria-label="Search tasks across projects"
        className="h-9 w-full rounded-md border border-input bg-card pr-3 pl-8 text-[13px] text-foreground outline-none placeholder:text-soft-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />
    </div>
  )

  return (
    <div data-route="global-tasks" className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">All tasks</h1>
        <div className="inline-flex gap-0.5 rounded-md bg-muted p-[3px]">
          <ViewTab view="active" current={view} onSelect={setView}>
            Active
          </ViewTab>
          <ViewTab view="archived" current={view} onSelect={setView}>
            Archived
          </ViewTab>
        </div>
        <div className="flex-1" />
        <span data-slot="global-tasks-count" className="text-[12.5px] text-soft-foreground tabular-nums">
          {visible.length} of {tasks.length}
        </span>
        {search}
      </header>

      <div className="flex flex-1 flex-col gap-3 p-3 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-5 md:pb-5">
        {/* Below `md` the header above is hidden, so the search box rides here instead. */}
        <div className="md:hidden">{search}</div>

        <FilterBar
          filters={filters}
          onToggle={toggle}
          onClearFacet={clearFacet}
          onClearAll={() => {
            setQueryDraft('')
            // Filters AND grouping — "Clear" is the one way back to a plain list.
            commit((state) => ({ ...state, filters: NO_FILTERS, groupBy: 'none' }))
          }}
          groupBy={groupBy}
          onGroupByChange={setGroupBy}
          projects={registry}
          tasks={tasks}
          view={view}
        />

        {truncated.length > 0 ? (
          <p data-slot="global-tasks-truncated" className="text-[11.5px] text-soft-foreground">
            Showing the newest {index.data?.perProjectLimit} tasks per project — older ones in{' '}
            {truncated.join(', ')} are only in that project&rsquo;s own Tasks page.
          </p>
        ) : null}

        {index.data === undefined ? null : visible.length === 0 ? (
          <GlobalTasksEmptyState view={view} filtered={hasActiveFilters(filters)} />
        ) : (
          // No `projectId` on the provider, uniquely on this page: every chip under it names its
          // own, because the rows next to each other belong to different repositories.
          <ReferenceStatusProvider requests={referenceRequests}>
            {groups.map((group) => (
              <section key={group.key} data-slot="task-group" data-group-key={group.key}>
                {groupBy === 'none' ? null : (
                  <h2 className="mb-1.5 flex items-center gap-2 text-[12px] font-semibold tracking-[0.04em] text-soft-foreground uppercase">
                    {/* A project heading is a DOOR, not a label: that project's own Tasks page is
                        the better version of "just this project" (live SSE, the full column set,
                        the composer), which is why there is no project filter here at all. */}
                    {groupBy === 'project' ? (
                      <Link
                        to={scopeTo(group.key, '/')}
                        data-slot="group-project-link"
                        className="hover:text-foreground hover:underline"
                      >
                        {group.label}
                      </Link>
                    ) : (
                      group.label
                    )}
                    <span className="font-mono text-[11px] font-medium tabular-nums">
                      {group.tasks.length}
                    </span>
                  </h2>
                )}
                <TaskTable
                  tasks={group.tasks}
                  now={now}
                  showProject={groupBy !== 'project'}
                  onArchive={(task, archived) => archive.mutate({ task, archived })}
                  onSetRead={(task, read) => setRead.mutate({ task, read })}
                  busy={archive.isPending || setRead.isPending}
                  showCost={metrics.cost}
                />
              </section>
            ))}
          </ReferenceStatusProvider>
        )}
      </div>
    </div>
  )
}

function ViewTab({
  view,
  current,
  onSelect,
  children,
}: {
  view: ListView
  current: ListView
  onSelect: (view: ListView) => void
  children: React.ReactNode
}) {
  const isActive = view === current
  return (
    <button
      type="button"
      data-slot="overview-tab"
      data-view={view}
      // Same rationale as the per-project table's tabs: these filter one list in place, they do
      // not switch panels — `aria-pressed` is what that actually is.
      aria-pressed={isActive}
      onClick={() => onSelect(view)}
      className={cn(
        'flex h-7 items-center justify-center rounded-[7px] px-3 text-[12.5px] font-medium text-muted-foreground',
        isActive && 'bg-card font-semibold text-foreground shadow-xs',
      )}
    >
      {children}
    </button>
  )
}

/**
 * The filter row.
 *
 * Two shapes, chosen by what the facet IS rather than for variety:
 *
 *  - **Tags are laid out flat**, as one-click toggle chips. They are the reason this page exists
 *    ("show me the storefront work"), there are rarely more than a dozen, and seeing the whole
 *    set is most of the value — a popover would hide exactly what the user came to look at.
 *  - **Everything else is a searchable multi-select pill.** A workspace can hold forty projects
 *    and a dozen workflows; those do not lay out flat, and they do not need to.
 *
 * Every option carries the number of rows it would leave, counted against the list as the OTHER
 * facets narrow it — so a filter that would empty the table says so before it is clicked. And
 * every option list except the tags is derived from the tasks ACTUALLY on the page: an option
 * that can only ever produce an empty table is a dead end wearing a control's clothes. Tags are
 * the deliberate exception, taken from the registry, because a tag on a project with no tasks
 * yet is still the answer to "which repos are in this group?".
 */
function FilterBar({
  filters,
  onToggle,
  onClearFacet,
  onClearAll,
  groupBy,
  onGroupByChange,
  projects,
  tasks,
  view,
}: {
  filters: GlobalTaskFilters
  onToggle: (facet: FacetId, value: string) => void
  onClearFacet: (facet: FacetId) => void
  onClearAll: () => void
  groupBy: GroupBy
  onGroupByChange: (next: GroupBy) => void
  projects: readonly ProjectListEntry[]
  tasks: readonly GlobalTask[]
  view: ListView
}) {
  const tags = React.useMemo(() => allProjectTags(projects), [projects])

  // One `tasksExcludingFacet` per facet: the counts a facet shows must not already assume that
  // facet's own ticks, or unticking a value would promise fewer rows than it delivers.
  const counts = React.useMemo(() => {
    const per = (facet: FacetId, valueOf: (task: GlobalTask) => readonly string[]) =>
      facetCounts(tasksExcludingFacet(tasks, filters, view, facet), valueOf)
    return {
      tags: per('tags', tagValuesOf),
      statuses: per('statuses', (task) => [task.run.status]),
      workflows: per('workflows', (task) => [task.run.workflow]),
    }
  }, [tasks, filters, view])

  const withCount = (map: Map<string, number>) => (option: { value: string; label: string }) => ({
    ...option,
    count: map.get(option.value) ?? 0,
  })

  return (
    <div
      data-slot="global-tasks-filters"
      className="flex flex-col gap-2 rounded-lg border border-border bg-card p-2.5 shadow-xs"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {/* No project facet, deliberately — see the note in `lib/global-tasks.ts`. Narrowing to
            one project is that project's own Tasks page, which every project name here links to. */}
        <FacetFilter
          slot="status"
          label="Status"
          selected={filters.statuses}
          onToggle={(value) => onToggle('statuses', value)}
          onClear={() => onClearFacet('statuses')}
          options={allStatuses(tasks)
            .map((status) => ({ value: status, label: status }))
            .map(withCount(counts.statuses))}
          emptyLabel="No tasks to filter"
        />
        <FacetFilter
          slot="workflow"
          label="Workflow"
          selected={filters.workflows}
          onToggle={(value) => onToggle('workflows', value)}
          onClear={() => onClearFacet('workflows')}
          options={allWorkflows(tasks)
            .map((workflow) => ({ value: workflow, label: workflow }))
            .map(withCount(counts.workflows))}
          emptyLabel="No tasks to filter"
        />
        <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
        <span className="text-[11px] font-medium text-soft-foreground">Group by</span>
        {/* Pressing the pressed one releases it — see `toggleGroupBy`, which is why there is
            no "None" button to hunt for. */}
        <SegmentedControl
          slot="group-by"
          label="Group tasks by"
          value={groupBy}
          options={GROUP_BY_OPTIONS}
          onChange={(picked) => onGroupByChange(toggleGroupBy(groupBy, picked))}
        />
        {canReset({ filters, groupBy }) ? (
          <button
            type="button"
            data-action="clear-filters"
            onClick={onClearAll}
            className="ml-auto inline-flex h-7 items-center gap-1 rounded-full px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <XIcon className="size-3" aria-hidden="true" />
            Clear
            {` (${resetCount({ filters, groupBy })})`}
          </button>
        ) : null}
      </div>

      {tags.length > 0 ? (
        <div data-slot="tag-filters" className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-medium text-soft-foreground">Tags</span>
          {tags.map((tag) => (
            <ToggleChip
              key={tag}
              slot="tag-filter"
              tone="tag"
              label={tag}
              count={counts.tags.get(tag) ?? 0}
              selected={filters.tags.some((picked) => picked.toLowerCase() === tag.toLowerCase())}
              onToggle={() => onToggle('tags', tag)}
            />
          ))}
          {/* Last, and named as the leftovers it is: "which repos still need labelling?" is a
              real question, and it is the one this chip answers. */}
          <ToggleChip
            slot="tag-filter"
            label="Untagged"
            count={counts.tags.get(UNTAGGED) ?? 0}
            selected={filters.tags.includes(UNTAGGED)}
            onToggle={() => onToggle('tags', UNTAGGED)}
          />
        </div>
      ) : (
        // Not silence: a workspace with no tags anywhere is the ONE state where the feature is
        // invisible, and the sentence that fixes it is one line long — with the door in it,
        // since the pane that fixes it is two clicks away and outside this page.
        <p data-slot="no-tags-hint" className="text-[11px] text-soft-foreground">
          Tag connected repositories in{' '}
          <Link to="/settings/global/projects" className="font-medium text-violet hover:underline">
            Settings → Projects
          </Link>{' '}
          to group their tasks together here.
        </p>
      )}
    </div>
  )
}

/** The rows. One table per group, so a group heading owns its own header row rather than
 *  floating above a shared one that would scroll away from it. */
function TaskTable({
  tasks,
  now,
  showProject,
  onArchive,
  onSetRead,
  busy,
  showCost,
}: {
  tasks: readonly GlobalTask[]
  now: number
  showProject: boolean
  onArchive: (task: GlobalTask, archived: boolean) => void
  onSetRead: (task: GlobalTask, read: boolean) => void
  busy: boolean
  showCost: boolean
}) {
  return (
    <div
      data-slot="global-tasks-table"
      className="overflow-x-auto rounded-lg border border-border bg-card shadow-xs"
    >
      <TooltipProvider>
        <table className="w-full border-collapse">
          <thead>
            {/* Every other column is pinned as narrow as its content allows, because Task is the
                only one with NO width and therefore the only one that grows on what they give
                up. A cross-project list is scanned by title; everything else is the answer to a
                question you ask about a row you already found. */}
            <tr>
              <Th className="w-[104px]">Status</Th>
              <Th>Task</Th>
              {showProject ? <Th className="w-[124px]">Project</Th> : null}
              <Th className="hidden w-[120px] xl:table-cell">Tags</Th>
              <Th className="w-[84px]">Ref</Th>
              <Th className="hidden w-[108px] xl:table-cell">Workflow</Th>
              {showCost ? <Th className="hidden w-[64px] text-right lg:table-cell">Cost</Th> : null}
              <Th className="hidden w-[56px] text-right xl:table-cell">CPU</Th>
              <Th className="hidden w-[84px] text-right xl:table-cell">Mem</Th>
              <Th className="w-[56px] text-right">Age</Th>
              <Th className="w-[64px] text-right">
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody className="[&>tr:last-child>td]:border-b-0">
            {tasks.map((task) => (
              <TaskRow
                key={`${task.run.projectId}/${task.run.id}`}
                task={task}
                now={now}
                showProject={showProject}
                onArchive={onArchive}
                onSetRead={onSetRead}
                busy={busy}
                showCost={showCost}
              />
            ))}
          </tbody>
        </table>
      </TooltipProvider>
    </div>
  )
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={cn(
        'h-[38px] border-b border-border px-2.5 text-left text-[11px] font-semibold tracking-[0.05em] whitespace-nowrap text-soft-foreground uppercase first:pl-4 last:pr-4',
        className,
      )}
    >
      {children}
    </th>
  )
}

const TD_BASE = 'h-11 border-b border-border px-2.5 whitespace-nowrap first:pl-4 last:pr-4'

/**
 * One cross-project run.
 *
 * The title is a real `<Link>` — a plain router one, explicitly scoped with `scopeTo`: this page
 * renders outside every `/p/:projectId`, so the scope-aware `Link` would have no project to
 * prefix with, and each row points at a DIFFERENT project anyway.
 */
function TaskRow({
  task,
  now,
  showProject,
  onArchive,
  onSetRead,
  busy,
  showCost,
}: {
  task: GlobalTask
  now: number
  showProject: boolean
  onArchive: (task: GlobalTask, archived: boolean) => void
  onSetRead: (task: GlobalTask, read: boolean) => void
  busy: boolean
  showCost: boolean
}) {
  const { run } = task
  const attention = deriveAttention(run)
  const to = scopeTo(run.projectId, `/tasks/${run.id}`)
  const unread = isUnread(run)
  const readDone = isReadDoneItem(run)
  // The SAME rule every other surface applies (#407, #526) — the index carries the six inputs
  // rather than a pre-resolved chip precisely so this is one function, not two. Plural here
  // because a task genuinely has several: opened on an issue, about one PR, having created
  // another. The surfaces with one slot take the first; this one has room for the truth.
  //
  // The project's own repo root is what makes a reference known only by NUMBER clickable. A
  // project-scoped view can use the one repo it is standing in; this page has a different repo
  // per row, which is why the registry entry carries `repoUrl`.
  const references = taskReferences(run, task.project?.repoUrl)
  // The SAME live/peak rule the per-project table applies. The live sample rides the index row
  // itself (`run.usage`, attached server-side per poll) rather than the run event stream, which
  // is project-scoped and so cannot reach forty projects at once.
  const usage = usageCells(run, run.usage)

  return (
    <tr data-slot="global-task-row" data-run-id={run.id} data-project={run.projectId} className="hover:bg-muted">
      <td className={TD_BASE}>
        <Pill dot={attention.tone} pulse={attention.pulse}>
          {attention.label}
        </Pill>
      </td>
      {/* The one column with no fixed width, so every pixel the others give up lands here — and
          dropping Branch gave up 140 of them. A cross-project list is read by TITLE. */}
      <td className={cn(TD_BASE, 'min-w-[320px] max-w-0')}>
        <span className="flex min-w-0 items-center gap-1.5">
          <Link
            to={to}
            title={runTitle(run)}
            className={cn(
              'min-w-0 truncate text-[13px]',
              unread
                ? 'font-semibold text-foreground'
                : readDone
                  ? 'font-medium text-muted-foreground'
                  : 'font-medium',
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
        </span>
      </td>
      {showProject ? (
        <td className={cn(TD_BASE, 'text-[12.5px] text-muted-foreground')}>
          <Link to={scopeTo(run.projectId, '/')} className="truncate hover:text-foreground">
            {task.projectName}
          </Link>
        </td>
      ) : null}
      <td className={cn(TD_BASE, 'hidden xl:table-cell')}>
        {task.tags.length > 0 ? (
          <span className="flex flex-wrap items-center gap-1">
            {task.tags.map((tag) => (
              <TagChip key={tag} tag={tag} />
            ))}
          </span>
        ) : (
          <Dash />
        )}
      </td>
      <td className={TD_BASE}>
        {references.length > 0 ? (
          <ReferenceChips references={references} run={run} />
        ) : (
          <Dash />
        )}
      </td>
      <td className={cn(TD_BASE, 'hidden text-[12.5px] text-muted-foreground xl:table-cell')}>
        {run.workflow}
      </td>
      {showCost ? (
        <td
          className={cn(
            TD_BASE,
            'hidden text-right font-mono text-xs text-muted-foreground tabular-nums lg:table-cell',
          )}
        >
          {formatCost(run.costUsd) || <Dash />}
        </td>
      ) : null}
      <UsageTd column="cpu" cell={usage.cpu} />
      <UsageTd column="memory" cell={usage.mem} />
      <td className={cn(TD_BASE, 'text-right text-xs text-soft-foreground tabular-nums')}>
        {shortAge(run.startedAt ?? run.createdAt, now)}
      </td>
      <td className={cn(TD_BASE, 'text-right')}>
        <span className="inline-flex items-center gap-0.5">
          <ReadToggle task={task} busy={busy} onSetRead={onSetRead} />
          <ArchiveToggle task={task} busy={busy} onArchive={onArchive} />
        </span>
      </td>
    </tr>
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
            'inline-flex size-7 items-center justify-center rounded-md transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-wait disabled:opacity-50',
            unread ? 'text-violet' : 'text-soft-foreground',
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
          className="inline-flex size-7 items-center justify-center rounded-md text-soft-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-wait disabled:opacity-50"
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
          className="shrink-0"
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
          className="shrink-0 rounded-full px-1 text-[11px] font-medium text-soft-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
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
        <p className="px-1 pb-1.5 text-[10.5px] text-soft-foreground">References</p>
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
    <span
      data-slot="project-tag"
      className={cn(
        'inline-flex max-w-full items-center truncate rounded-full bg-muted px-1.5 py-px text-[10.5px] font-medium text-muted-foreground',
        className,
      )}
    >
      {tag}
    </span>
  )
}

/**
 * One CPU or Mem cell — the per-project table's exact grammar, so the two read alike: a LIVE
 * sample is emphasized, a finished run's persisted peak is dimmed and says so, and anything
 * else is an honest em dash rather than an invented zero.
 */
function UsageTd({ column, cell }: { column: 'cpu' | 'memory'; cell: UsageCell }) {
  return (
    <td
      data-usage={column === 'memory' ? 'mem' : column}
      data-usage-kind={cell.kind}
      title={cell.title}
      className={cn(
        TD_BASE,
        'hidden text-right font-mono tabular-nums xl:table-cell',
        cell.kind === 'live' && 'bg-violet/5 text-xs font-medium text-foreground',
        cell.kind === 'peak' && 'text-[11.5px] text-soft-foreground',
        cell.kind === 'none' && 'text-xs text-soft-foreground',
      )}
    >
      {cell.text || '—'}
    </td>
  )
}

function Dash() {
  return <span className="text-xs text-soft-foreground">—</span>
}

/** What an empty global list honestly means, given how it got empty. */
function GlobalTasksEmptyState({ view, filtered }: { view: ListView; filtered: boolean }) {
  if (filtered) {
    return (
      <CenteredState
        heading="h2"
        icon={<SearchXIcon />}
        tone="neutral"
        title="No matching tasks"
        subtitle="No task in any project matches these filters."
      />
    )
  }
  return view === 'archived' ? (
    <CenteredState
      heading="h2"
      icon={<ArchiveIcon />}
      tone="neutral"
      title="Nothing archived yet"
      subtitle="Finished tasks you archive land here, from every project."
    />
  ) : (
    <CenteredState
      heading="h2"
      icon={<ListChecksIcon />}
      tone="neutral"
      title="No tasks yet"
      subtitle="Start a task in any project and it shows up here."
    />
  )
}
