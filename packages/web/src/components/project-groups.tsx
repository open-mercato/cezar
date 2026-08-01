import { useQueryClient } from '@tanstack/react-query'
import { ChevronDownIcon } from 'lucide-react'
import * as React from 'react'
import { useLocation } from 'react-router'

import { putWorkspaceUiState } from '@/api/client'
import { useHealth, useProjectRuns, useWorkspaceUiState, workspaceQueryKeys } from '@/api/queries'
import type { ProjectListEntry, WorkspaceUiState } from '@open-mercato/cezar-api-client'
import { useSidebarNavigate } from '@/components/app-shell'
import { useListView } from '@/components/list-view'
import { activeNavPath, visibleNavItems } from '@/components/nav-items'
import { QuickListBuckets } from '@/components/task-quick-list'
import { toast } from '@/components/ui/toaster'
import { Link, pathnameProjectId, scopeTo, stripProjectPrefix, useProjectMatch } from '@/lib/project-router'
import { capBuckets, groupRuns, listCounts, type ListView } from '@/lib/task-groups'
import { usageMetricVisibility } from '@/lib/token-metrics'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'

/**
 * The multi-project sidebar (multi-project spec, "Sidebar"): one collapsible group per
 * registered project, each carrying its own nav and its own task quick-list.
 *
 * Mounted by `AppShellContainer` only when the registry holds MORE THAN ONE project — the
 * degenerate single-project workspace keeps the flat sidebar it has always had (`AppShell`
 * falls back to it whenever the `projectGroups` slot is absent). That is not a special case
 * bolted on: with one project the group header would only repeat the repo chip, and every nav
 * row would gain a level of indentation to distinguish it from nothing.
 */

/** The spec's "10 most recent tasks", counted ACROSS buckets — a collapsed variant tile is one
 *  row, because it occupies one row of sidebar. */
const RECENT_LIMIT = 10

/** Collapse is a click-through-a-list gesture: a user opening three groups in a row should cost
 *  the server one write, not three. Short enough that a reload right after a toggle still finds
 *  the new state. */
const COLLAPSE_WRITE_DEBOUNCE_MS = 400

/**
 * Whether a group renders collapsed.
 *
 * The stored answer wins whenever there is one — including an explicit `false`, which is how a
 * user pins a non-active project open. With no entry the default is "the project you are
 * looking at is open, the rest are shut": the alternative (everything open) turns a 40-project
 * workspace into an unusable scroll on first boot, and costs a runs request per project.
 */
export function isProjectCollapsed(
  collapsed: Record<string, boolean> | undefined,
  projectId: string,
  activeProjectId: string | null,
): boolean {
  const stored = collapsed?.[projectId]
  if (stored !== undefined) return stored
  return projectId !== activeProjectId
}

/**
 * Read + write of `sidebar.collapsed` in `~/.cezar/ui-state.json`.
 *
 * The house pattern for ui-state (see `skills-import-panel.tsx`): apply optimistically to the query cache
 * so the chevron turns on the click, PUT behind a debounce, reconcile with the server's merged
 * answer, and on failure toast + invalidate rather than leave the cache asserting a collapse
 * that never persisted.
 *
 * The PUT always carries the WHOLE `sidebar` object (spread from whatever is cached, not just
 * the one key): the route merges shallowly at the top level, so sending `{ sidebar: { collapsed
 * } }` replaces `sidebar` outright and would drop any sibling key a future step puts there.
 */
function useSidebarCollapse(activeProjectId: string | null) {
  const queryClient = useQueryClient()
  const uiState = useWorkspaceUiState()
  const collapsed = uiState.data?.sidebar?.collapsed

  const pending = React.useRef<WorkspaceUiState['sidebar'] | null>(null)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = React.useCallback(() => {
    timer.current = null
    const sidebar = pending.current
    if (!sidebar) return
    pending.current = null
    putWorkspaceUiState({ sidebar })
      .then((merged) => queryClient.setQueryData(workspaceQueryKeys.uiState, merged))
      .catch((error: unknown) => {
        toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
        void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.uiState })
      })
  }, [queryClient])

  // A toggle in the last few hundred milliseconds before unmount (a full page navigation, a
  // closing tab) still lands: the cleanup sends it rather than dropping the timer on the floor.
  React.useEffect(
    () => () => {
      if (timer.current === null) return
      clearTimeout(timer.current)
      flush()
    },
    [flush],
  )

  const toggle = React.useCallback(
    (projectId: string) => {
      // Read the cache rather than close over `uiState.data`: two toggles inside one debounce
      // window must compose, and the second must see the first one's optimistic write.
      const current = queryClient.getQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState)
      const currentCollapsed = current?.sidebar?.collapsed
      const sidebar = {
        ...current?.sidebar,
        collapsed: {
          ...currentCollapsed,
          [projectId]: !isProjectCollapsed(currentCollapsed, projectId, activeProjectId),
        },
      }
      queryClient.setQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState, { ...current, sidebar })

      pending.current = sidebar
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(flush, COLLAPSE_WRITE_DEBOUNCE_MS)
    },
    [activeProjectId, flush, queryClient],
  )

  return { collapsed, toggle }
}

