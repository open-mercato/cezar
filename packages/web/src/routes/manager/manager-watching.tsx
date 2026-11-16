import { ArrowRightIcon, ClockIcon, PlusIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router'

import { rememberReferenceStatuses, useProjects, useRunsIndex } from '@/api/queries'
import { TaskReferenceChip } from '@/components/reference-conflict-action'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { deriveAttention } from '@/lib/attention'
import { managerTaskCount, managerTasksPath, toGlobalTasks } from '@/lib/global-tasks'
import { cn } from '@/lib/utils'
import { shortAge } from '@/lib/format'
import {
  everyLabel,
  lastCheckResult,
  managerMessageTime,
  nextCheckLabel,
  cardedTasks,
  type ManagerOrigin,
} from '@/lib/managers'
import { taskReferences } from '@/lib/tasks-table'
import { runTitle } from '@/lib/task-groups'
import { useTaskOrigin } from '@/lib/task-origin'
import { useNow } from '@/lib/use-now'
import { managerAccessOf, type ManagerMessage, type ManagerSummary, type RunRecord } from '@open-mercato/cezar-api-client'

import { ProjectsPicker, type ManagerPatch } from './manager-pickers'
import { taskPath } from './manager-session-card'

const STARTED_LIMIT = 6

const RESULT_LABEL = { reported: 'Reported', quiet: 'Quiet', failed: 'Failed' } as const

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section data-slot="manager-watching-section" aria-label={title} className="flex flex-col gap-1.5">
      <h3 className="flex min-h-6 items-center text-meta font-semibold tracking-[0.08em] text-muted-foreground uppercase">
        {title}
        {action ? <span className="ml-auto">{action}</span> : null}
      </h3>
      <div className="overflow-hidden rounded-lg border border-border bg-card">{children}</div>
    </section>
  )
}

// The sheet is read with a thumb: 44 px rows and body-size text (WCAG 2.5.8).
const ROW_TOUCH = 'group-data-[touch]/watching:min-h-11 group-data-[touch]/watching:text-sm'

