import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ChevronDownIcon, GripVerticalIcon } from 'lucide-react'
import * as React from 'react'
import { useLocation } from 'react-router'

import { useHealth, useProjectRuns } from '@/api/queries'
import type { ProjectListEntry } from '@open-mercato/cezar-api-client'
import { useSidebarNavigate } from '@/components/app-shell'
import { useListView } from '@/components/list-view'
import { activeNavPath, visibleNavItems } from '@/components/nav-items'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { QuickListBuckets } from '@/components/task-quick-list'
import { Link, pathnameProjectId, scopeTo, stripProjectPrefix, useProjectMatch } from '@/lib/project-router'
import { moveProjectId, orderProjects } from '@/lib/project-order'
import { isProjectCollapsed, readStoredCollapsed, writeStoredCollapsed } from '@/lib/sidebar-collapse'
import { capBuckets, groupRuns, listCounts, type ListView } from '@/lib/task-groups'
import { useProjectOrder } from '@/lib/use-project-order'
import { taskReference } from '@/lib/tasks-table'
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

/**
 * Read + write of the per-project collapse map (`lib/sidebar-collapse.ts`), which lives in
 * localStorage rather than `~/.cezar/ui-state.json`.
 *
 * Seeded once from storage at mount, so the first paint already carries the user's answer — no
 * request to wait for, and no flash of the active-project default. React state is the live copy
 * and every toggle mirrors the new map straight to storage, which is synchronous, so a reload
 * immediately after a click still finds it. There is no debounce, no optimistic-then-reconcile
 * dance and no failure toast left, because there is no server round trip left to fail.
 */
function useSidebarCollapse(activeProjectId: string | null) {
  const [collapsed, setCollapsed] = React.useState(readStoredCollapsed)
  // The map as of the last toggle, updated synchronously: two clicks inside one render pass must
  // compose, and the second must see the first one's entry rather than the batched-away state.
  const latest = React.useRef(collapsed)

  const toggle = React.useCallback(
    (projectId: string) => {
      const next = {
        ...latest.current,
        [projectId]: !isProjectCollapsed(latest.current, projectId, activeProjectId),
      }
      latest.current = next
      writeStoredCollapsed(next)
      setCollapsed(next)
    },
    [activeProjectId],
  )

  return { collapsed, toggle }
}

