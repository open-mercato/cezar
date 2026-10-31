import { PlusIcon } from 'lucide-react'
import { useMemo } from 'react'
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

export function ManagerRow({
  manager,
  active,
  now,
  onNavigate,
}: {
  manager: ManagerSummary
  active: boolean
  now: Date
  onNavigate?: () => void
}) {
  const unread = manager.unread > 0 || manager.pendingActions > 0
  return (
    <Link
      to={`/manager/${encodeURIComponent(manager.id)}`}
      data-slot="manager-row"
      data-unread={unread || undefined}
      aria-current={active ? 'page' : undefined}
      onClick={onNavigate}
      className={cn(
        'flex min-h-14 items-center gap-2.5 rounded-lg px-2 py-1.5 outline-none transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50',
        active && 'bg-muted',
      )}
    >
      <ManagerAvatar avatar={manager.avatar} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={cn('min-w-0 flex-1 truncate text-ui', unread ? 'font-semibold text-foreground' : 'font-medium')}>
            {manager.name}
            {unread ? <UnreadMarker /> : null}
          </span>
          {unread ? (
            <span className="size-2 shrink-0 self-center rounded-full bg-info" aria-hidden="true" />
          ) : (
            <span className="shrink-0 text-meta text-soft-foreground">{managerTimeLabel(manager.lastActivityAt, now)}</span>
          )}
        </span>
        <span className="block truncate text-meta text-muted-foreground">{managerRowPreview(manager)}</span>
      </span>
    </Link>
  )
}

/** Manager mode's sidebar body: the rows and the way to add one. */
export function ManagerSidebar() {
  const { pathname } = useLocation()
  const onNavigate = useSidebarNavigate()
  const enabled = useHealth().data?.capabilities.managers === true
  const managers = useManagers(enabled).data?.managers
  const ordered = useMemo(() => orderManagers(managers ?? []), [managers])
  const now = new Date(useNow(60_000))
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
