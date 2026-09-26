import { DashboardAutomations } from './automations'
import { Overview } from './overview'
import { useContext, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import { LayoutDashboardIcon, SlidersHorizontalIcon } from 'lucide-react'
import type {
  DashboardFeed,
  DashboardGroup,
  DashboardSnapshot,
} from '@open-mercato/cezar-api-client'
import { useDashboard, useDashboardTelemetry } from '@/api/dashboard'
import { useDashboardLive } from '@/api/dashboard-live'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { CenteredState } from '@/components/centered-state'
import { shortAge } from '@/lib/format'
import { DashboardUsageCosts } from './costs'
import { DashboardTrends } from './trends'
import { Queue } from './queue'
import { Feed } from './feed'
import { Coverage, TaskRow, taskKey } from './rows'
import { DashboardExportMenu } from './export-menu'
import { ExportRows } from './export-rows'
import { DashboardLayout } from './layout'
import { resetViewOrder, useDashboardPreferences } from './preferences'
import {
  DashboardEntryContext,
  DashboardReconciledContext,
  readEntry,
  saveEntry,
  readPanel,
  savePanel,
  useStagedRows,
} from './state'
import { useDashboardPage, useDisplacedRows } from './pages'

export function DashboardRoute() {
  const location = useLocation()
  const entryKey =
    (location.state as { dashboardEntry?: string } | null)?.dashboardEntry ?? location.key
  return <DashboardView key={entryKey} entryKey={entryKey} />
}

function DashboardView({ entryKey }: { entryKey: string }) {
  const location = useLocation()
  const [search, setSearch] = useSearchParams()
  const restored = useRef(readEntry(entryKey)).current
  const [questions, setQuestions] = useState(restored?.questions ?? 0)
  const [reviews, setReviews] = useState(restored?.reviews ?? 0)
  const [feedCount, setFeedCount] = useState(restored?.feed ?? 6)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLElement | null>(null)
  const [customizeOpen, setCustomizeOpen] = useState(false)
  const preferences = useDashboardPreferences()
  const [technicalOpen, setTechnicalOpen] = useState(false)
  const view = search.get('view') === 'costs' ? 'costs' : 'overview'
  const viewTiles =
    view === 'costs'
      ? (['usage', 'trends'] as const)
      : (['fleet', 'needsYou', 'recent', 'automations'] as const)
  const scope =
    view === 'costs'
      ? [...viewTiles]
      : ['overview' as const, 'portfolio' as const, ...viewTiles]
  const resetOrder = resetViewOrder(preferences.order, scope)
  const showViewTiles = () =>
    preferences.setTiles({
      ...preferences.tiles,
      ...Object.fromEntries(viewTiles.map((id) => [id, true])),
    })
  const savedTiles = preferences.tiles
  const tiles = {
    ...savedTiles,
    automations: view === 'overview' && savedTiles.automations,
    fleet: view === 'overview' && savedTiles.fleet,
    needsYou: view !== 'costs' && savedTiles.needsYou,
    recent: view !== 'costs' && savedTiles.recent,
    usage: view === 'costs' && savedTiles.usage,
    trends: view === 'costs' && savedTiles.trends,
  }
  const filter: DashboardFeed['filter'] =
    search.get('feed') === 'tasks'
      ? 'tasks'
      : search.get('feed') === 'github'
        ? 'github'
        : 'all'
  const candidate = search.get('panel')
  const panel =
    candidate && ['running', 'queued', 'scheduled', 'needs-you'].includes(candidate)
      ? (candidate as DashboardGroup)
      : null
  const needsSnapshot =
    tiles.fleet || tiles.needsYou || (tiles.recent && filter !== 'github') || !!panel
  const query = useDashboard(preferences.ready && needsSnapshot)
  const live = useDashboardLive()
  useDashboardTelemetry(preferences.ready && tiles.fleet && technicalOpen)
  const saved = useRef({
    questions,
    reviews,
    feed: feedCount,
    scroll: restored?.scroll ?? 0,
    focus: restored?.focus,
  })
  saved.current = { ...saved.current, questions, reviews, feed: feedCount }
  useEffect(() => {
    const scroller = root.current?.closest('main') ?? root.current
    const onScroll = () => {
      saved.current.scroll = scroller?.scrollTop ?? 0
    }
    const onFocus = () => {
      saved.current.focus =
        document.activeElement
          ?.closest('[data-dashboard-row]')
          ?.getAttribute('data-dashboard-row') ?? undefined
    }
    scroller?.addEventListener('scroll', onScroll)
    document.addEventListener('focusin', onFocus)
    return () => {
      saveEntry(entryKey, saved.current)
      scroller?.removeEventListener('scroll', onScroll)
      document.removeEventListener('focusin', onFocus)
    }
  }, [entryKey])
  const restoredOnce = useRef(false)
  // Costs and the mandatory Overview modules have their own data sources. A
  // hidden operational snapshot must not prevent their Back restoration.
  const restoreReady =
    preferences.ready && (!needsSnapshot || (!!query.data && !query.isFetching))
  useEffect(() => {
    if (!restored || restoredOnce.current || !restoreReady) return
    let stopped = false
    const restore = () => {
      if (stopped) return true
      const scroller = root.current?.closest('main') ?? root.current
      if (scroller) scroller.scrollTop = restored.scroll
      // The first frame can precede async modules or layout. Keep observing
      // until the browser can actually reach the saved position.
      const scrollRestored = !!scroller && Math.abs(scroller.scrollTop - restored.scroll) < 1
      if (!restored.focus) return scrollRestored
      const target = document.querySelector<HTMLElement>(
        `[data-dashboard-row="${CSS.escape(restored.focus)}"] a`,
      )
      if (target) {
        target.focus({ preventScroll: true })
        return scrollRestored
      }
      document.getElementById('dashboard-needs-you')?.focus({ preventScroll: true })
      return false
    }
    const retry = () => {
      if (restore()) stop()
    }
    const observer = new MutationObserver(retry)
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(retry)
    const stop = () => {
      stopped = true
      restoredOnce.current = true
      observer.disconnect()
      resize?.disconnect()
    }
    const frame = requestAnimationFrame(() => {
      retry()
      if (!stopped) {
        observer.observe(document.body, { childList: true, subtree: true })
        if (root.current) resize?.observe(root.current)
      }
    })
    const timer = setTimeout(stop, 5000)
    const interactions = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const
    for (const event of interactions) document.addEventListener(event, stop, { once: true })
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
      stopped = true
      observer.disconnect()
      resize?.disconnect()
      for (const event of interactions) document.removeEventListener(event, stop)
    }
  }, [restored, restoreReady])
  const setPanel = (value: string | null) => {
    const next = new URLSearchParams(search)
    if (value) next.set('panel', value)
    else next.delete('panel')
    setSearch(next, { replace: true, state: { ...location.state, dashboardEntry: entryKey } })
  }
  const open = (group: string, target: HTMLElement) => {
    trigger.current = target
    setPanel(group)
  }
  const count = query.data ? query.data.counts.questions + query.data.counts.reviews : 0
  return (
    <DashboardEntryContext.Provider value={entryKey}>
      <DashboardReconciledContext.Provider
        value={!restored || (!query.isFetching && !query.isError)}
      >
        <div
          ref={root}
          data-route="dashboard"
          className="mx-auto w-full max-w-[1440px] space-y-5 p-4 md:p-6"
        >
          <header className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold">Dashboard</h1>
              <p className="mt-1 text-xs text-muted-foreground">
                Across your workspace · Includes subtasks
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <DashboardExportMenu dashboard={root} />
              <Popover open={customizeOpen} onOpenChange={setCustomizeOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="min-h-11">
                    <SlidersHorizontalIcon className="size-4" />
                    Customize
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="end"
                  className="max-h-[min(32rem,80dvh)] max-w-[calc(100vw-2rem)] overflow-y-auto"
                >
                  <p className="mb-3 text-sm font-medium">Optional modules in this view</p>
                  {viewTiles.map((key) => (
                    <label key={key} className="flex min-h-11 items-center gap-3 text-sm">
                      <input
                        type="checkbox"
                        checked={savedTiles[key]}
                        disabled={!preferences.ready}
                        onChange={(e) =>
                          preferences.setTiles({ ...savedTiles, [key]: e.target.checked })
                        }
                      />
                      {
                        {
                          automations: 'Automations',
                          fleet: 'Queue & scheduling',
                          needsYou: 'Needs you',
                          recent: 'Recent results & GitHub',
                          usage: 'Usage & cost',
                          trends: 'Trends',
                        }[key]
                      }
                    </label>
                  ))}
                  <p className="mt-3 text-xs text-muted-foreground">
                    Drag a module by its handle. With keyboard: Space, arrow keys, Space. Escape
                    cancels.
                  </p>
                  {preferences.order.some((id, index) => id !== resetOrder[index]) && (
                    <Button
                      variant="ghost"
                      className="min-h-11"
                      onClick={() => preferences.setOrder(resetOrder)}
                    >
                      Reset {view === 'overview' ? 'Overview' : 'Usage & cost'} order
                    </Button>
                  )}
                  <p className="my-3 text-xs text-muted-foreground">
                    Shared across browsers using this workspace
                  </p>
                  {viewTiles.some((key) => !savedTiles[key]) && (
                    <Button
                      variant="outline"
                      className="min-h-11"
                      disabled={!preferences.ready}
                      onClick={() => {
                        showViewTiles()
                        setCustomizeOpen(false)
                      }}
                    >
                      Show all in {view === 'overview' ? 'Overview' : 'Usage & cost'}
                    </Button>
                  )}
                </PopoverContent>
              </Popover>
            </div>
          </header>
          <nav aria-label="Dashboard views" className="flex flex-wrap gap-2 border-b pb-3">
            {(
              [
                ['overview', 'Overview'],
                ['costs', 'Usage & cost'],
              ] as const
            ).map(([id, label]) => {
              const next = new URLSearchParams(search)
              next.set('view', id)
              next.delete('panel')
              return (
                <Button
                  key={id}
                  asChild
                  variant={view === id ? 'outline' : 'ghost'}
                  className="min-h-11"
                >
                  <Link
                    aria-current={view === id ? 'page' : undefined}
                    to={`?${next}`}
                    replace={view === id}
                    state={{ ...location.state, dashboardEntry: view === id ? entryKey : undefined }}
                  >
                    {label}
                  </Link>
                </Button>
              )
            })}
          </nav>
          {preferences.failed && (
            <p role="alert" className="text-sm">
              Layout changed for this session, but could not be saved.{' '}
              <Button variant="ghost" className="min-h-11" onClick={preferences.retry}>
                Retry saving
              </Button>
            </p>
          )}
          {needsSnapshot && !live.connected && query.data && (
            <p role="status" className="text-xs text-muted-foreground">
              Tasks disconnected · Last updated {shortAge(query.data.asOf)} ago
            </p>
          )}
          {needsSnapshot && query.isError && (
            <p role="alert" className="rounded-md border p-4 text-sm">
              Could not refresh dashboard.{' '}
              {query.data ? 'Showing the last available task state.' : ''}{' '}
              <Button
                className="min-h-11"
                onClick={() => {
                  void query.refetch()
                }}
              >
                Retry
              </Button>
            </p>
          )}
          {view !== 'overview' && !Object.values(tiles).some(Boolean) ? (
            <CenteredState
              icon={<LayoutDashboardIcon />}
              title="All modules in this view are hidden"
              actions={
                <Button className="min-h-11" onClick={() => showViewTiles()}>
                  Show all in Usage & cost
                </Button>
              }
            />
          ) : null}
          {query.isPending && (tiles.fleet || tiles.needsYou) && (
            <p className="text-sm">Loading dashboard…</p>
          )}
          {needsSnapshot && query.data && (
            <Coverage
              coverage={query.data.coverage}
              count={count}
              retry={() => void query.refetch()}
            />
          )}
          <Overview active={view === 'overview'} onCurrent={open}>
            {(overviewModules) =>
              preferences.ready && (
                <DashboardLayout
                  order={preferences.order}
                  onOrder={preferences.setOrder}
                  modules={{
                    ...overviewModules,
                    automations: tiles.automations ? <DashboardAutomations /> : null,
                    fleet:
                      tiles.fleet && query.data ? (
                        <Card className="gap-0 py-0">
                          <ExportRows
                            rows={Object.entries({
                              queued: query.data.counts.queued,
                              scheduled: query.data.counts.scheduled,
                              monitoring: query.data.counts.monitoring,
                            }).map(([metric, value]) => ({
                              section: 'fleet',
                              metric,
                              value,
                              unit: 'tasks',
                              asOf: query.data!.asOf,
                            }))}
                          />
                          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
                            <h2 className="text-sm font-semibold">Queue & scheduling</h2>
                            <span className="text-xs text-muted-foreground">
                              {live.connected ? 'Tasks connected' : 'Tasks disconnected'}
                            </span>
                          </div>
                          <div className="grid grid-cols-2 divide-x">
                            {(
                              [
                                ['queued', 'Queued', query.data.counts.queued],
                                ['scheduled', 'Scheduled', query.data.counts.scheduled],
                              ] as const
                            ).map(([group, label, total]) => (
                              <button
                                key={group}
                                data-export-keep
                                aria-label={`${label}: ${total}`}
                                className="min-h-24 p-4 text-left hover:bg-muted/50 focus-visible:outline-ring"
                                onClick={(e) => open(group, e.currentTarget)}
                              >
                                <span className="block text-2xl font-semibold tabular-nums">
                                  {total}
                                </span>
                                <span className="text-xs text-muted-foreground">{label}</span>
                              </button>
                            ))}
                          </div>
                          <details
                            open={technicalOpen}
                            onToggle={(event) => setTechnicalOpen(event.currentTarget.open)}
                            className="border-t px-4 py-3 text-xs text-muted-foreground"
                          >
                            <summary className="cursor-pointer py-2">Technical details</summary>
                            <div className="flex flex-wrap gap-x-5 gap-y-2">
                              <span>
                                {query.data.counts.monitoring} monitoring (included in Running)
                              </span>
                              <span>Agent processes</span>
                              {technicalOpen && (
                                <FleetTelemetry running={query.data.counts.running} />
                              )}
                            </div>
                          </details>
                        </Card>
                      ) : null,
                    needsYou:
                      tiles.needsYou && query.data ? (
                        <Queue
                          healthy={!query.isError}
                          snapshot={query.data}
                          questions={questions}
                          reviews={reviews}
                          more={(group, n) =>
                            group === 'questions' ? setQuestions(n) : setReviews(n)
                          }
                        />
                      ) : null,
                    recent: tiles.recent ? (
                      <Feed
                        filter={filter}
                        setFilter={(value) => {
                          const next = new URLSearchParams(search)
                          next.set('feed', value || 'all')
                          setSearch(next, {
                            replace: true,
                            state: { ...location.state, dashboardEntry: entryKey },
                          })
                          setFeedCount(6)
                        }}
                        count={feedCount}
                        more={() => setFeedCount((n) => Math.min(60, n + 20))}
                      />
                    ) : null,
                    usage: tiles.usage ? <DashboardUsageCosts /> : null,
                    trends: tiles.trends ? <DashboardTrends /> : null,
                  }}
                />
              )
            }
          </Overview>
          <Sheet
            open={!!panel}
            onOpenChange={(open) => {
              if (!open) setPanel(null)
            }}
          >
            <SheetContent
              className="w-full overflow-y-auto sm:max-w-lg [&>button]:min-h-11 [&>button]:min-w-11 [&>button]:grid [&>button]:place-items-center"
              onCloseAutoFocus={(e) => {
                e.preventDefault()
                trigger.current?.focus()
              }}
            >
              <SheetHeader>
                <SheetTitle>
                  {panel === 'needs-you'
                    ? 'Needs you'
                    : panel
                      ? panel[0]!.toUpperCase() + panel.slice(1)
                      : 'Tasks'}
                  {query.data && panel
                    ? ` · ${panel === 'needs-you' ? count : query.data.counts[panel as 'running' | 'queued' | 'scheduled']}`
                    : ''}
                </SheetTitle>
                <SheetDescription>
                  Includes subtasks. Open a task to continue in its project.
                </SheetDescription>
              </SheetHeader>
              {!query.data && query.isPending && (
                <p className="p-4" role="status">
                  Loading tasks…
                </p>
              )}
              {!query.data && query.isError && (
                <p className="p-4" role="alert">
                  Could not load tasks.{' '}
                  <Button
                    className="min-h-11"
                    onClick={() => {
                      void query.refetch()
                    }}
                  >
                    Retry
                  </Button>
                </p>
              )}
              {panel && query.data && (
                <TaskPanel key={panel} snapshot={query.data} group={panel} />
              )}
            </SheetContent>
          </Sheet>
        </div>
      </DashboardReconciledContext.Provider>
    </DashboardEntryContext.Provider>
  )
}
function FleetTelemetry({ running }: { running: number }) {
  const { connected, samples } = useDashboardLive()
  const fresh = connected ? samples : []
  const cpus = fresh.filter((s) => s.cpuPct !== null)
  return (
    <>
      <ExportRows
        rows={[
          {
            section: 'telemetry',
            metric: 'cpuPct',
            value: cpus.length ? cpus.reduce((n, s) => n + (s.cpuPct ?? 0), 0) : null,
            unit: '%',
            reportedTasks: cpus.length,
            totalTasks: running,
            note: 'Sum of sampled processes; may exceed 100%',
          },
          {
            section: 'telemetry',
            metric: 'rssBytes',
            value: fresh.length ? fresh.reduce((n, s) => n + s.rssBytes, 0) : null,
            unit: 'bytes',
            reportedTasks: fresh.length,
            totalTasks: running,
          },
        ]}
      />
      <span>
        CPU{' '}
        {cpus.length
          ? `${Math.round(cpus.reduce((n, s) => n + (s.cpuPct ?? 0), 0))}%`
          : 'unavailable'}{' '}
        · {cpus.length}/{running} measured
      </span>
      <span>
        RSS{' '}
        {fresh.length
          ? `${(fresh.reduce((n, s) => n + s.rssBytes, 0) / 1024 ** 3).toFixed(1)} GiB`
          : 'unavailable'}{' '}
        · {fresh.length}/{running} measured
      </span>
      <span>RSS sums process resident memory; CPU may exceed 100%.</span>
    </>
  )
}
function TaskPanel({
  snapshot,
  group,
}: {
  snapshot: DashboardSnapshot
  group: DashboardGroup
}) {
  const entry = useContext(DashboardEntryContext)
  const restored = useRef(readPanel(entry, group)).current
  const [count, setCount] = useState(restored?.count ?? 20)
  const container = useRef<HTMLDivElement>(null)
  const saved = useRef({ count, scroll: restored?.scroll ?? 0 })
  saved.current.count = count
  useEffect(() => {
    const scroller = container.current?.closest<HTMLElement>('[data-slot="sheet-content"]')
    const onScroll = () => {
      saved.current.scroll = scroller?.scrollTop ?? 0
    }
    scroller?.addEventListener('scroll', onScroll)
    return () => {
      savePanel(entry, group, saved.current)
      scroller?.removeEventListener('scroll', onScroll)
    }
  }, [entry, group])
  const query = useDashboardPage(snapshot, group, count)
  const staged = useStagedRows(query.data, taskKey, `panel:${group}`, count)
  const displaced = useDisplacedRows(
    snapshot,
    group,
    count,
    staged.rows.filter((r) => r.removed).map((r) => r.row),
  )
  const heading = useRef<HTMLHeadingElement>(null)
  const panelRestored = useRef(false)
  useEffect(() => {
    if (!query.data || !restored || panelRestored.current) return
    panelRestored.current = true
    const scroller = container.current?.closest<HTMLElement>('[data-slot="sheet-content"]')
    if (scroller) scroller.scrollTop = restored.scroll
  }, [query.data, restored])
  const total =
    group === 'needs-you'
      ? snapshot.counts.questions + snapshot.counts.reviews
      : snapshot.counts[group]
  return (
    <div ref={container}>
      <h3 ref={heading} tabIndex={-1} className="sr-only">
        Tasks
      </h3>
      {query.isPending && <p className="p-4">Loading tasks…</p>}
      {(query.isError || displaced.isError) && (
        <p className="p-4" role="alert">
          Could not check current task state.{' '}
          <Button
            className="min-h-11"
            onClick={() => {
              void query.refetch()
              void displaced.refetch()
            }}
          >
            Retry
          </Button>
        </p>
      )}
      {staged.updates > 0 && (
        <Button
          className="m-4 min-h-11"
          onClick={() => {
            staged.show()
            heading.current?.focus()
          }}
        >
          {staged.updates} updates — Show
        </Button>
      )}
      {staged.rows.map(({ row, removed }) => (
        <TaskRow
          key={taskKey(row)}
          row={displaced.data?.get(taskKey(row)) ?? row}
          removed={removed && !!displaced.data && !displaced.data.has(taskKey(row))}
          checking={!query.data || (removed && !displaced.data)}
          checkFailed={
            (!query.data && query.isError) ||
            (removed && !displaced.data && displaced.isError)
          }
          queue={group === 'needs-you'}
        />
      ))}
      {count < total && (
        <Button
          className="m-4 min-h-11"
          disabled={query.isFetching}
          onClick={() => setCount((n) => n + 20)}
        >
          Show {Math.min(20, total - count)} more tasks
        </Button>
      )}
    </div>
  )
}