function Row({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex min-h-8 items-center gap-2 border-b border-border px-2.5 py-1.5 text-xs last:border-b-0', ROW_TOUCH, className)}>{children}</div>
}

function Pair({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={cn('flex items-baseline justify-between gap-3 border-b border-border px-2.5 py-1.5 text-xs last:border-b-0', ROW_TOUCH)}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  )
}

type WatchingProps = {
  manager: ManagerSummary
  messages: readonly ManagerMessage[]
  /** No older page is left: a quiet check can then be told from one not loaded yet. */
  loadedAll: boolean
  onPatch: (patch: ManagerPatch) => void
  onAddJob: () => void
}

/**
 * The right column (design, Proposal 10): what the gear hid, read-only. Every section shows only
 * when the data behind it exists: the summary has no spend per day, no attention counts, and a
 * run record carries no manager origin, so cost and "Tasks it started" come from what is here.
 */
export function WatchingPanel({ id, ...props }: WatchingProps & { id: string }) {
  return (
    // `relative`: its `sr-only` text scrolls with it instead of stretching the page.
    <aside
      id={id}
      data-slot="manager-watching"
      aria-label="Watching"
      className="group/watching relative flex w-72 shrink-0 flex-col gap-4 overflow-y-auto overscroll-contain border-l border-border bg-card-2 p-3.5 max-lg:hidden"
    >
      <WatchingSections {...props} />
    </aside>
  )
}

/**
 * Below `lg` the column has no room: the same sections in a bottom sheet, tasks first, opened
 * from the chat's header or the chip row above the composer. The caller ties `open` to history
 * so the back gesture and Android's Back close it.
 */
export function WatchingSheet({
  open,
  onOpenChange,
  everyWidth = false,
  ...props
}: WatchingProps & { open: boolean; onOpenChange: (open: boolean) => void; everyWidth?: boolean }) {
  const location = useLocation()
  const managerHistoryBack = (location.state as Record<string, unknown> | null)?.managerWatchingPushed === true
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight, top: 0 })
  const [expanded, setExpanded] = useState(false)
  const [sheetNode, setSheetNode] = useState<HTMLDivElement | null>(null)
  const drag = useRef<{ x: number; y: number; at: number; id: number } | null>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const compact = viewport.width < 600
  useEffect(() => {
    if (!open) return
    setExpanded(false)
    const resize = () => {
      const visual = window.visualViewport
      setViewport({ width: window.innerWidth, height: visual?.height ?? window.innerHeight, top: visual?.offsetTop ?? 0 })
      drag.current = null
      if (visual && window.innerHeight - visual.height > 120) setExpanded(true)
    }
    resize()
    window.addEventListener('resize', resize)
    window.visualViewport?.addEventListener('resize', resize)
    window.visualViewport?.addEventListener('scroll', resize)
    return () => {
      window.removeEventListener('resize', resize)
      window.visualViewport?.removeEventListener('resize', resize)
      window.visualViewport?.removeEventListener('scroll', resize)
    }
  }, [open])
  useLayoutEffect(() => {
    if (!open || !compact || expanded || viewport.height < 600 || !sheetNode) return
    const header = sheetNode.querySelector<HTMLElement>('[data-slot="sheet-header"]')
    const body = sheetNode.querySelector<HTMLElement>('[data-touch]')
    const footer = sheetNode.querySelector<HTMLElement>('[data-slot="manager-watching-sheet-all-tasks"]')
    if (!header || !body || !footer) return
    const measure = () => {
      // offsetHeight excludes the opening animation's translation. Reserve two readable task
      // rows as well as the pinned controls; text scaling must not collapse the scroll area.
      const rows = [...body.querySelectorAll<HTMLElement>('[data-slot="manager-watching-task-row"]')].slice(0, 2)
      const rowHeight = rows.reduce((sum, row) => sum + row.offsetHeight, 0)
      const headingHeight = body.querySelector<HTMLElement>('h3')?.offsetHeight ?? 0
      const bodyStyle = getComputedStyle(body)
      const sheetStyle = getComputedStyle(sheetNode)
      const bodyPadding = parseFloat(bodyStyle.paddingTop) + parseFloat(bodyStyle.paddingBottom)
      const sheetPadding = parseFloat(sheetStyle.paddingTop) + parseFloat(sheetStyle.paddingBottom)
      const minimumBody = Math.min(body.scrollHeight, Math.max(128, rowHeight + headingHeight) + bodyPadding)
      if (header.offsetHeight + footer.offsetHeight + sheetPadding + minimumBody > viewport.height * .6) {
        // Stay expanded for this opening even if content later shrinks.
        setExpanded(true)
      }
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    // The body has one stable, naturally sized sections wrapper. Observing it catches sections
    // mounted after opening as well as text/row changes inside already mounted sections.
    for (const element of [header, footer, body, ...body.children]) observer.observe(element)
    return () => observer.disconnect()
  }, [open, compact, expanded, viewport.height, sheetNode])

  const height = compact
    ? (expanded || viewport.height < 600 ? viewport.height - 12 : viewport.height * .6)
    : Math.min(720, viewport.height - 48)
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        ref={setSheetNode}
        side="bottom"
        showCloseButton={false}
        aria-modal="true"
        data-slot="manager-watching-sheet"
        style={{ top: compact ? viewport.top + viewport.height - height : viewport.top + viewport.height / 2, height: compact ? height : undefined, maxHeight: height }}
        className={cn('bottom-auto gap-0 rounded-t-xl pb-[env(safe-area-inset-bottom)] outline-none motion-reduce:animate-none motion-reduce:transition-none min-[600px]:inset-x-auto min-[600px]:left-1/2 min-[600px]:w-[calc(100%-48px)] min-[600px]:max-w-[640px] min-[600px]:-translate-x-1/2 min-[600px]:rounded-xl min-[600px]:-translate-y-1/2', !everyWidth && 'lg:hidden')}
        onOpenAutoFocus={(event) => {
          returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
          event.preventDefault()
          const sheet = event.currentTarget as HTMLElement | null
          sheet?.focus({ preventScroll: true })
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true })
        }}
      >
        <SheetHeader
          className="shrink-0 touch-none px-4 pt-2 pb-2"
          onPointerDown={(event) => {
            if (event.target instanceof Element && event.target.closest('button, a')) return
            if (!event.isPrimary || event.button !== 0) return
            drag.current = { x: event.clientX, y: event.clientY, at: event.timeStamp, id: event.pointerId }
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerCancel={() => { drag.current = null }}
          onPointerUp={(event) => {
            const start = drag.current
            drag.current = null
            if (!start || start.id !== event.pointerId) return
            const dy = event.clientY - start.y
            const dx = Math.abs(event.clientX - start.x)
            if (dy > 12 && dy > dx && (dy >= 80 || dy / Math.max(1, event.timeStamp - start.at) >= .5)) onOpenChange(false)
          }}
        >
          {compact ? <span aria-hidden="true" className="mx-auto mb-1 h-1 w-10 rounded-full bg-muted-foreground/40" /> : null}
          <div className="flex items-center gap-2">
            <SheetTitle className="min-w-0 flex-1 break-words">Tasks · {props.manager.name}</SheetTitle>
            <SheetClose asChild><Button variant="ghost" className="min-h-12 shrink-0">Close</Button></SheetClose>
          </div>
          <SheetDescription className="sr-only">The tasks this manager started and what it watches. Swipe down from the header or use Close.</SheetDescription>
          {compact && !expanded && viewport.height >= 600 ? <Button variant="ghost" className="min-h-12" onClick={() => setExpanded(true)}>Expand</Button> : null}
        </SheetHeader>
        <div data-touch="" className="group/watching flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-4 pb-4">
          <div className="flex shrink-0 flex-col gap-4">
            <WatchingSections {...props} tasksFirst />
          </div>
        </div>
        <Button asChild variant="ghost" className="min-h-12 shrink-0 whitespace-normal">
          <Link data-slot="manager-watching-sheet-all-tasks" to={managerTasksPath(props.manager.id)} replace state={{ manager: { id: props.manager.id, name: props.manager.name }, managerHistoryBack }}>View all tasks</Link>
        </Button>
      </SheetContent>
    </Sheet>
  )
}