export function ProjectGroups({
  projects,
  bootProjectId,
  inboxAvailable = false,
  inboxCount = null,
  skillsUpdateAvailable = false,
}: {
  projects: ProjectListEntry[]
  /** The project a flat, unprefixed URL resolves to — so the boot project is the one that
   *  auto-expands before the user has navigated into any `/p/<id>` scope. */
  bootProjectId: string
  inboxAvailable?: boolean
  inboxCount?: number | null
  skillsUpdateAvailable?: boolean
}) {
  const { pathname } = useLocation()
  // The shell renders outside the routes, so there is no `ProjectScopeProvider` above it — the
  // URL's own prefix is the scope, exactly as `project-router` resolves it for links.
  const activeProjectId = pathnameProjectId(pathname) ?? bootProjectId
  const { collapsed, toggle } = useSidebarCollapse(activeProjectId)

  // One filter for the whole cockpit (`ListViewProvider`): switching the Tasks table to Archived
  // switches every group with it, rather than leaving the sidebar answering a different question.
  const [view] = useListView()
  const activeTo = activeNavPath(stripProjectPrefix(pathname))
  const runMatch = useProjectMatch('/tasks/:id/*')
  const runExact = useProjectMatch('/tasks/:id')
  const currentRunId = runMatch?.params.id ?? runExact?.params.id ?? null
  const now = useNow(30_000)
  const health = useHealth()
  const metricVisibility = usageMetricVisibility(health.data)

  // Most-recently-opened first, per the spec. Sorted here rather than trusted from the wire so
  // the order is a property of the sidebar, not of whichever route last touched the registry.
  const ordered = React.useMemo(
    () => [...projects].sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt)),
    [projects],
  )

  return (
    <div data-slot="project-group-list">
      {ordered.map((project) => (
        <ProjectGroup
          key={project.id}
          project={project}
          boot={project.id === bootProjectId}
          active={project.id === activeProjectId}
          collapsed={isProjectCollapsed(collapsed, project.id, activeProjectId)}
          onToggle={toggle}
          view={view}
          activeTo={activeTo}
          currentRunId={currentRunId}
          now={now}
          inboxAvailable={inboxAvailable}
          inboxCount={inboxCount}
          skillsUpdateAvailable={skillsUpdateAvailable}
          showTokens={metricVisibility.tokens}
          showCost={metricVisibility.cost}
        />
      ))}
    </div>
  )
}

