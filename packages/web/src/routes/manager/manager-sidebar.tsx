import { CheckCheckIcon, ClockIcon, PlusIcon, SettingsIcon } from 'lucide-react'
import { lazy, memo, Suspense, useMemo, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router'

import { managerKeys, orderManagers, useManagers, useUpdateManager } from '@/api/managers'
import { CacheStatusChip } from '@/components/cache-status'
import { useHealth } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { NAV_ROW_CLASS, useSidebarNavigate } from '@/components/app-shell'
import { shortAge } from '@/lib/format'
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

function useOrderedManagers(): { ordered: ManagerSummary[]; loading: boolean; isFetching: boolean; isError: boolean } {
  const capability = useHealth().data?.capabilities.managers
  const query = useManagers(capability === true)
  const managers = query.data?.managers
  const ordered = useMemo(() => orderManagers(managers ?? []), [managers])
  // Health still loading counts as pending; managers switched off or a failed list do not.
  return { ordered, loading: query.isPending && capability !== false, isFetching: query.isFetching, isError: query.isError }
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

/** One manager in manager mode's sidebar (design 2026-11 "Manager mode", § 1): portrait, name, the
 *  latest line (blue while it waits on you), then the dot and the age. */
export const ManagerSidebarRow = memo(function ManagerSidebarRow({
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
  const attention = managerAttention(manager)
  const age = shortAge(manager.lastActivityAt ?? manager.createdAt, now)
  return (
    <Link
      to={`/manager/${encodeURIComponent(manager.id)}`}
      data-slot="manager-row"
      data-attention={attention ?? undefined}
      aria-current={active ? 'page' : undefined}
      onClick={() => {
        noteManagerChatSource('sidebar')
        onNavigate?.()
      }}
      className={cn(
        'grid grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md px-2 py-1.5 outline-none transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 max-md:min-h-11',
        active && 'bg-muted',
      )}
    >
      <ManagerAvatar avatar={manager.avatar} mascot={manager.mascot} className="size-[30px]" sizes="30px" />
      <span className="min-w-0">
        <span className={cn('block truncate text-ui text-foreground', attention ? 'font-semibold' : 'font-medium')}>
          {manager.name}
          {attention ? <span data-slot="unread-marker" className="sr-only">{MANAGER_ATTENTION_TEXT[attention]}</span> : null}
        </span>
        <span
          data-slot="manager-row-preview"
          className={cn('block truncate text-label', attention === 'needs-you' ? 'text-info' : 'text-muted-foreground')}
        >
          {managerRowPreview(manager)}
        </span>
      </span>
      <span className="flex flex-col items-end gap-1">
        {attention ? (
          <span data-slot="manager-unread" data-attention={attention} className={cn('size-1.5 rounded-full', MANAGER_ATTENTION_DOT[attention])} aria-hidden="true" />
        ) : null}
        {age ? <span data-slot="manager-row-age" className="text-meta text-muted-foreground tabular-nums">{age}</span> : null}
      </span>
    </Link>
  )
})

// Code-split: the dialog and its pickers load on the first click, not with the shell.
const JobsDialog = lazy(() => import('./manager-settings').then((module) => ({ default: module.JobsDialog })))

/** The Workspace group's Jobs: the active chat's jobs dialog, the same one its gear opens. */
function SidebarJobs({ manager }: { manager: ManagerSummary }) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const update = useUpdateManager(manager.id)
  return (
    <>
      <button
        ref={trigger}
        type="button"
        data-slot="manager-sidebar-jobs"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className={NAV_ROW_CLASS}
      >
        <ClockIcon className="size-4 shrink-0" aria-hidden="true" />
        Jobs
        {manager.jobs.length > 0 ? <span className={WORKSPACE_COUNT_CLASS}>{manager.jobs.length}</span> : null}
      </button>
      {open ? (
        <Suspense fallback={null}>
          <JobsDialog
            manager={manager}
            open
            onOpenChange={(next) => { if (!next) setOpen(false) }}
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              trigger.current?.focus()
            }}
            onSave={(jobs) => update.mutateAsync({ jobs })}
          />
        </Suspense>
      ) : null}
    </>
  )
}

