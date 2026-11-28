import { BotIcon, CheckCheckIcon, ChevronRightIcon, MessageCircleQuestionIcon, PlusIcon } from 'lucide-react'
import { useMemo, useState, useSyncExternalStore } from 'react'
import { Link, Navigate, useLocation, useSearchParams } from 'react-router'

import { managerKeys, orderManagers, useManagers } from '@/api/managers'
import { useLiveQuestionCount } from '@/api/questions'
import { useShellTasksTab } from '@/components/app-shell'
import { CacheStatusChip } from '@/components/cache-status'
import { useHealth, useWorkspaceConfig } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useNow } from '@/lib/use-now'
import { noteManagerChatSource } from '@/lib/manager-telemetry'
import type { ManagerSummary } from '@open-mercato/cezar-api-client'

import { carriesComposerFocus, FOCUS_COMPOSER } from './manager-focus'
import { ManagerIndexLoading } from './manager-loading'
import { ManagerDirectoryCard } from './manager-directory-card'
import { DeviceChip } from '@/components/device-avatar'
import { isCezarShell } from '@/lib/phone-app'
import { ManagerNewRoute } from './manager-new'
import { InactiveDivider, workspaceCountClass } from './manager-sidebar'

const DESKTOP = '(min-width: 768px)'

/** No `matchMedia` (a prerender, a bare test) reads as desktop: the sidebar has the list there. */
function useDesktopViewport(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia?.(DESKTOP)
      query?.addEventListener('change', notify)
      return () => query?.removeEventListener('change', notify)
    },
    () => window.matchMedia?.(DESKTOP).matches ?? true,
  )
}

// An inactive manager's questions do not count (spec 2026-11-19-manager-deactivate); its approvals do.
const waitsOnUser = (manager: ManagerSummary) => manager.pendingActions > 0 || (manager.inactive === undefined && manager.pendingQuestions > 0)

/** Approvals and questions first, then `orderManagers`' recency: a sort of the same order, because
 *  desktop `/manager` and the palette rely on that one staying most-recent-first. */
export function pendingFirst(managers: readonly ManagerSummary[]): ManagerSummary[] {
  return [...managers].sort((a, b) => Number(waitsOnUser(b)) - Number(waitsOnUser(a)))
}

/** The Manager index's Workspace block (Questions inbox design § 02): the phone's way to the two
 *  workspace pages, which the desktop reaches from the sidebar. Also the CezarBot home. */
function WorkspaceRows({ managers }: { managers: readonly ManagerSummary[] }) {
  const questions = useLiveQuestionCount()
  const approvals = managers.reduce((sum, manager) => sum + manager.pendingActions, 0)
  const rows = [
    { to: '/manager/questions', slot: 'manager-index-questions', icon: MessageCircleQuestionIcon, label: 'Questions', count: questions, noun: 'waiting' },
    { to: '/manager/approvals', slot: 'manager-index-approvals', icon: CheckCheckIcon, label: 'Approvals', count: approvals, noun: 'pending' },
  ]
  return (
    <nav aria-label="Workspace" data-slot="manager-index-workspace" className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
      {rows.map(({ to, slot, icon: Icon, label, count, noun }) => (
        <Link
          key={to}
          to={to}
          data-slot={slot}
          aria-label={count === undefined ? label : `${label}, ${count} ${noun}`}
          className="flex min-h-12 items-center gap-3 px-3.5 text-ui font-medium outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50"
        >
          <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="flex-1">{label}</span>
          {count !== undefined ? <span className={workspaceCountClass(count)}>{count}</span> : null}
          <ChevronRightIcon aria-hidden="true" className="size-4 text-muted-foreground" />
        </Link>
      ))}
    </nav>
  )
}

