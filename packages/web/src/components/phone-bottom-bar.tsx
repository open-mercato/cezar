import { BotIcon, CircleDotIcon, EllipsisIcon, ListChecksIcon } from 'lucide-react'
import * as React from 'react'
import { Link, matchPath, useLocation, useNavigate } from 'react-router'

import type { ManagerTasksTab } from '@/components/app-shell'

import { useHealth, useProjects } from '@/api/queries'
import { activeNavPath } from '@/components/nav-items'
import { useKeyboardOpen } from '@/lib/keyboard-inset'
import { locationToSave, readStoredLastLocation } from '@/lib/last-location'
import { noteManagerEntry } from '@/lib/manager-telemetry'
import { MANAGER_ATTENTION_DOT, MANAGER_ATTENTION_TEXT, managerOriginOf, type ManagerAttention, type ManagerOrigin } from '@/lib/managers'
import { lastProjectIndex } from '@/lib/phone-app'
import { stripProjectPrefix } from '@/lib/project-router'
import { MANAGER_NOW_PATH } from '@/routes/manager/manager-now-model'
import {
  ManagerQuickActions,
  MoreQuickActions,
  NowQuickActions,
  QuickActionsBackdrop,
  QuickActionsHint,
  TabQuickMenu,
  TasksQuickActions,
  useTabQuickActions,
  type QuickTab,
} from '@/components/tab-quick-actions'
import { cn } from '@/lib/utils'

const ITEM =
  'relative flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-meta font-medium text-muted-foreground outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50'
const CURRENT = 'font-semibold text-foreground'

/** The manager a thread was opened from, kept across the task's own tabs, whose links carry no state. */
function useThreadOrigin(runId: string | undefined, state: unknown): ManagerOrigin | undefined {
  const fromEntry = managerOriginOf(state)
  const [held, setHeld] = React.useState<{ runId?: string; origin?: ManagerOrigin }>({})
  if (held.runId !== runId || (fromEntry !== undefined && fromEntry.id !== held.origin?.id)) setHeld({ runId, origin: fromEntry })
  return fromEntry ?? (held.runId === runId ? held.origin : undefined)
}

/**
 * Compact navigation (spec 2026-10-31-managers, Phones). Project links use the current or last
 * project; a task opened from Manager keeps its originating chat as the Manager destination.
 */