function ProjectGroup({
  project,
  boot,
  active,
  collapsed,
  onToggle,
  view,
  activeTo,
  currentRunId,
  now,
  inboxAvailable,
  inboxCount,
  skillsUpdateAvailable,
  showTokens,
  showCost,
}: {
  project: ProjectListEntry
  /** The boot project's runs cache lives under the `'default'` scope key (it mounts
   *  unscoped) — see `useProjectRuns`' `boot` parameter. */
  boot: boolean
  active: boolean
  collapsed: boolean
  onToggle: (projectId: string) => void
  view: ListView
  /** The `to` of the nav item that owns the current URL — applied to the ACTIVE group only. */
  activeTo: string | null
  currentRunId: string | null
  now: number
  inboxAvailable: boolean
  inboxCount: number | null
  skillsUpdateAvailable: boolean
  showTokens: boolean
  showCost: boolean
}) {
  const missing = project.status === 'missing'
  // Collapsed (or missing) groups never fetch — a 40-project workspace costs one registry
  // request, not 40 run lists. A collapsed group still READS whatever is cached, which is what
  // keeps its attention badge alive after the user shuts it.
  const runs = useProjectRuns(project.id, !collapsed && !missing, boot)
  const onNavigate = useSidebarNavigate()

  const waiting = runs.data ? listCounts(runs.data).waiting : 0
  const buckets = runs.data ? capBuckets(groupRuns(runs.data, view), RECENT_LIMIT) : []

  // A missing project's panes all 409 (spec, "Registered project folder deleted/moved"), so
  // there is nothing behind the chevron — the row renders greyed and inert rather than
  // pretending to expand into a nav whose every link is a dead end. Unregistering lives in
  // Global settings → Projects; the row says so instead of growing its own destructive button.
  if (missing) {
    return (
      <div data-slot="project-group" data-project={project.id} data-status="missing" className="mb-1">
        <div
          data-slot="project-group-header"
          title={`${project.root} is gone — remove it in Global settings → Projects`}
          className="flex h-11 w-full items-center gap-[7px] rounded-lg px-2 text-[13px] font-semibold opacity-55 md:h-[34px]"
        >
          <span className="w-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{project.name}</span>
          <span
            data-slot="project-missing"
            className="ml-auto shrink-0 rounded-full bg-danger/15 px-[7px] py-px text-[10px] font-medium text-danger"
          >
            folder not found
          </span>
        </div>
      </div>
    )
  }

  const bodyId = `project-group-${project.id}`

  return (
    <div
      data-slot="project-group"
      data-project={project.id}
      data-status={project.status}
      data-collapsed={collapsed ? '' : undefined}
      className="mb-1"
    >
      <button
        type="button"
        onClick={() => onToggle(project.id)}
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        data-slot="project-group-header"
        className={cn(
          // 44px touch target in the drawer, the mockup's 34px row on desktop — the same
          // relaxation the flat nav makes.
          'flex h-11 w-full items-center gap-[7px] rounded-lg px-2 text-left text-[13px] font-semibold transition-colors hover:bg-muted md:h-[34px]',
          active && 'bg-muted',
        )}
      >
        <ChevronDownIcon
          className={cn(
            'size-3 shrink-0 text-muted-foreground transition-transform',
            collapsed && '-rotate-90',
          )}
          aria-hidden="true"
        />
        <span className="truncate">{project.name}</span>
        {waiting ? (
          <span
            data-slot="project-attention"
            title={`${waiting} task${waiting === 1 ? '' : 's'} need${waiting === 1 ? 's' : ''} you`}
            className="shrink-0 rounded-full bg-violet px-1.5 py-px text-[10.5px] font-semibold text-violet-foreground"
          >
            {waiting}
          </span>
        ) : null}
        {project.branch ? (
          <span
            data-slot="project-branch"
            className="ml-auto max-w-[92px] truncate font-mono text-[10.5px] font-medium text-soft-foreground"
          >
            {project.branch}
          </span>
        ) : null}
      </button>

      {collapsed ? null : (
        <div
          id={bodyId}
          data-slot="project-group-body"
          // The gap and the rail are what make the header read as the PARENT of these rows.
          // Without them the active group's `bg-muted` header sits flush against the active nav
          // row's `bg-muted` and the two fuse into one block — the project name then reads as
          // just another menu item. The rail is offset to sit under the chevron, so the whole
          // body hangs off the same vertical the disclosure control is on.
          className="mt-1 ml-[14px] border-l border-border pl-2"
        >
          <nav aria-label={`${project.name} navigation`}>
            {/* Forge-gated per PROJECT (#698): the entry's own remote decides whether THIS
                group offers a GitHub tab — the boot folder's health-level forge answer says
                nothing about the other projects in the workspace. Whether `gh` itself works
                still surfaces inside the tab as its availability hint. */}
            {visibleNavItems({ forge: project.forge === 'github', inbox: inboxAvailable }).map((item) => {
              // Only the active group can own the current URL: the flat route map is
              // project-agnostic, so `/git` lights Git in exactly one project — the scoped one.
              const isActive = active && item.to === activeTo
              const Icon = item.icon
              // Explicitly scoped (`/p/<id>/…`) rather than left to the wrapper's active-project
              // prefix: a group's whole point is linking into a project that is NOT active.
              return (
                <Link
                  key={item.to}
                  to={scopeTo(project.id, item.to)}
                  onClick={onNavigate}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'flex h-11 w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:h-[30px]',
                    isActive && 'bg-muted font-semibold text-foreground',
                  )}
                >
                  <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                  {item.label}
                  {/* `/api/todos` is fetched for the active scope only, so only the active
                      group has a real count to show — a badge on the others would be the active
                      project's number wearing someone else's name. */}
                  {item.badge === 'inbox-count' && active && inboxCount ? (
                    <span
                      data-slot="nav-badge"
                      className="ml-auto rounded-full bg-violet px-1.5 py-px text-[10.5px] font-semibold text-violet-foreground"
                    >
                      {inboxCount}
                    </span>
                  ) : null}
                  {item.badge === 'skills-update' && active && skillsUpdateAvailable ? (
                    <span data-slot="nav-update-marker" className="ml-auto flex items-center">
                      <span className="size-1.5 rounded-full bg-violet" aria-hidden="true" />
                      <span className="sr-only">Skills update available</span>
                    </span>
                  ) : null}
                </Link>
              )
            })}
          </nav>

          <QuickListBuckets
            buckets={buckets}
            currentRunId={active ? currentRunId : null}
            now={now}
            scope={project.id}
            showTokens={showTokens}
            showCost={showCost}
          />

          {/* Always present, not only past the cap: it is this group's door into the project's
              tasks pane (`/p/<id>/`), which is worth an affordance even with two tasks listed. */}
          <Link
            to={scopeTo(project.id, '/')}
            onClick={onNavigate}
            data-slot="project-group-more"
            className="flex h-9 items-center rounded-md px-3 text-[12px] text-muted-foreground transition-colors hover:text-foreground md:h-7"
          >
            More…
          </Link>
        </div>
      )}
    </div>
  )
}