export function ProjectGroups({
  projects,
  bootProjectId,
  inboxAvailable = false,
  automationsAvailable = false,
  inboxCount = null,
  skillsUpdateAvailable = false,
}: {
  projects: ProjectListEntry[]
  /** The project a flat, unprefixed URL resolves to — so the boot project is the one that
   *  auto-expands before the user has navigated into any `/p/<id>` scope. */
  bootProjectId: string
  inboxAvailable?: boolean
  /** `capabilities.automations` (#801) — workspace-wide, unlike the per-project forge gate:
   *  the opt-in is one env var on the one server that serves every group. */
  automationsAvailable?: boolean
  inboxCount?: number | null
  skillsUpdateAvailable?: boolean
}) {
  const { pathname } = useLocation()
  // The shell renders outside the routes, so there is no `ProjectScopeProvider` above it — the
  // URL's own prefix is the scope, exactly as `project-router` resolves it for links.
  //
  // `scopedProjectId` is null on the pages that belong to NO project — the global Tasks page and
  // global settings. Nothing may be highlighted there: a `/p/` prefix is the only thing that
  // makes a project the one you are standing in, and painting the boot project as selected while
  // the user reads an all-projects table says the page is about that project when it is not.
  const scopedProjectId = pathnameProjectId(pathname)
  // Collapse defaults are a different question ("which group opens when you have never touched
  // one?") and still want a project, so they keep the boot fallback: landing on a global page
  // must not fold the whole sidebar shut.
  const collapseAnchorId = scopedProjectId ?? bootProjectId
  const { collapsed, toggle } = useSidebarCollapse(collapseAnchorId)

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

  // The user's hand-picked order when there is one, `lastOpenedAt` when there is not (#952).
  // Applied here rather than trusted from the wire so the order is a property of the sidebar, not
  // of whichever route last touched the registry — and shared with the ⌘K palette through
  // `lib/project-order.ts`, so the same registry is never listed two ways.
  const { order, canReorder, setOrder } = useProjectOrder()
  const ordered = React.useMemo(() => orderProjects(projects, order), [projects, order])
  const orderedIds = React.useMemo(() => ordered.map((project) => project.id), [ordered])

  // dnd-kit, configured exactly as the workflow builder's step list (`routes/workflows`): the
  // small pointer distance is what keeps a plain click on a group header a disclosure toggle
  // rather than a drag, and the sortable coordinate getter is what makes Space/arrows/Space work.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  // One project cannot be reordered, and neither can any number of them before the authoritative
  // ui-state GET lands — a write composed from an empty cache would drop the file's other keys.
  const sortable = canReorder && ordered.length > 1

  const handleDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      if (over === null || over.id === active.id) return
      const from = orderedIds.indexOf(String(active.id))
      const to = orderedIds.indexOf(String(over.id))
      if (from === -1 || to === -1) return
      // The WHOLE visible order is persisted, not just the moved id: after the first drag every
      // registered project is placed, so nothing re-sorts itself back to the top on the next read.
      setOrder(moveProjectId(orderedIds, from, to))
    },
    [orderedIds, setOrder],
  )

  // dnd-kit's defaults would read out the project SLUG and a droppable's coordinates. The name
  // and the position are what a person actually needs to reorder a list without seeing it.
  const announcements = React.useMemo<Announcements>(() => {
    const describe = (id: string | number) => {
      const index = orderedIds.indexOf(String(id))
      const project = ordered[index]
      return {
        name: project?.name ?? String(id),
        position: `position ${index + 1} of ${orderedIds.length}`,
      }
    }
    return {
      onDragStart: ({ active }) => {
        const { name, position } = describe(active.id)
        return `Picked up ${name}, ${position}.`
      },
      onDragOver: ({ active, over }) =>
        over
          ? `${describe(active.id).name} moved to ${describe(over.id).position}.`
          : `${describe(active.id).name} is not over a drop position.`,
      onDragEnd: ({ active, over }) =>
        over
          ? `${describe(active.id).name} dropped at ${describe(over.id).position}.`
          : `${describe(active.id).name} dropped. The order is unchanged.`,
      onDragCancel: ({ active }) =>
        `Reordering cancelled. ${describe(active.id).name} returned to ${describe(active.id).position}.`,
    }
  }, [ordered, orderedIds])

  const groups = ordered.map((project) => (
    <ProjectGroup
      key={project.id}
      project={project}
      boot={project.id === bootProjectId}
      active={project.id === scopedProjectId}
      collapsed={isProjectCollapsed(collapsed, project.id, collapseAnchorId)}
      onToggle={toggle}
      view={view}
      activeTo={activeTo}
      currentRunId={currentRunId}
      now={now}
      inboxAvailable={inboxAvailable}
      automationsAvailable={automationsAvailable}
      inboxCount={inboxCount}
      skillsUpdateAvailable={skillsUpdateAvailable}
      showTokens={metricVisibility.tokens}
      showCost={metricVisibility.cost}
      sortable={sortable}
      position={orderedIds.indexOf(project.id) + 1}
      total={orderedIds.length}
    />
  ))

  return (
    <div data-slot="project-group-list">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        accessibility={{ announcements }}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={orderedIds} strategy={verticalListSortingStrategy}>
          {groups}
        </SortableContext>
      </DndContext>
    </div>
  )
}

