import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArchiveIcon, CircleDotIcon, FolderIcon, GlobeIcon, InboxIcon, LayersIcon, ListChecksIcon, PlusIcon, SettingsIcon, WorkflowIcon } from 'lucide-react'
import * as React from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router'

import { archiveFinished } from '@/api/client'
import { useManagers } from '@/api/managers'
import { useHealth, useProjects, useRunsForProject, workspaceQueryKeys } from '@/api/queries'
import { useQuestions } from '@/api/questions'
import { StatusDot } from '@/components/status-dot'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { toast } from '@/components/ui/toaster'
import { statusTone } from '@/lib/automation-format'
import { MANAGER_ATTENTION_DOT, managerAttention } from '@/lib/managers'
import { isCezarShell, shellRequest } from '@/lib/phone-app'
import { pathnameProjectId } from '@/lib/project-router'
import { runTitle } from '@/lib/task-groups'
import { filterRunsByOrigin } from '@/lib/task-filters'
import { useTaskOrigin } from '@/lib/task-origin'
import { finishedRunCount } from '@/lib/tasks-table'
import { cn } from '@/lib/utils'

/** The bottom bar's long-press shortcuts (design: tab-bar-quick-actions, Variant A). */
export type QuickTab = 'now' | 'tasks' | 'manager' | 'more'

/** Long enough that a slow tap stays a tap; iOS's own context menus open around here. */
export const LONG_PRESS_MS = 450
const MOVE_SLOP_PX = 10
const HINT_ID = 'bottom-bar-quick-actions-hint'

/** A short tick the moment the menu opens: the native shells by `cezar://haptic`, Android Chrome by vibrate. */
export function quickActionHaptic(): void {
  if (isCezarShell()) shellRequest.open('cezar://haptic')
  else if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(10)
}

/**
 * Long-press (touch), right-click and Shift+F10 / the Menu key all open a tab's menu. The native
 * link callout is cancelled on `contextmenu`; a long-press swallows the click that may follow it.
 */
export function useTabQuickActions() {
  const [open, setOpen] = React.useState<QuickTab | null>(null)
  const press = React.useRef<{ tab: QuickTab; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null)
  // Set by a touch long-press; only that touch's own click is swallowed (pointer clicks carry
  // `detail` ≥ 1, a keyboard Enter 0), and the next press or key clears it.
  const swallowClick = React.useRef(false)

  const cancelPress = React.useCallback(() => {
    if (press.current) clearTimeout(press.current.timer)
    press.current = null
  }, [])
  React.useEffect(() => cancelPress, [cancelPress])

  const openFromPress = React.useCallback((tab: QuickTab) => {
    cancelPress()
    swallowClick.current = true
    quickActionHaptic()
    setOpen(tab)
  }, [cancelPress])

  const bind = React.useCallback((tab: QuickTab) => ({
    'aria-describedby': HINT_ID,
    onPointerDown: (event: React.PointerEvent) => {
      swallowClick.current = false
      cancelPress()
      if (event.pointerType === 'mouse' || event.isPrimary === false) return
      const { clientX: x, clientY: y } = event
      press.current = { tab, x, y, timer: setTimeout(() => openFromPress(tab), LONG_PRESS_MS) }
    },
    onPointerMove: (event: React.PointerEvent) => {
      const held = press.current
      if (held && Math.hypot(event.clientX - held.x, event.clientY - held.y) > MOVE_SLOP_PX) cancelPress()
    },
    onPointerUp: cancelPress,
    onPointerCancel: cancelPress,
    onPointerLeave: cancelPress,
    onContextMenu: (event: React.MouseEvent) => {
      // The native menu would show the loopback URL (the tester's report) — never let it through.
      event.preventDefault()
      if (open === tab) return
      // Android fires this for a touch long-press, often before our timer: one open, one haptic.
      // Right-click and Shift+F10 / the Menu key are not a touch, whatever came before them.
      const pointerType = (event.nativeEvent as Partial<PointerEvent>).pointerType
      if (press.current?.tab === tab || pointerType === 'touch') openFromPress(tab)
      else {
        cancelPress()
        swallowClick.current = false
        setOpen(tab)
      }
    },
    onKeyDown: (event: React.KeyboardEvent) => {
      swallowClick.current = false
      // macOS browsers never turn these into `contextmenu`; elsewhere this runs first and the
      // follow-up `contextmenu` finds the menu open.
      if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
        event.preventDefault()
        cancelPress()
        setOpen(tab)
      }
    },
    onClickCapture: (event: React.MouseEvent) => {
      const swallow = swallowClick.current
      swallowClick.current = false
      if (!swallow || event.detail === 0) return
      event.preventDefault()
      event.stopPropagation()
    },
  }), [cancelPress, open, openFromPress])

  return { open, setOpen, bind }
}

/** Hidden text every tab points at, so a screen reader announces the shortcut. */
export function QuickActionsHint() {
  return (
    <span id={HINT_ID} className="sr-only">
      Touch and hold, or press Shift+F10, for shortcuts.
    </span>
  )
}

