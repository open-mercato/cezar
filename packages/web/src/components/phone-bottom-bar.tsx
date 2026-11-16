import { BotIcon, CircleDotIcon, EllipsisIcon, ListChecksIcon, PlusIcon } from 'lucide-react'
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
 * Now, Tasks, New task, Manager and More for a phone PWA (spec 2026-10-31-managers, Phones; the
 * redesign's one-sidebar items). The bar mounts only with managers on and the PWA opens on
 * Manager, so Manager is a tab; Git stays one tap away in More. `md:hidden`: a phone wide enough
 * in landscape has the real sidebar instead; CezarBot has none at any width. Mounted only there, which is what lets it read the
 * query cache from the QueryClient-free shell. Project items point into the last project's
 * index, so they never restore the page inside it. In a manager chat, Tasks is that manager's. A
 * thread opened from a manager keeps Manager current, and the tab leads back to that chat.
 */
export function PhoneBottomBar({
  menuOpen,
  onMore,
  manager = false,
  attention = null,
  managerTo = '/manager',
  managerTasks = null,
  everyWidth = false,
}: {
  menuOpen: boolean
  onMore: () => void
  /** On a manager page: the Manager tab is current. */
  manager?: boolean
  attention?: ManagerAttention | null
  /** Where Manager leads from a project; inside Manager it goes back to the list, like a tab bar. */
  managerTo?: string
  /** In a manager chat: Tasks opens the tasks it started, not the project's. */
  managerTasks?: ManagerTasksTab | null
  /** CezarBot: the navigation on a tablet too. */
  everyWidth?: boolean
}) {
  const keyboardOpen = useKeyboardOpen()
  const health = useHealth()
  const projects = useProjects()
  const location = useLocation()
  const navigate = useNavigate()
  const runId = matchPath({ path: '/tasks/:id/*', end: true }, stripProjectPrefix(location.pathname))?.params.id
  const origin = useThreadOrigin(runId, location.state)
  if (keyboardOpen) return null
  const bootProject = projects.data?.bootProject ?? health.data?.bootProject
  // The current page first: the store is written in an effect, after this render.
  const index = lastProjectIndex(locationToSave(location, projects.data) ?? readStoredLastLocation(), projects.data, bootProject)
  // The global table is Tasks too: a manager's "View all" lands there.
  const active = origin ? null : activeNavPath(stripProjectPrefix(location.pathname))
  const managerCurrent = manager || origin !== undefined
  // Straight from that chat, Back is the way: the chat keeps its place and history stays linear.
  const backToOrigin = origin !== undefined && managerOriginOf(location.state)?.id === origin.id && location.key !== 'default'
  const managerHref = origin
    ? `/manager/${encodeURIComponent(origin.id)}`
    : !manager ? managerTo : location.pathname === '/manager' ? `/manager${location.search}` : '/manager?all=1'
  const item = (to: string, label: string, Icon: typeof CircleDotIcon, area: string) => (
    <Link to={`${index}${to}`} aria-current={active === area ? 'page' : undefined} className={cn(ITEM, active === area && CURRENT)}>
      <Icon className="size-5" aria-hidden="true" />
      {label}
    </Link>
  )
  return (
    <nav aria-label="App" data-slot="phone-bottom-bar" className={cn('flex border-t border-border bg-background', !everyWidth && 'md:hidden')}>
      {item('', 'Now', CircleDotIcon, '/')}
      {managerTasks ? (
        <button
          type="button"
          aria-label={managerTasks.count > 0 ? `Tasks, ${managerTasks.count} started by this manager` : 'Tasks started by this manager'}
          aria-haspopup="dialog"
          aria-expanded={managerTasks.expanded}
          data-slot="bottom-bar-manager-tasks"
          onClick={managerTasks.open}
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
      ) : item('tasks', 'Tasks', ListChecksIcon, '/tasks')}
      <Link to={`${index}new`} aria-label="New task" data-slot="bottom-bar-new-task" className={cn(ITEM, 'text-foreground')}>
        <span className="flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <PlusIcon className="size-5" aria-hidden="true" />
        </span>
      </Link>
      <Link
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
      </Link>
      {/* Not a SheetTrigger: Radix keeps one trigger ref, and this one unmounts with the keyboard,
          which would strand the top bar's focus return. */}
      <button type="button" aria-haspopup="dialog" aria-expanded={menuOpen} onClick={onMore} className={ITEM}>
        <EllipsisIcon className="size-5" aria-hidden="true" />
        More
      </button>
    </nav>
  )
}
