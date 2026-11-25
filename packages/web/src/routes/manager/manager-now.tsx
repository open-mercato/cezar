import type { AttentionOverride, ManagerSummary, RunIndexEntry } from '@open-mercato/cezar-api-client'
import { CheckIcon, FilterIcon, XIcon } from 'lucide-react'
import * as React from 'react'
import { Link, useSearchParams } from 'react-router'

import { useAttention } from '@/api/attention'
import { orderManagers, useManagers } from '@/api/managers'
import { useRunsIndex } from '@/api/queries'
import { ScreenLoading } from '@/components/loading-state'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { LiveNowProvider } from '@/lib/live-now'
import { cn } from '@/lib/utils'
import { AttentionRow, type AttentionActions } from '@/routes/now/now-attention'
import { ProbablyDoneGroup, type TriageActions } from '@/routes/now/now-triage'
import { isHidden, itemTarget, shortLabel } from '@/routes/now/now-triage-model'
import { useNeedsYouActions } from '@/routes/now/use-needs-you-actions'

import { ManagerAvatar } from './manager-avatar'
import {
  MANAGER_FILTER_PARAM,
  countLive,
  managerFilter,
  managerNowEntries,
  ownedBy,
  type ManagerNowEntry,
} from './manager-now-model'
import { ManagerProjectsContext } from './manager-reference'
import { taskPath } from './manager-session-card'

/**
 * Now in Manager mode (spec 2026-11-23-needs-you-triage § Manager mode): every manager's items by
 * default, a filter to narrow it to one. The rows are Now's own: answer, approve, ✕, ⋯, Probably done.
 */

type FilterManager = Pick<ManagerSummary, 'id' | 'name' | 'avatar' | 'mascot'>

