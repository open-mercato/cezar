import { CheckCheckIcon, CircleDotIcon, ClockIcon, EllipsisIcon, MessageCircleQuestionIcon, MessageSquareIcon, PlayIcon, PlusIcon, PowerIcon, SettingsIcon, Trash2Icon } from 'lucide-react'
import { Fragment, lazy, memo, Suspense, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'

import { managerKeys, orderManagers, useDeleteManager, useManagers, useUpdateManager } from '@/api/managers'
import { useInactiveQuestionCount, useLiveQuestionCount } from '@/api/questions'
import { CacheStatusChip } from '@/components/cache-status'
import { useHealth } from '@/api/queries'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { toast } from '@/components/ui/toaster'
import { NAV_BADGE_CLASS, NAV_ROW_ACTIVE_CLASS, NAV_ROW_CLASS, useSidebarNavigate } from '@/components/app-shell'
import { shortAge } from '@/lib/format'
import { ListSkeleton, LoadingState } from '@/components/loading-state'
import {
  isInactive,
  MANAGER_ATTENTION_DOT,
  MANAGER_ATTENTION_TEXT,
  MANAGER_INACTIVE_DOT,
  managerAttention,
  managerRailSummary,
  managerRowPreview,
  managerTimeLabel,
  needsYouCount,
  splitByActivity,
} from '@/lib/managers'
import { useNow } from '@/lib/use-now'
import { noteManagerChatSource } from '@/lib/manager-telemetry'
import { cn } from '@/lib/utils'
import type { ManagerSummary } from '@open-mercato/cezar-api-client'

import { activityMenuLabel, useManagerActivityActions } from './manager-activity'
import { ManagerAvatar } from './manager-avatar'
import { OPEN_MANAGER_SETTINGS } from './manager-focus'

/** Screen-reader words for an inactive manager, read as part of its row's name. */
const INACTIVE_TEXT = ', inactive'

/** An inactive manager's dot: grey while it holds cards, never blue (spec 2026-11-19-manager-deactivate). */
const dotClass = (manager: ManagerSummary, attention: NonNullable<ReturnType<typeof managerAttention>>) =>
  isInactive(manager) ? MANAGER_INACTIVE_DOT : MANAGER_ATTENTION_DOT[attention]

/** The thin "Inactive · N" line the inactive managers sort under. */
export function InactiveDivider({ count, className }: { count: number; className?: string }) {
  return (
    <div role="presentation" data-slot="manager-inactive-divider" className={cn('flex items-center gap-2 px-2 pt-2 pb-0.5 text-meta text-muted-foreground after:h-px after:flex-1 after:bg-border', className)}>
      Inactive · {count}
    </div>
  )
}

/** Active rows, then the divider and the inactive ones. */
function WithInactiveDivider({ managers, row, className }: { managers: readonly ManagerSummary[]; row: (manager: ManagerSummary) => ReactNode; className?: string }) {
  const { active, inactive } = splitByActivity(managers)
  return (
    <>
      {active.map((manager) => <Fragment key={manager.id}>{row(manager)}</Fragment>)}
      {inactive.length > 0 ? <InactiveDivider count={inactive.length} {...(className ? { className } : {})} /> : null}
      {inactive.map((manager) => <Fragment key={manager.id}>{row(manager)}</Fragment>)}
    </>
  )
}

/** A manager's own menu, from the row's ⋯ or a right-click (design § 02): open, settings,
 *  deactivate or reactivate, delete. `trigger` is the ⋯ button the menu anchors to. */
function ManagerRowMenu({ manager, open, onOpenChange, trigger }: { manager: ManagerSummary; open: boolean; onOpenChange: (open: boolean) => void; trigger: ReactNode }) {
  const navigate = useNavigate()
  const activity = useManagerActivityActions()
  const remove = useDeleteManager(manager.id)
  const [deleting, setDeleting] = useState(false)
  const { label, Icon } = activityMenuLabel(manager)
  const chat = `/manager/${encodeURIComponent(manager.id)}`
  return (
    <>
      <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="right" className="min-w-52" data-slot="manager-row-menu">
          <DropdownMenuItem onSelect={() => navigate(chat)}>
            <MessageSquareIcon aria-hidden="true" />Open chat
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => navigate(chat, { state: OPEN_MANAGER_SETTINGS })}>
            <SettingsIcon aria-hidden="true" />Settings…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem data-slot="manager-row-menu-activity" onSelect={() => void activity.toggle(manager)}>
            <Icon aria-hidden="true" />{label}
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
            <Trash2Icon aria-hidden="true" />Delete…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {activity.dialog}
      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {manager.name}?</AlertDialogTitle>
            <AlertDialogDescription>Its chat history and jobs are gone for good. Tasks it started stay where they are.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-danger text-danger-foreground hover:brightness-[0.96]"
              onClick={() => remove.mutate(undefined, { onError: (error) => toast(error.message, { tone: 'danger' }) })}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

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
  const inactive = isInactive(manager)
  return (
    <Link
      to={`/manager/${encodeURIComponent(manager.id)}`}
      state={state}
      data-slot="manager-row"
      data-unread={attention ? true : undefined}
      data-attention={attention ?? undefined}
      data-inactive={inactive || undefined}
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
      <ManagerAvatar avatar={manager.avatar} mascot={manager.mascot} inactive={inactive} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={cn('min-w-0 flex-1 truncate text-ui', inactive ? 'font-medium text-muted-foreground' : attention ? 'font-semibold text-foreground' : 'font-medium')}>
            {manager.name}
            {inactive ? <span data-slot="inactive-marker" className="sr-only">{INACTIVE_TEXT}</span> : null}
            {attention ? <span data-slot="unread-marker" className="sr-only">{MANAGER_ATTENTION_TEXT[attention]}</span> : null}
          </span>
          <span className="shrink-0 text-meta text-muted-foreground">{managerTimeLabel(manager.lastActivityAt, new Date(now))}</span>
        </span>
        <span className="block truncate text-meta text-muted-foreground">{managerRowPreview(manager)}</span>
      </span>
      {/* A count when something waits on the user, a dot for plain news (design, Proposal 10). */}
      {attention === 'needs-you' && !inactive ? (
        <span
          data-slot="manager-unread"
          data-attention={attention}
          aria-hidden="true"
          className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-info px-1.5 text-micro font-semibold text-background"
        >
          {waiting}
        </span>
      ) : attention ? (
        <span data-slot="manager-unread" data-attention={attention} className={cn('size-2 shrink-0 rounded-full', dotClass(manager, attention))} aria-hidden="true" />
      ) : null}
    </Link>
  )
})

