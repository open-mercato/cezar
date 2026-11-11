import { PlusIcon } from 'lucide-react'
import { memo, useMemo } from 'react'
import { Link, useLocation } from 'react-router'

import { orderManagers, useManagers } from '@/api/managers'
import { useHealth } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { useSidebarNavigate } from '@/components/app-shell'
import { ListSkeleton, LoadingState } from '@/components/loading-state'
import {
  MANAGER_ATTENTION_DOT,
  MANAGER_ATTENTION_TEXT,
  managerAttention,
  managerRailSummary,
  managerRowPreview,
  managerTimeLabel,
  needsYouCount,
} from '@/lib/managers'
import { useNow } from '@/lib/use-now'
import { noteManagerChatSource } from '@/lib/manager-telemetry'
import { cn } from '@/lib/utils'
import type { ManagerSummary } from '@open-mercato/cezar-api-client'

import { ManagerAvatar } from './manager-avatar'

/** Memoized with a numeric `now`: a frame for one manager re-renders that row, not all thirty. */
export const ManagerRow = memo(function ManagerRow({
  manager,
  active,
  now,
  onNavigate,
  state,
  source = 'sidebar',
}: {
  manager: ManagerSummary
  active: boolean
  /** Epoch ms. */
  now: number
  onNavigate?: (() => void) | undefined
  state?: unknown
  /** `manager_chat_opened`'s label for a tap on this row. */
  source?: 'sidebar' | 'list'
}) {
  const attention = managerAttention(manager)
  const waiting = needsYouCount(manager)
  return (
    <Link
      to={`/manager/${encodeURIComponent(manager.id)}`}
      state={state}
      data-slot="manager-row"
      data-unread={attention ? true : undefined}
      data-attention={attention ?? undefined}
      aria-current={active ? 'page' : undefined}
      onClick={() => {
        noteManagerChatSource(source)
        onNavigate?.()
      }}
      className={cn(
        'flex min-h-16 items-center gap-2.5 rounded-xl px-2 py-1.5 outline-none transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50',
        active && 'bg-muted',
      )}
    >
      <ManagerAvatar avatar={manager.avatar} mascot={manager.mascot} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={cn('min-w-0 flex-1 truncate text-ui', attention ? 'font-semibold text-foreground' : 'font-medium')}>
            {manager.name}
            {attention ? <span data-slot="unread-marker" className="sr-only">{MANAGER_ATTENTION_TEXT[attention]}</span> : null}
          </span>
          <span className="shrink-0 text-meta text-muted-foreground">{managerTimeLabel(manager.lastActivityAt, new Date(now))}</span>
        </span>
        <span className="block truncate text-meta text-muted-foreground">{managerRowPreview(manager)}</span>
      </span>
      {/* A count when something waits on the user, a dot for plain news (design, Proposal 10). */}
      {attention === 'needs-you' ? (
        <span
          data-slot="manager-unread"
          data-attention={attention}
          aria-hidden="true"
          className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-info px-1.5 text-micro font-semibold text-background"
        >
          {waiting}
        </span>
      ) : attention ? (
        <span data-slot="manager-unread" data-attention={attention} className={cn('size-2 shrink-0 rounded-full', MANAGER_ATTENTION_DOT[attention])} aria-hidden="true" />
      ) : null}
    </Link>
  )
})

function useOrderedManagers(): { ordered: ManagerSummary[]; loading: boolean } {
  const capability = useHealth().data?.capabilities.managers
  const query = useManagers(capability === true)
  const managers = query.data?.managers
  const ordered = useMemo(() => orderManagers(managers ?? []), [managers])
  // Health still loading counts as pending; managers switched off or a failed list do not.
  return { ordered, loading: query.isPending && capability !== false }
}

/** One manager in the folded rail: its static portrait (never the animated mascot), named by
 *  `aria-label`/`title` since the rail has no room for text. */
export const ManagerRailItem = memo(function ManagerRailItem({ manager, active }: { manager: ManagerSummary; active: boolean }) {
  const attention = managerAttention(manager)
  return (
    <Link
      to={`/manager/${encodeURIComponent(manager.id)}`}
      data-slot="manager-rail-item"
      data-unread={attention ? true : undefined}
      data-attention={attention ?? undefined}
      aria-current={active ? 'page' : undefined}
      aria-label={attention ? `${manager.name}${MANAGER_ATTENTION_TEXT[attention]}` : manager.name}
      title={manager.name}
      onClick={() => noteManagerChatSource('sidebar')}
      className={cn(
        'relative flex size-9 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50',
        active && 'bg-muted ring-1 ring-border',
      )}
    >
      <ManagerAvatar avatar={manager.avatar} mascot={manager.mascot} className="size-7" />
      {attention ? (
        <span
          data-slot="manager-unread"
          data-attention={attention}
          className={cn('absolute top-0.5 right-0.5 size-2 rounded-full ring-2 ring-sidebar', MANAGER_ATTENTION_DOT[attention])}
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
  const { ordered } = useOrderedManagers()
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
  const { ordered, loading } = useOrderedManagers()
  const now = useNow(60_000)
  // The rows' own shape, so the list does not pop in after the chat's skeleton (#2038 walk).
  if (loading) {
    return (
      <LoadingState label="Loading managers…" data-slot="manager-sidebar-loading">
        <ListSkeleton rows={3} />
      </LoadingState>
    )
  }
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

/** The Manager screen's left column (design, Proposal 10): the same rows the sidebar used to
 *  hold, a way to add one, and one line of what all of them watch. Phones keep the list as a
 *  screen of its own (`manager-index`), so the rail hides below `md`. */
export function ManagerListRail({ activeId }: { activeId: string }) {
  const { ordered, loading } = useOrderedManagers()
  const now = useNow(60_000)
  return (
    <aside
      data-slot="manager-list-rail"
      aria-label="Managers"
      className="flex w-60 shrink-0 flex-col border-r border-border bg-card max-md:hidden"
    >
      <div className="flex items-center gap-2 px-3.5 pt-3.5 pb-2">
        <h2 className="text-ui font-semibold">Managers</h2>
        <Button asChild variant="ghost" size="icon-sm" className="ml-auto">
          <Link to="/manager/new" aria-label="New manager" data-slot="new-manager">
            <PlusIcon aria-hidden="true" />
          </Link>
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain px-1.5 pb-2">
        {loading ? (
          <LoadingState label="Loading managers…" data-slot="manager-sidebar-loading">
            <ListSkeleton rows={3} />
          </LoadingState>
        ) : ordered.map((manager) => (
          <ManagerRow key={manager.id} manager={manager} active={manager.id === activeId} now={now} />
        ))}
      </div>
      {ordered.length > 0 ? (
        <p data-slot="manager-rail-summary" className="border-t border-border px-3.5 py-2.5 text-meta text-muted-foreground">
          {managerRailSummary(ordered)}
        </p>
      ) : null}
    </aside>
  )
}