/** How many tasks the replies carded — the phone's way in names them by count. */
export function startedTaskCount(messages: readonly ManagerMessage[]): number {
  return Math.min(cardedTasks(messages).length, STARTED_LIMIT)
}

function WatchingSections({
  manager,
  messages,
  loadedAll,
  onPatch,
  onAddJob,
  tasksFirst = false,
}: WatchingProps & { tasksFirst?: boolean }) {
  const location = useLocation()
  const managerHistoryBack = !tasksFirst || (location.state as Record<string, unknown> | null)?.managerWatchingPushed === true
  const now = useNow(30_000)
  const registry = useProjects().data?.projects
  const runsIndex = useRunsIndex().data
  const runs = runsIndex?.runs
  const indexedStatuses = runsIndex?.referenceStatuses
  const connected = useMemo(
    () => (registry ?? []).filter((project) => manager.connectedProjectIds.includes(project.id)),
    [registry, manager.connectedProjectIds],
  )
  const runningBy = useMemo(() => {
    const counts = new Map<string, number>()
    for (const run of runs ?? []) {
      if (run.status === 'running' && !run.archived) counts.set(run.projectId, (counts.get(run.projectId) ?? 0) + 1)
    }
    return counts
  }, [runs])
  const started = useMemo(() => cardedTasks(messages).slice(0, STARTED_LIMIT), [messages])
  const startedRows = useMemo(() => started.map(({ projectId, runId }) => {
    const run = runs?.find((entry) => entry.projectId === projectId && entry.id === runId)
    const repoBase = registry?.find((project) => project.id === projectId)?.repoUrl
    return {
      projectId,
      runId,
      run,
      title: run ? runTitle(run as unknown as RunRecord) : `Task ${runId.slice(0, 8)}`,
      // Every PR, strongest first: the chip shows the first and `+N` lists the rest (sidebar rule).
      prs: run ? taskReferences(run, repoBase).filter((reference) => reference.kind === 'PR') : [],
    }
  }), [started, runs, registry])
  // One batched status request per project for every chip; the index seeds what it had cached.
  const prRequests = useMemo(
    () => startedRows.flatMap((row) => row.prs.map((pr) => ({ projectId: row.projectId, kind: 'PR' as const, number: pr.number }))),
    [startedRows],
  )
  useEffect(() => {
    if (indexedStatuses) rememberReferenceStatuses(indexedStatuses)
  }, [indexedStatuses])
  // What the Tasks table opens on for this manager, counted by the table's own filter.
  const [taskOrigin] = useTaskOrigin()
  const allCount = useMemo(
    () => managerTaskCount(toGlobalTasks(runs ?? [], registry ?? [], [manager]), manager.id, taskOrigin),
    [runs, registry, manager, taskOrigin],
  )
  const result = lastCheckResult(messages, manager.lastCheckAt, loadedAll)
  const next = manager.cronMinutes > 0 ? nextCheckLabel(manager.nextCheckAt, new Date(now)) : ''
  const origin: ManagerOrigin = { id: manager.id, name: manager.name }
  const tasks = started.length > 0 || manager.followedTasks.length > 0 ? (
    <Section title="Tasks it started">
      <ReferenceStatusProvider requests={prRequests}>
        {startedRows.map(({ projectId, runId, run, title, prs: [pr] }) => {
          const attention = run ? deriveAttention(run as unknown as RunRecord) : undefined
          return (
            // The PR chips are links of their own, so they sit beside the task's link, not in it.
            <div key={`${projectId}/${runId}`} data-slot="manager-watching-task-row" className="border-b border-border last:border-b-0">
              <Link
                to={taskPath(projectId, runId)}
                replace={tasksFirst}
                state={{ manager: origin, managerHistoryBack }}
                data-slot="manager-watching-task"
                className={cn('flex min-h-8 items-center gap-2 px-2.5 py-1.5 text-xs no-underline outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset', ROW_TOUCH)}
              >
                <StatusDot tone={attention?.tone ?? 'neutral'} pulse={attention?.pulse ?? false} />
                {/* A long title wraps to two lines on a phone instead of losing its end. */}
                <span className="min-w-0 flex-1 truncate group-data-[touch]/watching:line-clamp-2 group-data-[touch]/watching:whitespace-normal group-data-[touch]/watching:break-words">
                  {title}
                </span>
                {run ? <span className="shrink-0 text-muted-foreground">{shortAge(run.lastActivityAt, now)}</span> : null}
              </Link>
              {run && pr ? (
                // 25 px = the row padding + dot + gap, so the chip lines up under the title.
                <div data-slot="manager-watching-task-prs" className="flex pr-2.5 pb-1.5 pl-[25px]">
                  <TaskReferenceChip run={run} projectId={projectId} reference={pr} />
                </div>
              ) : null}
            </div>
          )
        })}
      </ReferenceStatusProvider>
      {manager.followedTasks.length > 0 ? (
        <Link
          to={managerTasksPath(manager.id)}
          replace={tasksFirst}
          state={{ manager: origin, managerHistoryBack }}
          data-slot="manager-watching-all-tasks"
          className={cn('flex min-h-8 items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-muted-foreground no-underline outline-none hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset', ROW_TOUCH)}
        >
          <span className="flex-1">View all ({allCount})</span>
          <ArrowRightIcon aria-hidden="true" className="size-3.5 shrink-0" />
        </Link>
      ) : null}
    </Section>
  ) : null
  return (
    <>
      {tasksFirst ? tasks : null}
      <Section
        title="Watching"
        action={(
          <ProjectsPicker
            value={manager.projects}
            access={manager.access}
            projectAccess={manager.projectAccess}
            onAccess={onPatch}
            onChange={(projects) => onPatch({ projects })}
            trigger={<Button variant="ghost" size="xs" aria-label="Edit connected projects" data-slot="manager-watching-edit" className="group-data-[touch]/watching:h-11 group-data-[touch]/watching:px-3">Edit</Button>}
          />
        )}
      >
        {connected.length === 0 ? (
          <Row className="text-muted-foreground">No project connected</Row>
        ) : connected.map((project) => {
          const running = runningBy.get(project.id) ?? 0
          const access = managerAccessOf(manager, project.id)
          return (
            <Row key={project.id}>
              <StatusDot tone={project.status === 'ok' ? 'success' : 'danger'} />
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              <span className="shrink-0 text-muted-foreground">
                {access === 'read' ? 'read-only' : 'write'}
                {running > 0 ? ` · ${running} running` : ''}
              </span>
            </Row>
          )
        })}
      </Section>

      {manager.lastCheckAt ? (
        <Section title="Last check">
          <dl>
            <Pair label="Ran"><time dateTime={manager.lastCheckAt}>{managerMessageTime(manager.lastCheckAt, new Date(now))}</time></Pair>
            {result ? <Pair label="Result">{RESULT_LABEL[result]}</Pair> : null}
            {next ? <Pair label="Next">{next}</Pair> : null}
          </dl>
        </Section>
      ) : null}

      <Section
        title="Jobs"
        action={(
          <Button variant="ghost" size="icon-xs" aria-label="Add job" data-slot="manager-watching-add-job" className="group-data-[touch]/watching:size-11" onClick={onAddJob}>
            <PlusIcon aria-hidden="true" />
          </Button>
        )}
      >
        {manager.jobs.length === 0 ? (
          <Row className="text-muted-foreground">No jobs yet</Row>
        ) : manager.jobs.map((job) => (
          <Row key={job.id}>
            <ClockIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{job.name}</span>
            <span className="shrink-0 text-muted-foreground">{job.enabled ? everyLabel(job.everyMinutes) : 'paused'}</span>
          </Row>
        ))}
      </Section>

      {tasksFirst ? null : tasks}
    </>
  )
}