export function ManagerNowView({
  entries,
  managers,
  filter,
  onFilter,
  overrides,
  pendingQuestions,
  running,
  actions,
  triage,
}: {
  entries: readonly ManagerNowEntry[]
  managers: readonly FilterManager[]
  /** A manager's id, or undefined for All managers. */
  filter: string | undefined
  onFilter: (managerId: string | undefined) => void
  overrides?: readonly AttentionOverride[] | undefined
  pendingQuestions: ReadonlySet<string>
  running: readonly RunIndexEntry[]
  actions: AttentionActions
  triage: TriageActions
}) {
  const visible = entries.filter((entry) => !isHidden(itemTarget(entry.item), overrides, pendingQuestions))
  const shown = ownedBy(visible, filter)
  const live = shown.filter((entry) => !entry.item.settled)
  const done = shown.filter((entry) => entry.item.settled)
  const nameOf = (id: string) => managers.find((manager) => manager.id === id)?.name ?? id
  const selected = filter === undefined ? undefined : managers.find((manager) => manager.id === filter)
  const countFor = (id: string | undefined) => countLive(ownedBy(visible, id))
  const source = (entry: ManagerNowEntry) => (entry.item.managerId ? undefined : `Task of ${entry.owners.map(nameOf).join(', ')}`)
  const menu = (
    <DropdownMenuContent align="end" className="w-64" data-slot="manager-now-filter-menu">
      <DropdownMenuItem data-slot="manager-now-filter-all" onSelect={() => onFilter(undefined)}>
        <span className="flex-1">All managers</span>
        <span className="font-mono text-meta text-muted-foreground tabular-nums">{countFor(undefined)}</span>
        {filter === undefined ? <CheckIcon aria-hidden="true" /> : <span className="size-4" />}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      {managers.map((manager) => (
        <DropdownMenuItem key={manager.id} data-slot="manager-now-filter-option" data-manager-id={manager.id} onSelect={() => onFilter(manager.id)}>
          <ManagerAvatar avatar={manager.avatar} mascot={manager.mascot} className="size-5 rounded-md" sizes="20px" />
          <span className="min-w-0 flex-1 truncate">{manager.name}</span>
          <span className="font-mono text-meta text-muted-foreground tabular-nums">{countFor(manager.id)}</span>
          {filter === manager.id ? <CheckIcon aria-hidden="true" /> : <span className="size-4" />}
        </DropdownMenuItem>
      ))}
    </DropdownMenuContent>
  )
  const label = selected ? selected.name : 'All managers'
  return (
    <div data-route="manager-now" className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">Now</h1>
        <span className="text-label text-muted-foreground">Managers</span>
        <div className="flex-1" />
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="sm" data-slot="manager-now-filter" data-filter={filter ?? 'all'}>
              <FilterIcon className="size-3.5" aria-hidden="true" />
              {label}
              <span className="font-mono text-meta text-muted-foreground tabular-nums">{countFor(filter)}</span>
            </Button>
          </DropdownMenuTrigger>
          {menu}
        </DropdownMenu>
      </header>
      <div className="flex flex-1 flex-col gap-6 p-3 pb-[calc(140px+env(safe-area-inset-bottom))] md:p-6 md:pb-6">
        {selected ? (
          <p data-slot="manager-now-filtered" className="text-label text-muted-foreground">
            Showing <span className="font-medium text-foreground">{selected.name}</span>: its questions, approvals and messages, and the tasks it started or follows.{' '}
            <button type="button" data-slot="manager-now-show-all" className="font-medium text-foreground underline underline-offset-2" onClick={() => onFilter(undefined)}>
              Show all managers
            </button>
          </p>
        ) : null}
        <section data-slot="manager-now-needs-you" data-count={countLive(live)} className="flex flex-col gap-1.5">
          <h2 className="eyebrow mb-1 flex items-center gap-2 text-muted-foreground">
            Needs you
            <span className="rounded-full bg-muted px-1.5 font-mono text-micro font-medium tracking-normal text-foreground tabular-nums normal-case">{countLive(live)}</span>
          </h2>
          {live.length === 0 ? (
            <p data-slot="now-empty" className="px-1 py-2 text-label text-muted-foreground">
              {selected ? `Nothing from ${selected.name} needs you.` : 'Nothing from your managers needs you.'}
            </p>
          ) : live.map((entry, index) => (
            <AttentionRow key={entry.item.key} item={entry.item} actions={actions} triage={triage} source={source(entry)} hint={index === 0} />
          ))}
          <ProbablyDoneGroup count={done.length} onDismissAll={() => triage.dismissAll(done.map((entry) => itemTarget(entry.item, shortLabel(entry.item.title))))}>
            {done.map((entry) => <AttentionRow key={entry.item.key} item={entry.item} actions={actions} triage={triage} source={source(entry)} />)}
          </ProbablyDoneGroup>
        </section>
        <section data-slot="manager-now-running" className="flex flex-col gap-1.5">
          <h2 className="eyebrow mb-1 flex items-center gap-2 text-muted-foreground">
            {selected ? 'Its tasks running' : 'Managers’ tasks running'}
            <span className="rounded-full bg-muted px-1.5 font-mono text-micro font-medium tracking-normal text-foreground tabular-nums normal-case">{running.length}</span>
          </h2>
          {running.length === 0 ? <p className="px-1 py-2 text-label text-muted-foreground">Nothing is running.</p> : running.map((run) => (
            <Link key={`${run.projectId}/${run.id}`} to={taskPath(run.projectId, run.id)} data-slot="manager-now-running-row"
              className="flex items-center gap-3 rounded-[10px] border border-border bg-card px-3.5 py-3 text-ui">
              <StatusDot tone="violet" pulse aria-label="Running" />
              <span className="min-w-0 flex-1 truncate font-medium">{run.titleSummary ?? run.title}</span>
            </Link>
          ))}
        </section>
      </div>
      {/* The phone's filter: a floating button over the list (owner decision 2026-11-23). */}
      <div className="fixed right-4 bottom-[calc(16px+var(--phone-bar,0px)+env(safe-area-inset-bottom))] z-20 md:hidden">
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-slot="manager-now-filter-fab"
              data-filter={filter ?? 'all'}
              aria-label={selected ? `Showing ${selected.name}. Change the manager` : 'Filter by manager'}
              className={cn(
                'inline-flex h-12 items-center gap-2 rounded-full px-4 text-ui font-medium shadow-modal',
                selected ? 'bg-primary text-primary-foreground' : 'border border-border bg-card text-foreground',
              )}
            >
              <FilterIcon className="size-4" aria-hidden="true" />
              {selected ? selected.name : 'All managers'}
            </button>
          </DropdownMenuTrigger>
          {menu}
        </DropdownMenu>
        {selected ? (
          <button type="button" data-slot="manager-now-fab-clear" aria-label="Show all managers" onClick={() => onFilter(undefined)}
            className="absolute -top-2 -right-2 inline-flex size-6 items-center justify-center rounded-full border border-border bg-background text-muted-foreground">
            <XIcon className="size-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </div>
  )
}

const NO_MANAGERS: ManagerSummary[] = []

/** `/manager/now`: the route, wired to the attention list, the managers and the runs index. */
export function ManagerNowRoute() {
  const attention = useAttention()
  const managers = useManagers(true)
  const runsIndex = useRunsIndex()
  const [search, setSearch] = useSearchParams()
  const ordered = React.useMemo(() => orderManagers(managers.data?.managers ?? NO_MANAGERS), [managers.data])
  const filter = managerFilter(search, ordered)
  const { attentionActions, triage, pendingQuestions, referenceProjects, stopDialog } = useNeedsYouActions()
  const entries = React.useMemo(() => managerNowEntries(attention.data?.items ?? [], ordered), [attention.data, ordered])
  const running = React.useMemo(() => {
    const followed = new Set((filter === undefined ? ordered : ordered.filter((manager) => manager.id === filter)).flatMap((manager) => manager.followedTasks))
    return (runsIndex.data?.runs ?? []).filter((run) => run.status === 'running' && followed.has(`${run.projectId}/${run.id}`))
  }, [runsIndex.data, ordered, filter])
  // A requested manager waits for the list rather than flashing All managers first; an unknown id falls
  // back to All only once the list says it is unknown.
  // Only while the list is on its way: a failed list (409, 5xx, offline) falls back to All managers.
  const waiting = managers.isPending && managers.fetchStatus !== 'idle' && search.has(MANAGER_FILTER_PARAM)
  const onFilter = React.useCallback((managerId: string | undefined) => {
    setSearch((current) => {
      const next = new URLSearchParams(current)
      if (managerId === undefined) next.delete(MANAGER_FILTER_PARAM)
      else next.set(MANAGER_FILTER_PARAM, managerId)
      return next
    })
  }, [setSearch])
  if (waiting) return <ScreenLoading label="Loading managers…" />
  return (
    <LiveNowProvider intervalMs={30_000}>
      <ManagerProjectsContext.Provider value={referenceProjects}>
        <ManagerNowView
          entries={entries}
          managers={ordered}
          filter={filter}
          onFilter={onFilter}
          overrides={attention.data?.overrides}
          pendingQuestions={pendingQuestions}
          running={running}
          actions={attentionActions}
          triage={triage}
        />
        {stopDialog}
      </ManagerProjectsContext.Provider>
    </LiveNowProvider>
  )
}