/**
 * The reorder handle (#952). `handleProps` carries dnd-kit's `attributes` (role, tabIndex, aria
 * description) and `listeners` onto a real `<button>`, which is what makes Space-lift /
 * arrows-move / Space-drop work without a pointer.
 *
 * It occupies its column at every breakpoint rather than appearing on hover: a handle that
 * reserves no space reflows the whole drawer under the pointer the moment it appears, and on
 * touch — where the drawer also lives — there is no hover to appear on. What IS hover-led is the
 * ink: invisible until the row is hovered or something inside it has focus, so six project groups
 * do not read as six grab handles.
 */
function ProjectGrip({
  name,
  position,
  total,
  disabled,
  handleProps,
}: {
  name: string
  position: number
  total: number
  disabled: boolean
  handleProps: Record<string, unknown>
}) {
  return (
    <button
      type="button"
      data-slot="project-group-grip"
      disabled={disabled}
      aria-label={`Reorder ${name}, position ${position} of ${total}`}
      className={cn(
        // Full row height, so the touch target is the 44px the drawer's mobile rules ask for
        // even though the column itself stays narrow — 24px of a 264px drawer, 16px on desktop
        // where the pointer is precise.
        'flex h-11 w-6 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground opacity-0 outline-none transition-opacity md:h-[34px] md:w-4',
        // `touch-none` is load-bearing, not decorative: without it a drag inside the mobile sheet
        // scrolls the sheet instead of lifting the group.
        'touch-none focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'group-hover/row:opacity-100 group-focus-within/row:opacity-100',
        // Nothing to grab: no ink, no grab cursor, and `disabled` keeps it out of the tab order.
        disabled && 'cursor-default group-hover/row:opacity-0 group-focus-within/row:opacity-0',
      )}
      {...handleProps}
    >
      <GripVerticalIcon aria-hidden="true" className="size-3.5" />
    </button>
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
  automationsAvailable,
  inboxCount,
  skillsUpdateAvailable,
  showTokens,
  showCost,
  sortable,
  position,
  total,
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
  automationsAvailable: boolean
  inboxCount: number | null
  skillsUpdateAvailable: boolean
  showTokens: boolean
  showCost: boolean
  /** The registry holds more than one project AND the ui-state cache is populated, so a drag has
   *  somewhere to go and something safe to write. */
  sortable: boolean
  /** 1-based, for the grip's label — a screen-reader user needs to know where the row starts. */
  position: number
  total: number
}) {
  const missing = project.status === 'missing'
  // A missing project holds its place in the order but is not draggable: its row is deliberately
  // inert (there is nothing behind the chevron either), and a folder that is gone is one to
  // remove in Global settings → Projects, not one to arrange. It still moves when its neighbours
  // do, and its id is still persisted, so removing it later leaves no hole.
  const canDrag = sortable && !missing
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: project.id, disabled: !canDrag })
  // The lifted group follows the pointer on its own transform (no DragOverlay): a project group
  // is a whole nav plus a task list, and a detached copy of that is a second sidebar mid-flight.
  const dragStyle = { transform: CSS.Transform.toString(transform), transition }
  const grip = (
    <ProjectGrip
      name={project.name}
      position={position}
      total={total}
      disabled={!canDrag}
      handleProps={{ ...attributes, ...listeners }}
    />
  )
  // Collapsed (or missing) groups never fetch — a 40-project workspace costs one registry
  // request, not 40 run lists. A collapsed group still READS whatever is cached, which is what
  // keeps its attention badge alive after the user shuts it.
  const runs = useProjectRuns(project.id, !collapsed && !missing, boot)
  const onNavigate = useSidebarNavigate()

  const waiting = runs.data ? listCounts(runs.data).waiting : 0
  const buckets = runs.data ? capBuckets(groupRuns(runs.data, view), RECENT_LIMIT) : []
  // Only the rows this group actually paints: `buckets` is the capped list, so a project with
  // four hundred runs asks about the handful on screen rather than all of them.
  //
  // Deliberately NOT memoized: `buckets` is rebuilt with a fresh identity on every render, so a
  // `useMemo` keyed on it would recompute every time anyway while claiming otherwise. Nothing
  // downstream needs a stable identity — `ReferenceStatusProvider` and `useReferenceStatuses` both
  // key off the CONTENT of this list.
  const referenceRequests = buckets.flatMap((bucket) =>
    bucket.rows.flatMap((row) => {
      // A collapsed variant group paints its FIRST member's chip, so that is the one to ask
      // about — the others only become visible once the tile is expanded.
      const reference = taskReference(row.kind === 'run' ? row.run : row.members[0]!)
      return reference ? [{ projectId: project.id, kind: reference.kind, number: reference.number }] : []
    }),
  )

  // A missing project's panes all 409 (spec, "Registered project folder deleted/moved"), so
  // there is nothing behind the chevron — the row renders greyed and inert rather than
  // pretending to expand into a nav whose every link is a dead end. Unregistering lives in
  // Global settings → Projects; the row says so instead of growing its own destructive button.
  if (missing) {
    return (
      <div
        ref={setNodeRef}
        style={dragStyle}
        data-slot="project-group"
        data-project={project.id}
        data-status="missing"
        className={cn('mb-1', isDragging && 'relative z-10 opacity-40')}
      >
        <div className="flex items-center">
          {/* The grip's column, empty: the row stays inert (no control that does nothing) while
              its name still lines up with every other project's. */}
          <span aria-hidden="true" className="w-6 shrink-0 md:w-4" />
          <div
            data-slot="project-group-header"
            title={`${project.root} is gone — remove it in Global settings → Projects`}
            className="flex h-11 min-w-0 flex-1 items-center gap-[7px] rounded-lg px-2 text-[13px] font-semibold opacity-55 md:h-[34px]"
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
      </div>
    )
  }

  const bodyId = `project-group-${project.id}`

  return (
    <div
      ref={setNodeRef}
      style={dragStyle}
      data-slot="project-group"
      data-project={project.id}
      data-status={project.status}
      data-collapsed={collapsed ? '' : undefined}
      // Lifted, not gone: the row keeps its place in the flow (dnd-kit measures it) and fades,
      // the way the workflow builder's step cards do.
      data-dragging={isDragging ? '' : undefined}
      // "This is the project the URL names." Absent on the global pages, which name none — see
      // `scopedProjectId` above. An attribute rather than only a class because the highlight is
      // a fact about the group, and a `hover:bg-muted` in the class list makes the class an
      // unreliable way to ask.
      data-active={active ? '' : undefined}
      className={cn('mb-1', isDragging && 'relative z-10 opacity-40')}
    >
      {/* The grip is a SIBLING of the header, never a child: nesting a button inside a button is
          invalid, and dnd-kit's keyboard path has to lift from a real focusable control. */}
      <div className="group/row flex items-center">
        {grip}
        <button
          type="button"
          onClick={() => onToggle(project.id)}
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          data-slot="project-group-header"
          className={cn(
            // 44px touch target in the drawer, the mockup's 34px row on desktop — the same
            // relaxation the flat nav makes.
            'flex h-11 min-w-0 flex-1 items-center gap-[7px] rounded-lg px-2 text-left text-[13px] font-semibold transition-colors hover:bg-muted md:h-[34px]',
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
      </div>

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
            {visibleNavItems({
              forge: project.forge === 'github',
              inbox: inboxAvailable,
              automations: automationsAvailable,
            }).map((item) => {
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

          {/* This group's own project, explicitly: a collapsed sidebar can show six projects at
              once, and #42 means a different pull request in each of them. */}
          <ReferenceStatusProvider projectId={project.id} requests={referenceRequests}>
            <QuickListBuckets
              buckets={buckets}
              currentRunId={active ? currentRunId : null}
              now={now}
              scope={project.id}
              showTokens={showTokens}
              showCost={showCost}
            />
          </ReferenceStatusProvider>

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