const WORKSPACE_COUNT_CLASS = 'ml-auto rounded-full bg-muted px-1.5 py-px text-micro font-semibold text-muted-foreground tabular-nums'

/**
 * Manager mode's sidebar body, between the switch and the footer (design 2026-11 "Manager mode"):
 * New manager, the managers with their latest line, and a small Workspace group — Approvals (the
 * first chat waiting on you), the active chat's Jobs, and the global Manager settings.
 */
export function ManagerSidebar() {
  const { pathname } = useLocation()
  const onNavigate = useSidebarNavigate()
  const { ordered, loading, isFetching, isError } = useOrderedManagers()
  const now = useNow(60_000)
  const activeId = /^\/manager\/([^/?#]+)$/.exec(pathname)?.[1]
  const active = activeId === undefined || activeId === 'new' ? undefined : ordered.find((manager) => manager.id === decodeURIComponent(activeId))
  const waiting = ordered.reduce((sum, manager) => sum + needsYouCount(manager), 0)
  const firstWaiting = ordered.find((manager) => needsYouCount(manager) > 0)
  return (
    <>
      <div className="px-3 pb-2">
        <Button asChild variant="primary" className="w-full justify-center">
          <Link to="/manager/new" data-slot="new-manager" onClick={onNavigate}>
            <PlusIcon className="size-[15px]" aria-hidden="true" />
            New manager
          </Link>
        </Button>
      </div>
      <div data-slot="manager-sidebar" className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2">
        <nav aria-label="Managers" className="flex flex-col gap-0.5 px-2.5">
          <h2 className="px-2 pt-1 pb-1 eyebrow text-muted-foreground">
            Managers{loading ? '' : ` · ${ordered.length}`}
          </h2>
          <CacheStatusChip queryKey={managerKeys.list} isFetching={isFetching} isError={isError} className="mx-2 mb-1 self-start" />
          {/* The rows' own shape, so the list does not pop in after the chat's skeleton (#2038 walk). */}
          {loading ? (
            <LoadingState label="Loading managers…" data-slot="manager-sidebar-loading">
              <ListSkeleton rows={3} />
            </LoadingState>
          ) : ordered.map((manager) => (
            <ManagerSidebarRow key={manager.id} manager={manager} active={manager.id === active?.id} now={now} onNavigate={onNavigate} />
          ))}
        </nav>
        <nav aria-label="Workspace" data-slot="manager-sidebar-workspace" className="px-2.5">
          <h2 className="px-3 pt-3 pb-1 eyebrow text-muted-foreground">Workspace</h2>
          {/* No approvals page exists: the row opens the first chat whose cards wait on you. */}
          {firstWaiting ? (
            <Link
              to={`/manager/${encodeURIComponent(firstWaiting.id)}`}
              data-slot="manager-sidebar-approvals"
              onClick={() => {
                noteManagerChatSource('sidebar')
                onNavigate?.()
              }}
              className={NAV_ROW_CLASS}
            >
              <CheckCheckIcon className="size-4 shrink-0" aria-hidden="true" />
              Approvals
              <span className={WORKSPACE_COUNT_CLASS}>
                {waiting}
                <span className="sr-only"> waiting on you</span>
              </span>
            </Link>
          ) : null}
          {active ? <SidebarJobs key={active.id} manager={active} /> : null}
          <Link
            to="/settings/global/manager"
            data-slot="manager-sidebar-settings"
            onClick={onNavigate}
            className={NAV_ROW_CLASS}
          >
            <SettingsIcon className="size-4 shrink-0" aria-hidden="true" />
            Manager settings
          </Link>
        </nav>
      </div>
    </>
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