/** The blur behind an open menu: phones only, a narrow desktop window keeps the page sharp. */
export function QuickActionsBackdrop({ open }: { open: boolean }) {
  if (!open || typeof document === 'undefined') return null
  return createPortal(
    <div
      aria-hidden="true"
      data-slot="quick-actions-backdrop"
      className="pointer-events-none fixed inset-0 z-40 hidden bg-background/40 backdrop-blur-md animate-in fade-in-0 pointer-coarse:block motion-reduce:animate-none"
    />,
    document.body,
  )
}

const ITEM = 'min-h-10 gap-2.5 pointer-coarse:min-h-11 pointer-coarse:text-ui'

/**
 * One tab's menu. The trigger is an inert box over the tab: the tab keeps its own tap, and
 * focus goes back to it on close.
 */
export function TabQuickMenu({
  tab,
  open,
  onOpenChange,
  align,
  returnFocus,
  children,
}: {
  tab: QuickTab
  open: boolean
  onOpenChange: (open: boolean) => void
  align: 'start' | 'center' | 'end'
  returnFocus: () => HTMLElement | null
  children: React.ReactNode
}) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <span aria-hidden="true" tabIndex={-1} data-slot="quick-actions-anchor" className="pointer-events-none absolute inset-0" />
      </DropdownMenuTrigger>
      {open ? (
        <DropdownMenuContent
          side="top"
          align={align}
          sideOffset={8}
          collisionPadding={8}
          data-slot="quick-actions-menu"
          data-tab={tab}
          aria-label={`${tab === 'now' ? 'Now' : tab === 'tasks' ? 'Tasks' : tab === 'manager' ? 'Manager' : 'More'} shortcuts`}
          className="z-50 w-64 rounded-xl p-1.5 shadow-xl motion-reduce:animate-none"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            returnFocus()?.focus()
          }}
        >
          {children}
        </DropdownMenuContent>
      ) : null}
    </DropdownMenu>
  )
}

function Count({ n }: { n: number }) {
  return n > 0 ? <span className="ml-auto font-mono text-meta text-muted-foreground tabular-nums">{n > 99 ? '99+' : n}</span> : null
}

/** The project the bar's links lead to, from its index path (`/p/<id>/`, or `/` for the boot one). */
function useIndexProject(index: string) {
  const health = useHealth()
  const projects = useProjects()
  const bootProject = projects.data?.bootProject ?? health.data?.bootProject ?? null
  const projectId = pathnameProjectId(index) ?? bootProject
  return { projectId, bootProject, projects: projects.data?.projects ?? [] }
}

export function NowQuickActions({ index, nowCount }: { index: string; nowCount: number | null }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { projectId, bootProject, projects } = useIndexProject(index)
  const finished = useRunsForProject(projectId, bootProject, finishedRunCount).data ?? 0
  const archive = useMutation({
    mutationFn: () => archiveFinished(projectId ?? undefined),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[1] === 'runs' })
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.runsIndex })
      toast(`Archived ${result.archived} finished ${result.archived === 1 ? 'task' : 'tasks'}`)
    },
    onError: () => toast('Could not archive the finished tasks', { tone: 'danger' }),
  })
  const others = projects.filter((project) => project.id !== projectId && project.status !== 'missing').slice(0, 5)
  return (
    <>
      <DropdownMenuItem className={ITEM} data-slot="quick-now-project" onSelect={() => navigate(index, { state: { nowScope: 'project' } })}>
        <CircleDotIcon />
        Needs you
        <Count n={nowCount ?? 0} />
      </DropdownMenuItem>
      {/* An unread registry may still hold several projects: offer it, Now shows what there is. */}
      {projects.length !== 1 ? (
        <DropdownMenuItem className={ITEM} data-slot="quick-now-all" onSelect={() => navigate(index, { state: { nowScope: 'all' } })}>
          <GlobeIcon />
          Needs you — all projects
        </DropdownMenuItem>
      ) : null}
      {others.length > 0 ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-meta text-muted-foreground">Switch project</DropdownMenuLabel>
          {others.map((project) => (
            <DropdownMenuItem key={project.id} className={ITEM} data-slot="quick-now-switch" onSelect={() => navigate(`/p/${encodeURIComponent(project.id)}/`)}>
              <FolderIcon />
              <span className="truncate">{project.name}</span>
            </DropdownMenuItem>
          ))}
        </>
      ) : null}
      {finished > 0 ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem className={ITEM} data-slot="quick-now-archive" disabled={archive.isPending} onSelect={() => archive.mutate()}>
            <ArchiveIcon />
            Archive all finished
            <Count n={finished} />
          </DropdownMenuItem>
        </>
      ) : null}
    </>
  )
}

const STATUS_SHORTCUTS = ['running', 'review', 'failed'] as const

