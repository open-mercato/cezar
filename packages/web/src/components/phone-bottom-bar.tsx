import { BotIcon, CircleDotIcon, EllipsisIcon, ListChecksIcon, PlusIcon } from 'lucide-react'
import { Link, useLocation } from 'react-router'

import { useHealth, useProjects } from '@/api/queries'
import { activeNavPath } from '@/components/nav-items'
import { useKeyboardOpen } from '@/lib/keyboard-inset'
import { locationToSave, readStoredLastLocation } from '@/lib/last-location'
import { noteManagerEntry } from '@/lib/manager-telemetry'
import { MANAGER_ATTENTION_DOT, MANAGER_ATTENTION_TEXT, type ManagerAttention } from '@/lib/managers'
import { lastProjectIndex } from '@/lib/phone-app'
import { stripProjectPrefix } from '@/lib/project-router'
import { cn } from '@/lib/utils'

const ITEM =
  'relative flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-meta font-medium text-muted-foreground outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50'
const CURRENT = 'font-semibold text-foreground'

/**
 * Now, Tasks, New task, Manager and More for a phone PWA (spec 2026-10-31-managers, Phones; the
 * redesign's one-sidebar items). The bar mounts only with managers on and the PWA opens on
 * Manager, so Manager is a tab; Git stays one tap away in More. `md:hidden`: a phone wide enough
 * in landscape has the real sidebar instead. Mounted only there, which is what lets it read the
 * query cache from the QueryClient-free shell. Project items point into the last project's
 * index, so they never restore the page inside it.
 */
export function PhoneBottomBar({
  menuOpen,
  onMore,
  manager = false,
  attention = null,
  managerTo = '/manager',
}: {
  menuOpen: boolean
  onMore: () => void
  /** On a manager page: the Manager tab is current. */
  manager?: boolean
  attention?: ManagerAttention | null
  /** Where Manager leads from a project; inside Manager it goes back to the list, like a tab bar. */
  managerTo?: string
}) {
  const keyboardOpen = useKeyboardOpen()
  const health = useHealth()
  const projects = useProjects()
  const location = useLocation()
  if (keyboardOpen) return null
  const bootProject = projects.data?.bootProject ?? health.data?.bootProject
  // The current page first: the store is written in an effect, after this render.
  const index = lastProjectIndex(locationToSave(location, projects.data) ?? readStoredLastLocation(), projects.data, bootProject)
  const active = location.pathname === '/tasks' ? null : activeNavPath(stripProjectPrefix(location.pathname))
  const item = (to: string, label: string, Icon: typeof CircleDotIcon, area: string) => (
    <Link to={`${index}${to}`} aria-current={active === area ? 'page' : undefined} className={cn(ITEM, active === area && CURRENT)}>
      <Icon className="size-5" aria-hidden="true" />
      {label}
    </Link>
  )
  return (
    <nav aria-label="App" data-slot="phone-bottom-bar" className="flex border-t border-border bg-background md:hidden">
      {item('', 'Now', CircleDotIcon, '/')}
      {item('tasks', 'Tasks', ListChecksIcon, '/tasks')}
      <Link to={`${index}new`} aria-label="New task" data-slot="bottom-bar-new-task" className={cn(ITEM, 'text-foreground')}>
        <span className="flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <PlusIcon className="size-5" aria-hidden="true" />
        </span>
      </Link>
      <Link
        to={!manager ? managerTo : location.pathname === '/manager' ? `/manager${location.search}` : '/manager?all=1'}
        aria-current={manager ? 'page' : undefined}
        onClick={() => { if (!manager) noteManagerEntry('bottom_bar') }}
        data-slot="bottom-bar-manager"
        className={cn(ITEM, manager && CURRENT)}
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
