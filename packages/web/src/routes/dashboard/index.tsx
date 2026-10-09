import { DashboardAutomations } from './automations'
import { AutomationOutcomes, BackendComparison } from './insights'
import { Overview } from './overview'
import { useContext, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router'
import { ChevronRightIcon, InboxIcon, LayoutDashboardIcon, SlidersHorizontalIcon } from 'lucide-react'
import { StatusDot } from '@/components/status-dot'
import { DisclosureChevron, disclosureSummary, Notice, WidgetEmpty, WidgetSkeleton, widgetHeader, widgetHeading, widgetMeta } from './presentation'
import type {
  DashboardFeed,
  DashboardGroup,
  DashboardSnapshot,
} from '@open-mercato/cezar-api-client'
import { useDashboard, useDashboardTelemetry } from '@/api/dashboard'
import { useDashboardLive } from '@/api/dashboard-live'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Page, PageBody, PageHeader } from '@/components/page'
import { useDashboardFilter } from './url-filter'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
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

const views = [
  ['overview', 'Overview'],
  ['costs', 'Usage & cost'],
  ['automations', 'Automations'],
] as const

export function DashboardRoute() {
  const location = useLocation()
  const entryKey =
    (location.state as { dashboardEntry?: string } | null)?.dashboardEntry ?? location.key
  return <DashboardView key={entryKey} entryKey={entryKey} />
}

