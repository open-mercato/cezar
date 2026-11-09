import { PlusIcon } from 'lucide-react'
import { memo, useMemo } from 'react'
import { Link, useLocation } from 'react-router'

import { orderManagers, useManagers } from '@/api/managers'
import { useHealth } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { useSidebarNavigate } from '@/components/app-shell'
import { UnreadMarker } from '@/components/unread-marker'
import { managerRowPreview, managerTimeLabel } from '@/lib/managers'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'
import type { ManagerSummary } from '@open-mercato/cezar-api-client'

import { ManagerAvatar } from './manager-avatar'

/** Memoized with a numeric `now`: a frame for one manager re-renders that row, not all thirty. */
export const ManagerRow = memo(function ManagerRow({
  manager,
  active,
  now,
  onNavigate,
}: {
  manager: ManagerSummary
  active: boolean
  /** Epoch ms. */
  now: number
  onNavigate?: (() => void) | undefined
}) {
  const unread = managerUnread(manager)
  return (
    <Link
      to={`/manager/${encodeURIComponent(manager.id)}`}
      data-slot="manager-row"
      data-unread={unread || undefined}
      aria-current={active ? 'page' : undefined}
      onClick={onNavigate}
      className={cn(
        'flex min-h-16 items-center gap-2.5 rounded-xl px-2 py-1.5 outline-none transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50',
        active && 'bg-muted',
      )}
    >
      <ManagerAvatar avatar={manager.avatar} mascot={manager.mascot} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={cn('min-w-0 flex-1 truncate text-ui', unread ? 'font-semibold text-foreground' : 'font-medium')}>
            {manager.name}
            {unread ? <UnreadMarker /> : null}
          </span>
          {unread ? (
            <span data-slot="manager-unread" className="size-2 shrink-0 self-center rounded-full bg-info" aria-hidden="true" />
          ) : (
            <span className="shrink-0 text-meta text-soft-foreground">{managerTimeLabel(manager.lastActivityAt, new Date(now))}</span>
          )}
        </span>
        <span className="block truncate text-meta text-muted-foreground">{managerRowPreview(manager)}</span>
      </span>
    </Link>
  )
})

function managerUnread(manager: ManagerSummary): boolean {
  return manager.unread > 0 || manager.pendingActions > 0 || manager.pendingQuestions > 0
}

function useOrderedManagers(): ManagerSummary[] {
  const enabled = useHealth().data?.capabilities.managers === true
  const managers = useManagers(enabled).data?.managers
  return useMemo(() => orderManagers(managers ?? []), [managers])
}

/** One manager in the folded rail: its static portrait (never the animated mascot), named by
 *  `aria-label`/`title` since the rail has no room for text. */
export const ManagerRailItem = memo(function ManagerRailItem({ manager, active }: { manager: ManagerSummary; active: boolean }) {
  const unread = managerUnread(manager)
  return (
    <Link
      to={`/manager/${encodeURIComponent(manager.id)}`}
      data-slot="manager-rail-item"
      data-unread={unread || undefined}
      aria-current={active ? 'page' : undefined}
      aria-label={unread ? `${manager.name}, unread` : manager.name}
      title={manager.name}
      className={cn(
        'relative flex size-9 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50',
        active && 'bg-muted ring-1 ring-border',
      )}
    >
      <ManagerAvatar avatar={manager.avatar} mascot={manager.mascot} className="size-7" />
      {unread ? (
        <span
          data-slot="manager-unread"
          className="absolute top-0.5 right-0.5 size-2 rounded-full bg-info ring-2 ring-sidebar"
          aria-hidden="true"
        />
      ) : null}
    </Link>
  )
})

/** Manager mode's slice of the icon rail (#1967): one thumbnail per manager, so folding never
 *  hides them. */
export function ManagerRail() {
  const { pathname } = useLocation()
  const ordered = useOrderedManagers()
  if (ordered.length === 0) return null
  return (
    <nav
      aria-label="Managers"
      data-slot="manager-rail"
      className="flex min-h-0 flex-col items-center gap-1 overflow-y-auto overscroll-contain pt-2"
    >
      {ordered.map((manager) => (
        <ManagerRailItem
          key={manager.id}
          manager={manager}
          active={pathname === `/manager/${encodeURIComponent(manager.id)}`}
        />
      ))}
    </nav>
  )
}

/** Manager mode's sidebar body: the rows and the way to add one. */
export function ManagerSidebar() {
  const { pathname } = useLocation()
  const onNavigate = useSidebarNavigate()
  const ordered = useOrderedManagers()
  const now = useNow(60_000)
  return (
    <div className="flex flex-col gap-0.5">
      {ordered.map((manager) => (
        <ManagerRow
          key={manager.id}
          manager={manager}
          active={pathname === `/manager/${encodeURIComponent(manager.id)}`}
          now={now}
          onNavigate={onNavigate}
        />
      ))}
      {ordered.length > 0 ? (
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="mt-1 justify-start gap-2 text-muted-foreground"
        >
          <Link to="/manager/new" data-slot="new-manager" onClick={onNavigate}>
            <PlusIcon aria-hidden="true" className="size-4" />
            New manager
          </Link>
        </Button>
      ) : null}
    </div>
  )
}