/** The phone has no sidebar column, so its list is a screen (spec, Surface). */
function ManagerListScreen({ managers, isFetching, isError }: { managers: readonly ManagerSummary[]; isFetching: boolean; isError: boolean }) {
  const now = useNow(60_000)
  const deviceLabel = useWorkspaceConfig().data?.computerName ?? 'This device'
  const [search, setSearch] = useState('')
  const [needsYou, setNeedsYou] = useState(false)
  // Live attention updates change card contents without moving the user's target.
  const [order] = useState(() => pendingFirst(managers).map((manager) => manager.id))
  const entries = [...managers].sort((a, b) => {
    const rank = (id: string) => { const index = order.indexOf(id); return index < 0 ? order.length : index }
    return rank(a.id) - rank(b.id)
  }).filter((manager) => (!needsYou || waitsOnUser(manager)) && `${manager.name} ${deviceLabel}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
    .map((manager) => ({ key: `current-device/${manager.id}`, deviceLabel, manager, href: `/manager/${encodeURIComponent(manager.id)}` }))
  const inactiveEntries = entries.filter((entry) => entry.manager.inactive !== undefined)
  return (
    <div data-route="manager-list" className="@container/directory mx-auto flex w-full max-w-[1200px] flex-col gap-3 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><h1 className="text-lg font-semibold">Managers</h1>{isCezarShell() ? <DeviceChip name={deviceLabel} /> : <span className="text-sm text-muted-foreground">{deviceLabel}</span>}</div>
      <CacheStatusChip queryKey={managerKeys.list} isFetching={isFetching} isError={isError} className="mx-1 mb-1 self-start" />
      <WorkspaceRows managers={managers} />
      <div className="flex flex-wrap items-center gap-3">
        {/* A 12rem basis wraps the filter below rather than squeezing the search to a few letters at large text. */}
        <Input aria-label="Search managers or device" placeholder="Search managers" value={search} onChange={(event) => setSearch(event.target.value)} className="min-h-12 min-w-0 flex-[1_1_12rem]" />
        <label data-slot="manager-needs-you-filter" className="flex min-h-12 cursor-pointer items-center gap-2 rounded-md border border-border px-3 text-sm has-checked:border-info/60 has-checked:bg-info/10 has-focus-visible:ring-[3px] has-focus-visible:ring-ring/50">
          <input type="checkbox" className="size-4" checked={needsYou} onChange={(event) => setNeedsYou(event.target.checked)} />Needs you
        </label>
      </div>
      {entries.length === 0 ? <p role="status" className="p-3 text-muted-foreground">No matching managers</p> : null}
      <div className="grid grid-cols-1 gap-3 @min-[576px]/directory:grid-cols-2 @min-[936px]/directory:grid-cols-3">
        {entries.filter((entry) => entry.manager.inactive === undefined).map((entry) => <ManagerDirectoryCard key={entry.key} entry={entry} now={now} />)}
      </div>
      {inactiveEntries.length > 0 ? (
        <>
          <InactiveDivider count={inactiveEntries.length} className="px-0.5 pt-1" />
          <div className="grid grid-cols-1 gap-3 @min-[576px]/directory:grid-cols-2 @min-[936px]/directory:grid-cols-3">
            {inactiveEntries.map((entry) => <ManagerDirectoryCard key={entry.key} entry={entry} now={now} />)}
          </div>
        </>
      ) : null}
      <Button asChild variant="ghost" className="mt-1 justify-start gap-2 text-muted-foreground pointer-coarse:min-h-11">
        <Link to="/manager/new">
          <PlusIcon aria-hidden="true" className="size-4" />
          New manager
        </Link>
      </Button>
    </div>
  )
}

/** `/manager`: the most recent chat, the list with `?all=1` or several on a phone, or the first-run
 *  setup. `all=1` is the chat's back arrow: one manager must not loop straight back into it. */
export function ManagerIndexRoute() {
  const enabled = useHealth().data?.capabilities.managers === true
  const managers = useManagers(enabled)
  // The phone navigation (a tablet in CezarBot) has no sidebar list: the list screen is it.
  const phoneNav = useShellTasksTab()?.everyWidth === true
  const desktop = useDesktopViewport() && !phoneNav
  const [params] = useSearchParams()
  const location = useLocation()
  const ordered = useMemo(() => orderManagers(managers.data?.managers ?? []), [managers.data])
  // The first-run form's create lands here before its own navigate can say where focus goes.
  const [firstRun, setFirstRun] = useState(false)
  if (managers.data && ordered.length === 0 && !firstRun) setFirstRun(true)
  // A failed refresh over a cached list keeps the list; its chip says it is old.
  if (managers.isError && !managers.data) return <CenteredState icon={<BotIcon aria-hidden="true" />} tone="danger" title="Managers are unavailable" subtitle={managers.error.message} />
  if (!managers.data) return <ManagerIndexLoading />
  if (ordered.length === 0) return <ManagerNewRoute />
  if (params.get('all') === '1' || (!desktop && ordered.length > 1)) return <ManagerListScreen managers={ordered} isFetching={managers.isFetching} isError={managers.isError} />
  noteManagerChatSource('auto', { ifUnset: true })
  // A delete lands here on its way to the next chat, as does a first-run create: pass focus on.
  return <Navigate to={`/manager/${encodeURIComponent(ordered[0]!.id)}`} replace {...(firstRun || carriesComposerFocus(location.state) ? { state: FOCUS_COMPOSER } : {})} />
}