export function TasksQuickActions({ index }: { index: string }) {
  const navigate = useNavigate()
  const { projectId, bootProject, projects } = useIndexProject(index)
  const runs = useRunsForProject(projectId, bootProject).data
  // What the Tasks table shows by default: the remembered origin (Regular unless changed).
  const [origin] = useTaskOrigin()
  const active = React.useMemo(() => filterRunsByOrigin((runs ?? []).filter((run) => !run.archived), origin), [runs, origin])
  const recent = React.useMemo(
    () => [...active].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 3),
    [active],
  )
  const statuses = STATUS_SHORTCUTS.map((status) => ({ status, count: active.filter((run) => run.status === status).length })).filter((row) => row.count > 0)
  return (
    <>
      <DropdownMenuItem className={ITEM} data-slot="quick-tasks-new" onSelect={() => navigate(`${index}new`)}>
        <PlusIcon />
        New task
      </DropdownMenuItem>
      {recent.length > 0 ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-meta text-muted-foreground">Recent</DropdownMenuLabel>
          {recent.map((run) => (
            <DropdownMenuItem key={run.id} className={ITEM} data-slot="quick-tasks-recent" onSelect={() => navigate(`${index}tasks/${encodeURIComponent(run.id)}`)}>
              <StatusDot tone={statusTone(run.status)} className="mx-1 size-2 shrink-0" />
              <span className="min-w-0 truncate">{runTitle(run)}</span>
            </DropdownMenuItem>
          ))}
        </>
      ) : null}
      {statuses.length > 0 ? (
        <>
          <DropdownMenuSeparator />
          {statuses.map(({ status, count }) => (
            <DropdownMenuItem key={status} className={ITEM} data-slot="quick-tasks-status" data-status={status} onSelect={() => navigate(`${index}tasks?status=${status}`)}>
              <StatusDot tone={statusTone(status)} className="mx-1 size-2 shrink-0" />
              <span className="capitalize">{status}</span>
              <Count n={count} />
            </DropdownMenuItem>
          ))}
        </>
      ) : null}
      {projects.length > 1 ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem className={ITEM} data-slot="quick-tasks-all" onSelect={() => navigate('/tasks')}>
            <ListChecksIcon />
            All projects’ tasks
          </DropdownMenuItem>
        </>
      ) : null}
    </>
  )
}

export function ManagerQuickActions() {
  const navigate = useNavigate()
  const health = useHealth()
  const managersOn = health.data?.capabilities?.managers === true
  const managers = useManagers(managersOn).data?.managers
  const questions = useQuestions().data?.counts.live ?? 0
  const recent = React.useMemo(
    () => [...(managers ?? [])]
      .filter((manager) => manager.inactive === undefined)
      .sort((a, b) => (b.lastActivityAt ?? b.updatedAt).localeCompare(a.lastActivityAt ?? a.updatedAt))
      .slice(0, 4),
    [managers],
  )
  return (
    <>
      {recent.length > 0 ? (
        <>
          <DropdownMenuLabel className="text-meta text-muted-foreground">Message</DropdownMenuLabel>
          {recent.map((manager) => {
            const attention = managerAttention(manager)
            return (
              <DropdownMenuItem key={manager.id} className={ITEM} data-slot="quick-manager-open" onSelect={() => navigate(`/manager/${encodeURIComponent(manager.id)}`)}>
                <span aria-hidden="true" className={cn('mx-1 size-2 shrink-0 rounded-full', attention ? MANAGER_ATTENTION_DOT[attention] : 'bg-muted-foreground/40')} />
                <span className="min-w-0 truncate">{manager.name}</span>
              </DropdownMenuItem>
            )
          })}
          <DropdownMenuSeparator />
        </>
      ) : null}
      <DropdownMenuItem className={ITEM} data-slot="quick-manager-questions" onSelect={() => navigate(managersOn ? '/manager/questions' : '/questions')}>
        <InboxIcon />
        Questions
        <Count n={questions} />
      </DropdownMenuItem>
      {managersOn ? (
        <DropdownMenuItem className={ITEM} data-slot="quick-manager-new" onSelect={() => navigate('/manager/new')}>
          <PlusIcon />
          New manager
        </DropdownMenuItem>
      ) : null}
    </>
  )
}

export function MoreQuickActions({ index }: { index: string }) {
  const navigate = useNavigate()
  return (
    <>
      <DropdownMenuItem className={ITEM} data-slot="quick-more-settings" onSelect={() => navigate(`${index}settings`)}>
        <SettingsIcon />
        Settings
      </DropdownMenuItem>
      <DropdownMenuItem className={ITEM} data-slot="quick-more-assets" onSelect={() => navigate(`${index}assets`)}>
        <LayersIcon />
        Assets
      </DropdownMenuItem>
      <DropdownMenuItem className={ITEM} data-slot="quick-more-workflows" onSelect={() => navigate(`${index}workflows`)}>
        <WorkflowIcon />
        Workflows
      </DropdownMenuItem>
    </>
  )
}