export function PhoneBottomBar({
  menuOpen,
  onMore,
  manager = false,
  attention = null,
  nowCount = null,
  managerTo = '/manager',
  managerTasks = null,
  everyWidth = false,
}: {
  menuOpen: boolean
  onMore: () => void
  /** On a manager page: the Manager tab is current. */
  manager?: boolean
  attention?: ManagerAttention | null
  /** What needs you on this computer: the attention list's total (spec 2026-11-20-phone-notifications-inbox). */
  nowCount?: number | null
  /** Where Manager leads from a project; inside Manager it goes back to the list, like a tab bar. */
  managerTo?: string
  /** In a manager chat: Tasks opens the tasks it started, not the project's. */
  managerTasks?: ManagerTasksTab | null
  /** The shell selected compact navigation, including inside a narrow desktop container. */
  everyWidth?: boolean
}) {
  const keyboardOpen = useKeyboardOpen()
  const health = useHealth()
  const projects = useProjects()
  const location = useLocation()
  const navigate = useNavigate()
  const runId = matchPath({ path: '/tasks/:id/*', end: true }, stripProjectPrefix(location.pathname))?.params.id
  const origin = useThreadOrigin(runId, location.state)
  const quick = useTabQuickActions()
  const slots = React.useRef<Partial<Record<QuickTab, HTMLElement | null>>>({})
  // Navigating (a menu choice, Back) closes it.
  const { setOpen: setQuickOpen } = quick
  React.useEffect(() => setQuickOpen(null), [location.key, setQuickOpen])
  if (keyboardOpen) return null
  const bootProject = projects.data?.bootProject ?? health.data?.bootProject
  // The current page first: the store is written in an effect, after this render.
  const index = lastProjectIndex(locationToSave(location, projects.data) ?? readStoredLastLocation(), projects.data, bootProject)
  // The global table is Tasks too: a manager's "View all" lands there.
  // In Manager mode Now is the managers' own (spec 2026-11-23-needs-you-triage), never a project's.
  const managerNow = manager && location.pathname === MANAGER_NOW_PATH
  const active = origin ? null : managerNow ? '/' : manager ? null : activeNavPath(stripProjectPrefix(location.pathname))
  const managerCurrent = (manager && !managerNow) || origin !== undefined
  // Straight from that chat, Back is the way: the chat keeps its place and history stays linear.
  const backToOrigin = (location.state as Record<string, unknown> | null)?.managerHistoryBack !== false && origin !== undefined && managerOriginOf(location.state)?.id === origin.id && location.key !== 'default'
  const managerHref = origin
    ? `/manager/${encodeURIComponent(origin.id)}`
    : !manager ? managerTo : location.pathname === '/manager' ? `/manager${location.search}` : '/manager?all=1'
  const menu = (tab: QuickTab, align: 'start' | 'center' | 'end', children: React.ReactNode) => (
    <TabQuickMenu
      tab={tab}
      open={quick.open === tab}
      onOpenChange={(open) => quick.setOpen(open ? tab : null)}
      align={align}
      returnFocus={() => slots.current[tab]?.querySelector<HTMLElement>('a,button') ?? null}
    >
      {children}
    </TabQuickMenu>
  )
  const slot = (tab: QuickTab, element: React.ReactNode, quickMenu: React.ReactNode) => (
    <div ref={(node) => { slots.current[tab] = node }} data-slot="bottom-bar-tab" data-held={quick.open === tab || undefined} className="relative flex min-w-0 flex-1 rounded-xl data-held:bg-accent/60">
      {element}
      {quickMenu}
      {/* Once per bar, inside a tab slot so the bar's children stay its four tabs. */}
      {tab === 'now' ? <><QuickActionsHint /><QuickActionsBackdrop open={quick.open !== null} /></> : null}
    </div>
  )
  const item = (to: string, label: string, Icon: typeof CircleDotIcon, area: string, count: number | null = null, absolute = false, tab: QuickTab = 'now') => (
    <Link
      {...quick.bind(tab)}
      to={absolute ? to : `${index}${to}`}
      aria-current={active === area ? 'page' : undefined}
      aria-label={count ? `${label}, ${count} ${count === 1 ? 'thing needs' : 'things need'} you` : undefined}
      className={cn(ITEM, active === area && CURRENT)}
    >
      <Icon className="size-5" aria-hidden="true" />
      {label}
      {count ? (
        <span
          aria-hidden="true"
          data-slot="bottom-bar-now-count"
          className="absolute top-1.5 left-[calc(50%+6px)] flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-micro font-semibold text-danger-foreground tabular-nums"
        >
          {count > 99 ? '99+' : count}
        </span>
      ) : null}
    </Link>
  )
  return (
    <nav
      aria-label="App"
      data-slot="phone-bottom-bar"
      // No native link callout or preview: it showed the shell's loopback URL (#tab-bar-quick-actions).
      className={cn('relative z-50 flex border-t border-border bg-background select-none [-webkit-touch-callout:none]', !everyWidth && 'md:hidden')}
    >
      {slot(
        'now',
        manager ? item(MANAGER_NOW_PATH, 'Now', CircleDotIcon, '/', nowCount, true) : item('', 'Now', CircleDotIcon, '/', nowCount),
        menu('now', 'start', <NowQuickActions index={index} nowCount={nowCount} />),
      )}
      {managerTasks ? (
        <button
          type="button"
          aria-label={managerTasks.count > 0 ? `Tasks, ${managerTasks.count} started by this manager` : 'Tasks started by this manager'}
          aria-haspopup="dialog"
          aria-expanded={managerTasks.expanded}
          data-slot="bottom-bar-manager-tasks"
          onClick={managerTasks.open}
          onContextMenu={(event) => event.preventDefault()}
          className={ITEM}
        >
          <ListChecksIcon className="size-5" aria-hidden="true" />
          Tasks
          {managerTasks.count > 0 ? (
            <span
              aria-hidden="true"
              className="absolute top-1.5 left-[calc(50%+6px)] flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-micro font-semibold text-primary-foreground tabular-nums"
            >
              {managerTasks.count}
            </span>
          ) : null}
        </button>
      ) : slot('tasks', item('tasks', 'Tasks', ListChecksIcon, '/tasks', null, false, 'tasks'), menu('tasks', 'center', <TasksQuickActions index={index} />))}
      {slot(
        'manager',
        <Link
          {...quick.bind('manager')}
          to={managerHref}
          aria-current={managerCurrent ? 'page' : undefined}
          onClick={(event) => {
            if (!manager) noteManagerEntry('bottom_bar')
            if (!backToOrigin || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
            event.preventDefault()
            void navigate(-1)
          }}
          data-slot="bottom-bar-manager"
          className={cn(ITEM, managerCurrent && CURRENT)}
        >
          <BotIcon className="size-5" aria-hidden="true" />
          Manager
          {attention ? (
            <span data-slot="bottom-bar-attention" className="absolute top-2 left-[calc(50%+8px)] flex">
              <span className={cn('size-1.5 rounded-full', MANAGER_ATTENTION_DOT[attention])} aria-hidden="true" />
              <span className="sr-only">{MANAGER_ATTENTION_TEXT[attention]}</span>
            </span>
          ) : null}
        </Link>,
        menu('manager', 'center', <ManagerQuickActions />),
      )}
      {/* Not a SheetTrigger: Radix keeps one trigger ref, and this one unmounts with the keyboard,
          which would strand the top bar's focus return. */}
      {slot(
        'more',
        <button {...quick.bind('more')} type="button" aria-haspopup="dialog" aria-expanded={menuOpen} onClick={onMore} className={ITEM}>
          <EllipsisIcon className="size-5" aria-hidden="true" />
          More
        </button>,
        menu('more', 'end', <MoreQuickActions index={index} />),
      )}
    </nav>
  )
}