function useOrderedManagers(): { ordered: ManagerSummary[]; loading: boolean; hasData: boolean; isFetching: boolean; isError: boolean } {
  const capability = useHealth().data?.capabilities.managers
  const query = useManagers(capability === true)
  const managers = query.data?.managers
  const ordered = useMemo(() => orderManagers(managers ?? []), [managers])
  // Health still loading counts as pending; managers switched off or a failed list do not.
  return { ordered, loading: query.isPending && capability !== false, hasData: managers !== undefined, isFetching: query.isFetching, isError: query.isError }
}

/** One manager in the folded rail: its static portrait (never the animated mascot), named by
 *  `aria-label`/`title` since the rail has no room for text. */
export const ManagerRailItem = memo(function ManagerRailItem({ manager, active }: { manager: ManagerSummary; active: boolean }) {
  const attention = managerAttention(manager)
  const inactive = isInactive(manager)
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <div className="relative">
      <Link
        to={`/manager/${encodeURIComponent(manager.id)}`}
        data-slot="manager-rail-item"
        data-unread={attention ? true : undefined}
        data-attention={attention ?? undefined}
        data-inactive={inactive || undefined}
        aria-current={active ? 'page' : undefined}
        aria-label={`${manager.name}${inactive ? INACTIVE_TEXT : ''}${attention ? MANAGER_ATTENTION_TEXT[attention] : ''}`}
        title={inactive ? `${manager.name} (inactive)` : manager.name}
        onClick={() => noteManagerChatSource('sidebar')}
        onContextMenu={(event) => {
          event.preventDefault()
          setMenuOpen(true)
        }}
        className={cn(
          'relative flex size-9 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50',
          active && 'bg-muted ring-1 ring-border',
        )}
      >
        <ManagerAvatar avatar={manager.avatar} mascot={manager.mascot} inactive={inactive} className="size-7" />
        {attention ? (
          <span
            data-slot="manager-unread"
            data-attention={attention}
            className={cn('absolute top-0.5 right-0.5 size-2 rounded-full ring-2 ring-sidebar', dotClass(manager, attention))}
            aria-hidden="true"
          />
        ) : null}
      </Link>
      {/* The rail has no room for a ⋯: a right-click opens the menu, anchored to this hidden point. */}
      <ManagerRowMenu
        manager={manager}
        open={menuOpen}
        onOpenChange={setMenuOpen}
        trigger={<button type="button" tabIndex={-1} aria-hidden="true" data-slot="manager-rail-menu-anchor" className="pointer-events-none absolute top-1/2 right-0 size-0 opacity-0" />}
      />
    </div>
  )
})