function DashboardView({ entryKey }: { entryKey: string }) {
  const location = useLocation()
  const [search, setSearch] = useSearchParams()
  const navigate = useNavigate()
  // Header period control: the same URL keys the Overview and Automation outcomes modules read.
  const [overviewPeriod, setOverviewPeriod] = useDashboardFilter('period', ['7d', '30d'] as const, '7d')
  const [automationsPeriod, setAutomationsPeriod] = useDashboardFilter('automations', ['7d', '30d'] as const, '7d')
  const restored = useRef(readEntry(entryKey)).current
  const [questions, setQuestions] = useState(restored?.questions ?? 0)
  const [reviews, setReviews] = useState(restored?.reviews ?? 0)
  const [feedCount, setFeedCount] = useState(restored?.feed ?? 6)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLElement | null>(null)
  const [customizeOpen, setCustomizeOpen] = useState(false)
  const preferences = useDashboardPreferences()
  const [technicalOpen, setTechnicalOpen] = useState(false)
  const view =
    search.get('view') === 'costs'
      ? 'costs'
      : search.get('view') === 'automations'
        ? 'automations'
        : 'overview'
  const viewLabel = views.find(([id]) => id === view)![1]
  const viewTiles =
    view === 'costs'
      ? (['usage', 'trends'] as const)
      : view === 'automations'
        ? (['automations'] as const)
        : (['fleet', 'needsYou', 'recent'] as const)
  const scope =
    view === 'overview'
      ? ['overview' as const, 'portfolio' as const, ...viewTiles]
      : [...viewTiles]
  const resetOrder = resetViewOrder(preferences.order, scope)
  const showViewTiles = () =>
    preferences.setTiles({
      ...preferences.tiles,
      ...Object.fromEntries(viewTiles.map((id) => [id, true])),
    })
  const savedTiles = preferences.tiles
  const tiles = {
    ...savedTiles,
    automations: view === 'automations' && savedTiles.automations,
    fleet: view === 'overview' && savedTiles.fleet,
    needsYou: view === 'overview' && savedTiles.needsYou,
    recent: view === 'overview' && savedTiles.recent,
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
  const periodControl =
    view === 'overview'
      ? { label: 'Outcomes period', value: overviewPeriod, set: setOverviewPeriod }
      : view === 'automations'
        ? { label: 'Launched', value: automationsPeriod, set: setAutomationsPeriod }
        : null
  return (
    <DashboardEntryContext.Provider value={entryKey}>
      <DashboardReconciledContext.Provider
        value={!restored || (!query.isFetching && !query.isError)}
      >
        <Page ref={root} width="wide" data-route="dashboard">
          <PageHeader
            title={
              <span className="flex items-center gap-2.5">
                Dashboard
                <Badge
                  data-export-exclude
                  variant="outline"
                  className="gap-1.5 font-normal text-muted-foreground"
                >
                  <StatusDot tone={live.connected ? 'success' : 'neutral'} pulse={live.connected} />
                  {live.connected ? 'Live' : 'Offline'}
                </Badge>
              </span>
            }
            description="How work is going across every project in this workspace, subtasks included."
            actions={
              <>
                {periodControl && (
                  <Select
                    value={periodControl.value}
                    onValueChange={(value) => periodControl.set(value === '30d' ? '30d' : '7d')}
                  >
                    <SelectTrigger size="sm" aria-label={periodControl.label}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="end">
                      <SelectItem value="7d">Last 7 days</SelectItem>
                      <SelectItem value="30d">Last 30 days</SelectItem>
                    </SelectContent>
                  </Select>
                )}
                <DashboardExportMenu dashboard={root} />
                <Popover open={customizeOpen} onOpenChange={setCustomizeOpen}>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm">
                      <SlidersHorizontalIcon />
                      Customize
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="end"
                    className="max-h-[min(32rem,80dvh)] w-80 max-w-[calc(100vw-2rem)] space-y-3 overflow-y-auto"
                  >
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium">Optional modules in this view</p>
                      <p className="text-xs text-muted-foreground">
                        Shared across browsers using this workspace
                      </p>
                    </div>
                    <div>
                      {viewTiles.map((key) => (
                        <Label
                          key={key}
                          className="flex min-h-9 cursor-pointer items-center justify-between gap-3 text-[13px] font-normal no-hover:min-h-11"
                        >
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
                          <Switch
                            checked={savedTiles[key]}
                            disabled={!preferences.ready}
                            onCheckedChange={(checked) =>
                              preferences.setTiles({ ...savedTiles, [key]: checked })
                            }
                          />
                        </Label>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Drag a module by its handle. With keyboard: Space, arrow keys, Space. Escape
                      cancels.
                    </p>
                    {(preferences.order.some((id, index) => id !== resetOrder[index]) ||
                      viewTiles.some((key) => !savedTiles[key])) && (
                      <div className="flex flex-wrap gap-2 border-t pt-3">
                        {viewTiles.some((key) => !savedTiles[key]) && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={!preferences.ready}
                            onClick={() => {
                              showViewTiles()
                              setCustomizeOpen(false)
                            }}
                          >
                            Show all in {viewLabel}
                          </Button>
                        )}
                        {preferences.order.some((id, index) => id !== resetOrder[index]) && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => preferences.setOrder(resetOrder)}
                          >
                            Reset {viewLabel} order
                          </Button>
                        )}
                      </div>
                    )}
                  </PopoverContent>
                </Popover>
              </>
            }
          >
            <Tabs
              value={view}
              activationMode="manual"
              onValueChange={(id) => {
                const next = new URLSearchParams(search)
                next.set('view', id)
                next.delete('panel')
                void navigate(`?${next}`, {
                  state: { ...location.state, dashboardEntry: undefined },
                })
              }}
            >
              <div className="border-b">
                <TabsList variant="line" aria-label="Dashboard views" className="-mb-px gap-4 p-0">
                  {views.map(([id, label]) => (
                    <TabsTrigger key={id} value={id} className="px-0.5 text-[13.5px] after:bottom-0!">
                      {label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>
            </Tabs>
          </PageHeader>
          <PageBody className="space-y-6 pt-2">
          {preferences.failed && (
            <Notice
              action={
                <Button variant="outline" size="sm" onClick={preferences.retry}>
                  Retry saving
                </Button>
              }
            >
              Layout changed for this session, but could not be saved.
            </Notice>
          )}
          {needsSnapshot && !live.connected && query.data && (
            <p role="status" className="text-xs text-muted-foreground">
              Tasks disconnected · Last updated {shortAge(query.data.asOf)} ago
            </p>
          )}
          {needsSnapshot && query.isError && (
            <Notice
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void query.refetch()
                  }}
                >
                  Retry
                </Button>
              }
            >
              Could not refresh dashboard.{' '}
              {query.data ? 'Showing the last available task state.' : ''}
            </Notice>
          )}
          {/* A notice, not a full-view empty state: Backends & models stays on this view, so
              "everything is hidden" would be false while a populated table sits below it. */}
          {view === 'costs' && !Object.values(tiles).some(Boolean) ? (
            <Notice
              tone="neutral"
              action={
                <Button variant="outline" size="sm" onClick={() => showViewTiles()}>
                  Show all in {viewLabel}
                </Button>
              }
            >
              <span className="flex items-center gap-2 text-muted-foreground">
                <LayoutDashboardIcon className="size-4" aria-hidden="true" />
                Optional modules in this view are hidden.
              </span>
            </Notice>
          ) : null}
          {needsSnapshot && query.data && (
            <Coverage
              coverage={query.data.coverage}
              count={count}
              retry={() => void query.refetch()}
            />
          )}
          {view === 'automations' && <AutomationOutcomes />}
          <Overview active={view === 'overview'} onCurrent={open}>
            {(overviewModules) =>
              preferences.ready ? (
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
                          <div className={widgetHeader}>
                            <h2 className={widgetHeading}>Queue & scheduling</h2>
                            <span className={`inline-flex items-center gap-1.5 ${widgetMeta}`}>
                              <StatusDot tone={live.connected ? 'success' : 'neutral'} />
                              {live.connected ? 'Tasks connected' : 'Tasks disconnected'}
                            </span>
                          </div>
                          <div className="grid grid-cols-2 gap-2 px-3 pt-2 pb-1">
                            {(
                              [
                                ['queued', 'Queued', query.data.counts.queued],
                                ['scheduled', 'Scheduled', query.data.counts.scheduled],
                              ] as const
                            ).map(([group, label, total]) => (
                              <button
                                key={group}
                                type="button"
                                data-export-keep
                                aria-label={`${label}: ${total}`}
                                className="group/stat cursor-pointer rounded-lg px-2 py-2.5 text-left transition-colors outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/40"
                                onClick={(e) => open(group, e.currentTarget)}
                              >
                                <span className="flex items-center justify-between text-[13px] text-muted-foreground">
                                  {label}
                                  <ChevronRightIcon
                                    data-export-exclude
                                    className="size-3.5 text-soft-foreground opacity-0 transition-opacity group-hover/stat:opacity-100 group-focus-visible/stat:opacity-100 no-hover:opacity-100"
                                    aria-hidden="true"
                                  />
                                </span>
                                <span className="mt-2 block text-[28px] leading-none font-semibold tracking-tight tabular-nums">
                                  {total}
                                </span>
                              </button>
                            ))}
                          </div>
                          <details
                            open={technicalOpen}
                            onToggle={(event) => setTechnicalOpen(event.currentTarget.open)}
                            className="px-5 pt-1 pb-4 text-xs text-muted-foreground"
                          >
                            <summary className={`${disclosureSummary} py-1.5 no-hover:min-h-11`}>
                              <DisclosureChevron />
                              Technical details
                            </summary>
                            <div className="flex flex-col gap-1 pt-1 pl-5">
                              <span>
                                {query.data.counts.monitoring} monitoring (included in Running)
                              </span>
                              <span className="pt-1 font-medium text-foreground">Agent processes</span>
                              {technicalOpen && (
                                <FleetTelemetry running={query.data.counts.running} />
                              )}
                            </div>
                          </details>
                        </Card>
                      ) : tiles.fleet && query.isPending ? (
                        <ModuleSkeleton title="Queue & scheduling" />
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
                      ) : tiles.needsYou && query.isPending ? (
                        <ModuleSkeleton title="Needs you" />
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
              ) : (
                <WidgetSkeleton label="Loading dashboard…" rows={4} />
              )
            }
          </Overview>
          {view === 'costs' && <BackendComparison />}
          </PageBody>
          <Sheet
            open={!!panel}
            onOpenChange={(open) => {
              if (!open) setPanel(null)
            }}
          >
            <SheetContent
              className="w-full overflow-y-auto sm:max-w-lg"
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
                <WidgetSkeleton label="Loading tasks…" rows={4} className="p-4" />
              )}
              {!query.data && query.isError && (
                <Notice
                  className="m-4"
                  action={
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        void query.refetch()
                      }}
                    >
                      Retry
                    </Button>
                  }
                >
                  Could not load tasks.
                </Notice>
              )}
              {panel && query.data && (
                <TaskPanel key={panel} snapshot={query.data} group={panel} />
              )}
            </SheetContent>
          </Sheet>
        </Page>
      </DashboardReconciledContext.Provider>
    </DashboardEntryContext.Provider>
  )
}
function ModuleSkeleton({ title }: { title: string }) {
  return (
    <Card className="gap-0 py-0">
      <div className={widgetHeader}>
        <h2 className={widgetHeading}>{title}</h2>
      </div>
      <WidgetSkeleton label={`Loading ${title}…`} className="px-5 pt-3 pb-5" />
    </Card>
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
      {query.isPending && <WidgetSkeleton label="Loading tasks…" rows={4} className="p-4" />}
      {(query.isError || displaced.isError) && (
        <Notice
          className="m-4"
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void query.refetch()
                void displaced.refetch()
              }}
            >
              Retry
            </Button>
          }
        >
          Could not check current task state.
        </Notice>
      )}
      {query.data && !staged.rows.length && total === 0 && (
        <WidgetEmpty icon={InboxIcon} title="No tasks here right now" />
      )}
      {staged.updates > 0 && (
        <Button
          variant="secondary"
          size="sm"
          className="mx-5 my-2"
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
          variant="outline"
          size="sm"
          className="mx-5 my-3"
          disabled={query.isFetching}
          onClick={() => setCount((n) => n + 20)}
        >
          Show {Math.min(20, total - count)} more tasks
        </Button>
      )}
    </div>
  )
}