/** Manager mode's slice of the icon rail (#1967): one thumbnail per manager, so folding never
 *  hides them. */
export function ManagerRail() {
  const { pathname } = useLocation()
  const { ordered } = useOrderedManagers()
  if (ordered.length === 0) return null
  const { active: on, inactive: off } = splitByActivity(ordered)
  return (
    <nav
      aria-label="Managers"
      data-slot="manager-rail"
      className="flex min-h-0 flex-col items-center gap-1 overflow-y-auto overscroll-contain pt-2"
    >
      {on.map((manager) => (
        <ManagerRailItem key={manager.id} manager={manager} active={pathname === `/manager/${encodeURIComponent(manager.id)}`} />
      ))}
      {off.length > 0 ? <span role="presentation" data-slot="manager-rail-inactive-divider" className="my-1 h-px w-6 shrink-0 bg-border" /> : null}
      {off.map((manager) => (
        <ManagerRailItem key={manager.id} manager={manager} active={pathname === `/manager/${encodeURIComponent(manager.id)}`} />
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
  const inactive = isInactive(manager)
  const age = shortAge(manager.lastActivityAt ?? manager.createdAt, now)
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <div data-slot="manager-row-wrap" data-menu-open={menuOpen || undefined} className="group/row relative">
      <Link
        to={`/manager/${encodeURIComponent(manager.id)}`}
        data-slot="manager-row"
        data-attention={attention ?? undefined}
        data-inactive={inactive || undefined}
        aria-current={active ? 'page' : undefined}
        onClick={() => {
          noteManagerChatSource('sidebar')
          onNavigate?.()
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          setMenuOpen(true)
        }}
        className={cn(
          'grid grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md px-2 py-1.5 outline-none transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 max-md:min-h-11',
          active && 'bg-muted',
        )}
      >
        <ManagerAvatar avatar={manager.avatar} mascot={manager.mascot} inactive={inactive} className="size-[30px]" sizes="30px" />
        <span className="min-w-0">
          <span className={cn('block truncate text-ui', inactive ? 'font-medium text-muted-foreground' : attention ? 'font-semibold text-foreground' : 'font-medium text-foreground')}>
            {manager.name}
            {inactive ? <span data-slot="inactive-marker" className="sr-only">{INACTIVE_TEXT}</span> : null}
            {attention ? <span data-slot="unread-marker" className="sr-only">{MANAGER_ATTENTION_TEXT[attention]}</span> : null}
          </span>
          <span
            data-slot="manager-row-preview"
            className={cn('block truncate text-label', inactive ? 'text-muted-foreground' : attention === 'needs-you' ? 'text-info' : 'text-muted-foreground')}
          >
            {managerRowPreview(manager)}
          </span>
        </span>
        {/* Hidden under the ⋯ while the row is hovered or its menu is open (design § 02). */}
        <span className="flex flex-col items-end gap-1 group-hover/row:invisible group-has-[[data-state=open]]/row:invisible">
          {attention ? (
            <span data-slot="manager-unread" data-attention={attention} className={cn('size-1.5 rounded-full', dotClass(manager, attention))} aria-hidden="true" />
          ) : null}
          {age ? <span data-slot="manager-row-age" className="text-meta text-muted-foreground tabular-nums">{age}</span> : null}
        </span>
      </Link>
      <ManagerRowMenu
        manager={manager}
        open={menuOpen}
        onOpenChange={setMenuOpen}
        trigger={
          <button
            type="button"
            aria-label={`More for ${manager.name}`}
            data-slot="manager-row-more"
            className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md border border-border bg-card text-muted-foreground opacity-0 outline-none hover:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 group-hover/row:opacity-100 data-[state=open]:opacity-100 pointer-coarse:hidden"
          >
            <EllipsisIcon aria-hidden="true" className="size-3.5" />
          </button>
        }
      />
    </div>
  )
})

/** The Managers heading's ⋯ (design § 02): every manager off or back on at once. */
function ManagersBulkMenu({ managers }: { managers: readonly ManagerSummary[] }) {
  const activity = useManagerActivityActions()
  const { active, inactive } = splitByActivity(managers)
  if (managers.length === 0) return null
  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Managers menu" data-slot="managers-bulk-menu" className="ml-auto size-6 pointer-coarse:size-11">
            <EllipsisIcon aria-hidden="true" className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          <DropdownMenuLabel className="text-meta font-normal text-muted-foreground">{active.length} active · {inactive.length} inactive</DropdownMenuLabel>
          <DropdownMenuItem data-slot="managers-deactivate-all" disabled={active.length === 0} onSelect={() => void activity.deactivateAll(managers)}>
            <PowerIcon aria-hidden="true" />Deactivate all…
          </DropdownMenuItem>
          <DropdownMenuItem data-slot="managers-reactivate-all" disabled={inactive.length === 0} onSelect={() => void activity.reactivateAll(managers)}>
            <PlayIcon aria-hidden="true" />Reactivate all
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {activity.dialog}
    </>
  )
}

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
        {manager.jobs.length > 0 ? <span className={workspaceCountClass(0)}>{manager.jobs.length}</span> : null}
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

/** Info fill while something waits on the user, the muted pill at zero (Questions inbox design § 01). */
export function workspaceCountClass(count: number): string {
  return cn('ml-auto rounded-full px-1.5 py-px text-micro font-semibold tabular-nums', count > 0 ? 'bg-info text-background' : 'bg-muted text-muted-foreground')
}

/** The Workspace group's Questions row: every open question, managers' and tasks' (spec
 *  2026-11-17-questions-inbox). Also the project sidebar's row when managers are off. */
export function QuestionsNavLink({ to, onNavigate, className }: { to: string; onNavigate?: (() => void) | undefined; className?: string }) {
  const { pathname } = useLocation()
  const count = useLiveQuestionCount()
  const fromInactive = useInactiveQuestionCount()
  const active = pathname === to
  return (
    <Link
      to={to}
      data-slot="sidebar-questions"
      title={fromInactive > 0 ? `${fromInactive} more from inactive managers, not counted` : undefined}
      aria-label={count === undefined ? 'Questions' : `Questions, ${count} waiting`}
      aria-current={active ? 'page' : undefined}
      onClick={onNavigate}
      className={cn(NAV_ROW_CLASS, className, active && 'bg-muted text-foreground')}
    >
      <MessageCircleQuestionIcon className="size-4 shrink-0" aria-hidden="true" />
      Questions
      {count !== undefined ? <span data-slot="sidebar-questions-count" data-count={count} className={workspaceCountClass(count)}>{count}</span> : null}
    </Link>
  )
}

/** The project sidebar's Questions row, for a cockpit with managers off. */
export function ProjectQuestionsLink() {
  return <QuestionsNavLink to="/questions" onNavigate={useSidebarNavigate()} />
}

/** The Workspace group's Now: the project nav's Now row, with its needs-you badge, the way the
 *  phone bottom bar offers it from Manager. */
function NowNavLink({ to, count, onNavigate }: { to: string; count: number | null; onNavigate?: (() => void) | undefined }) {
  const { pathname } = useLocation()
  // Manager mode's own Now (spec 2026-11-23-needs-you-triage), not a project's.
  const active = pathname === to
  return (
    <Link
      to={to}
      data-slot="manager-sidebar-now"
      aria-current={active ? 'page' : undefined}
      onClick={onNavigate}
      className={cn(NAV_ROW_CLASS, active && NAV_ROW_ACTIVE_CLASS)}
    >
      <CircleDotIcon className="size-4 shrink-0" aria-hidden="true" />
      Now
      {count ? (
        <span data-slot="nav-needs-you-badge" title={`${count} ${count === 1 ? 'thing from your managers needs' : 'things from your managers need'} you`} className={NAV_BADGE_CLASS}>
          {count}
        </span>
      ) : null}
    </Link>
  )
}

/**
 * Manager mode's sidebar body, between the switch and the footer (design 2026-11 "Manager mode"):
 * New manager, the managers with their latest line, and a small Workspace group — Now, workspace
 * Approvals and Questions, the active chat's Jobs, and the global Manager settings.
 */
export function ManagerSidebar({ nowTo = '/manager/now', nowCount = null }: {
  /** Manager mode's Now: every manager's items. */
  nowTo?: string
  /** Its needs-you count; null while unknown. */
  nowCount?: number | null
} = {}) {
  const { pathname } = useLocation()
  const onNavigate = useSidebarNavigate()
  const { ordered, loading, hasData, isFetching, isError } = useOrderedManagers()
  const now = useNow(60_000)
  const activeId = /^\/manager\/([^/?#]+)$/.exec(pathname)?.[1]
  const active = activeId === undefined || activeId === 'new' ? undefined : ordered.find((manager) => manager.id === decodeURIComponent(activeId))
  const waiting = ordered.reduce((sum, manager) => sum + manager.pendingActions, 0)
  const approvalsActive = pathname === '/manager/approvals'
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
          <div className="flex items-center gap-1 px-2 pt-1 pb-1">
            <h2 className="eyebrow text-muted-foreground">
              Managers{loading ? '' : ` · ${ordered.length}`}
            </h2>
            {loading ? null : <ManagersBulkMenu managers={ordered} />}
          </div>
          <CacheStatusChip queryKey={managerKeys.list} isFetching={isFetching} isError={isError} className="mx-2 mb-1 self-start" />
          {/* The rows' own shape, so the list does not pop in after the chat's skeleton (#2038 walk). */}
          {loading ? (
            <LoadingState label="Loading managers…" data-slot="manager-sidebar-loading">
              <ListSkeleton rows={3} />
            </LoadingState>
          ) : (
            <WithInactiveDivider managers={ordered} row={(manager) => <ManagerSidebarRow manager={manager} active={manager.id === active?.id} now={now} onNavigate={onNavigate} />} />
          )}
        </nav>
        <nav aria-label="Workspace" data-slot="manager-sidebar-workspace" className="px-2.5">
          <h2 className="px-3 pt-3 pb-1 eyebrow text-muted-foreground">Workspace</h2>
          <NowNavLink to={nowTo} count={nowCount} onNavigate={onNavigate} />
          <Link
            to="/manager/approvals"
            data-slot="manager-sidebar-approvals"
            aria-label={hasData ? `Approvals, ${waiting} pending ${waiting === 1 ? 'approval' : 'approvals'}` : 'Approvals'}
            aria-current={approvalsActive ? 'page' : undefined}
            onClick={onNavigate}
            className={cn(NAV_ROW_CLASS, approvalsActive && 'bg-muted text-foreground')}
          >
            <CheckCheckIcon className="size-4 shrink-0" aria-hidden="true" />
            Approvals
            {hasData ? <span data-slot="sidebar-approvals-count" className={workspaceCountClass(waiting)}>
              {waiting}
              <span className="sr-only"> pending approvals</span>
            </span> : null}
          </Link>
          <QuestionsNavLink to="/manager/questions" onNavigate={onNavigate} />
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
        ) : (
          <WithInactiveDivider managers={ordered} row={(manager) => <ManagerRow manager={manager} active={manager.id === activeId} now={now} />} />
        )}
      </div>
      {ordered.length > 0 ? (
        <p data-slot="manager-rail-summary" className="border-t border-border px-3.5 py-2.5 text-meta text-muted-foreground">
          {managerRailSummary(ordered)}
        </p>
      ) : null}
    </aside>
  )
}
