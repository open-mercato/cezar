import { useSheetState, useSheetPosition, newSheetSelection, useSheetTrigger } from './sheet-state'
import { Freshness } from './presentation'
import { useDashboardFilter } from './url-filter'
import { formatAmount } from './format'
import { useState } from 'react'
import { Link } from 'react-router'
import type { DashboardCosts, DashboardCostTask } from '@open-mercato/cezar-api-client'
import { useDashboardCosts, useCostTasks } from '@/api/dashboard-costs'
import { useDashboardTruth } from '@/api/dashboard-truth'
import { useHealth } from '@/api/queries'
import { usageMetricVisibility, type UsageMetricVisibility } from '@/lib/token-metrics'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { deriveAttention } from '@/lib/attention'
import { StatusDot } from '@/components/status-dot'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { Coverage } from './rows'
import { ExportRows } from './export-rows'
import { CostMetricCard, CostProjectBars } from './cost-visuals'
const fields = {
  cost: 'costUsd',
  input: 'inputTokens',
  output: 'outputTokens',
} as const
const labels = {
  cost: 'Reported USD',
  input: 'Input tokens',
  output: 'Output tokens',
} as const
type Sort = DashboardCosts['sort']
function contentChanged(a: DashboardCosts, b: DashboardCosts) {
  return (
    JSON.stringify([a.totals, a.projects, a.tasks, a.visibility, a.coverage, a.invalidDateTasks]) !==
    JSON.stringify([b.totals, b.projects, b.tasks, b.visibility, b.coverage, b.invalidDateTasks])
  )
}
const format = (value: number | null | undefined, sort: Sort) =>
  formatAmount(value, sort === 'cost')

function choices(visibility: UsageMetricVisibility): Sort[] {
  return [
    ...(visibility.cost ? ['cost' as const] : []),
    ...(visibility.tokens ? ['input' as const, 'output' as const] : []),
  ]
}
function SortSelect({
  value,
  onChange,
  visibility,
}: {
  value: Sort
  onChange: (value: Sort) => void
  visibility: UsageMetricVisibility
}) {
  return (
    <label className="flex min-h-11 items-center gap-2 text-sm">
      Sort by
      <select
        className="min-h-11 rounded-md border bg-background px-3 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value as Sort)}
      >
        {choices(visibility).map((sort) => (
          <option key={sort} value={sort}>
            {labels[sort]}
          </option>
        ))}
      </select>
    </label>
  )
}
export function DashboardUsageCosts() {
  const visibility = usageMetricVisibility(useHealth().data)
  return <UsageCosts visibility={visibility} />
}
export function UsageCosts({ visibility }: { visibility: UsageMetricVisibility }) {
  return (
    <Card className="gap-0 py-0">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Usage &amp; cost</h2>
      </div>
      {!visibility.cost && !visibility.tokens ? (
        <p className="p-4 text-sm">Usage metrics are hidden by workspace settings</p>
      ) : (
        <CostContent key={`${visibility.cost}:${visibility.tokens}`} visibility={visibility} />
      )}
    </Card>
  )
}
function CostContent({ visibility }: { visibility: UsageMetricVisibility }) {
  const [period, setPeriod] = useDashboardFilter(
    'usagePeriod',
    ['all', '7d', '30d'] as const,
    'all',
  )
  const [sort, setSort] = useDashboardFilter(
    'usageSort',
    choices(visibility),
    visibility.cost ? 'cost' : 'input',
  )
  return (
    <CostPeriod
      period={period}
      setPeriod={setPeriod}
      sort={sort}
      setSort={setSort}
      visibility={visibility}
    />
  )
}
function CostPeriod({
  period,
  setPeriod,
  sort,
  setSort,
  visibility,
}: {
  period: DashboardCosts['period']
  setPeriod: (p: DashboardCosts['period']) => void
  sort: Sort
  setSort: (s: Sort) => void
  visibility: UsageMetricVisibility
}) {
  const query = useDashboardCosts(period, sort, `${visibility.cost}:${visibility.tokens}`)
  const [accepted, setAccepted] = useSheetState<DashboardCosts | undefined>('usage:accepted', undefined)
  const data = accepted ?? query.data
  const latest = query.data ?? data
  const [panel, setPanel] = useSheetState<{ identity: number; projectId: string; snapshot: DashboardCosts; latestId: string } | null>('usage:panel', null)
  const [observedPeriod, setObservedPeriod] = useState(period)
  // Reset the cohort without remounting the controls and losing keyboard focus.
  if (observedPeriod !== period) {
    setObservedPeriod(period)
    setAccepted(undefined)
    setPanel(null)
  }
  const sheetPosition = useSheetPosition(`usage:${panel?.identity ?? 'closed'}`)
  const trigger = useSheetTrigger('usage', '[data-usage-trigger]')
  const openPanel = (projectId: string) => {
    trigger.capture()
    if (data) setPanel({ identity: newSheetSelection(), projectId, snapshot: data, latestId: latest?.snapshotId ?? data.snapshotId })
  }
  // A pending/failed ranking request must not restore an older permissive policy.
  const [lastPolicy, setLastPolicy] = useSheetState('usage:lastPolicy', visibility)
  const currentPolicy = query.data?.visibility ?? lastPolicy
  if (currentPolicy.cost !== lastPolicy.cost || currentPolicy.tokens !== lastPolicy.tokens)
    setLastPolicy(currentPolicy)
  const policy = {
    cost: visibility.cost && currentPolicy.cost,
    tokens: visibility.tokens && currentPolicy.tokens,
  }
  const effectiveSort = choices(policy).includes(sort) ? sort : (choices(policy)[0] ?? 'cost')
  const projects = [...(data?.projects ?? [])].sort((a, b) => {
    const av = a[fields[effectiveSort]]?.value
    const bv = b[fields[effectiveSort]]?.value
    return (
      (av == null ? (bv == null ? 0 : 1) : bv == null ? -1 : bv - av) ||
      a.projectId.localeCompare(b.projectId)
    )
  })
  // Latch the first completed response; subsequent refreshes become an explicit candidate.
  if (!accepted && query.data) setAccepted(query.data)
  const changed = data && latest && contentChanged(data, latest)
  const partial = data?.coverage.projects.some((p) => p.state !== 'complete')
  const currentPartial = latest?.coverage.projects.some((p) => p.state !== 'complete')
  const coverageChanged = JSON.stringify(data?.coverage) !== JSON.stringify(latest?.coverage)
  const empty = data?.totals.tasks === 0 && !partial && !currentPartial
  return (
    <div className="space-y-4 p-4 text-sm">
      {data && (
        <ExportRows
          rows={
            empty
              ? []
              : [
                  ...choices(policy).map((metric) => ({
                    section: 'totals',
                    metric: fields[metric],
                    value: data.totals[fields[metric]]?.value ?? null,
                    unit: metric === 'cost' ? 'USD' : 'tokens',
                    reportedTasks: data.totals[fields[metric]]?.reportedTasks ?? 0,
                    totalTasks: data.totals.tasks,
                    asOf: data.asOf,
                  })),
                  ...(policy.cost || policy.tokens ? projects.slice(0, 5) : []).map((project) => ({
                    section: 'project',
                    entity: project.projectId,
                    metric: fields[effectiveSort],
                    value: project[fields[effectiveSort]]?.value ?? null,
                    unit: effectiveSort === 'cost' ? 'USD' : 'tokens',
                    reportedTasks: project[fields[effectiveSort]]?.reportedTasks ?? 0,
                    totalTasks: project.tasks,
                    asOf: data.asOf,
                  })),
                ]
          }
        />
      )}

      {data && (
        <p className="text-xs text-muted-foreground">
          <Freshness at={data.asOf} />
        </p>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-medium">Lifetime totals of retained tasks</h3>
          <details className="mt-1 text-xs text-muted-foreground">
            <summary
              data-export-heading="Metric definitions"
              className="min-h-11 cursor-pointer py-3"
            >
              How these metrics work
            </summary>
            <p>
              Includes archived tasks and subtasks.{' '}
              {policy.cost && 'Reported USD is not an invoice. '}Missing reports are excluded,
              not treated as zero. Calendar days use your current UTC offset, including today.
            </p>
          </details>
        </div>
        <label className="flex min-h-11 items-center gap-2">
          Tasks created
          <select
            className="min-h-11 rounded-md border bg-background px-3 text-sm"
            value={period}
            onChange={(e) => setPeriod(e.target.value as DashboardCosts['period'])}
          >
            <option value="all">All time</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
          </select>
        </label>
      </div>
      {period !== 'all' && (
        <p className="text-muted-foreground">
          Lifetime usage of tasks created in this period — not spending during the period.
        </p>
      )}
      {query.isPending && <p>Loading usage…</p>}
      {query.isError && (
        <p role="alert">
          {data ? 'Showing stale usage. Could not refresh.' : 'Could not load usage.'}{' '}
          <Button className="min-h-11" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </p>
      )}
      {changed && (
        <p role="status">
          Newer usage data is available; displayed values use the previous snapshot.
        </p>
      )}
      {changed && (
        <Button className="min-h-11" variant="outline" onClick={() => setAccepted(latest)}>
          Updates available — Show
        </Button>
      )}
      {data && partial && (
        <div>
          <p className="text-muted-foreground">Coverage of displayed usage:</p>
          <Coverage coverage={data.coverage} retry={() => void query.refetch()} />
        </div>
      )}
      {latest && currentPartial && coverageChanged && (
        <div>
          <p className="text-muted-foreground">Current source availability:</p>
          <Coverage coverage={latest.coverage} retry={() => void query.refetch()} />
        </div>
      )}
      {data && (
        <>
          {!empty && (
            <div className="report-cost-metrics grid gap-3 sm:grid-cols-[repeat(auto-fit,minmax(220px,1fr))]">
              {choices(policy).map((metric) => (
                <CostMetricCard
                  key={metric}
                  metric={metric}
                  label={labels[metric]}
                  value={format(data.totals[fields[metric]]?.value, metric)}
                  reported={data.totals[fields[metric]]?.reportedTasks ?? 0}
                  total={data.totals.tasks}
                />
              ))}
            </div>
          )}
          {!policy.cost && !policy.tokens && (
            <p>Usage metrics are hidden by workspace settings</p>
          )}
          {data.totals.tasks === 0 ? (
            <p>
              {partial || currentPartial
                ? 'No retained tasks could be read from available sources.'
                : 'No retained tasks in this cohort.'}
            </p>
          ) : (
            choices(policy).every((metric) => !data.totals[fields[metric]]?.reportedTasks) && (
              <p>No reports for the visible metrics in this cohort.</p>
            )
          )}
          {empty && (
            <p className="text-muted-foreground">Usage appears when tasks report cost or tokens.</p>
          )}
          <p className="text-muted-foreground">
            Deleted tasks are excluded from retained history.
            {data.invalidDateTasks
              ? ` ${data.invalidDateTasks} tasks have missing or invalid creation dates${period === 'all' ? '; included in All time' : '; excluded from this period'}.`
              : ''}
          </p>
          {!empty && (policy.cost || policy.tokens) && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="font-medium">Top projects</h3>
                  <p className="text-muted-foreground">Ranking uses reported metrics only.</p>
                </div>
                <SortSelect value={effectiveSort} onChange={setSort} visibility={policy} />
              </div>
              <CostProjectBars
                projects={projects}
                metric={effectiveSort}
                label={labels[effectiveSort]}
                field={fields[effectiveSort]}
                format={(value) => format(value, effectiveSort)}
                currentProjects={latest?.projects ?? []}
                onSelect={openPanel}
              />
              <Button data-usage-trigger className="min-h-11" variant="outline" onClick={() => openPanel('')}>
                View tasks
              </Button>
            </>
          )}
        </>
      )}
      <Sheet
        open={panel !== null && (policy.cost || policy.tokens)}
        onOpenChange={(open) => {
          if (!open) setPanel(null)
        }}
      >
        <SheetContent
          {...sheetPosition}
          className="w-full overflow-y-auto sm:max-w-xl [&>button]:min-h-11 [&>button]:min-w-11"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            trigger.restore()
          }}
        >
          <SheetHeader>
            <SheetTitle>{panel?.projectId ? `${panel.projectId} tasks` : 'All tasks'}</SheetTitle>
            <SheetDescription>
              Lifetime usage of retained tasks. Missing reports are unavailable.
            </SheetDescription>
          </SheetHeader>
          {panel !== null && (
            <CostTasks
              key={panel.identity}
              identity={`usage:${panel.identity}`}
              // Open the displayed cohort. Only refreshes arriving after opening
              // become candidates for the Sheet's own explicit update control.
              snapshot={latest && latest.snapshotId !== panel.latestId ? latest : panel.snapshot}
              projectId={panel.projectId || undefined}
              visibility={policy}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
function CostTasks({
  identity,
  snapshot,
  projectId,
  visibility,
}: {
  identity: string
  snapshot: DashboardCosts
  projectId?: string
  visibility: UsageMetricVisibility
}) {
  const [sort, setSort] = useSheetState<Sort>(`${identity}:sort`, snapshot.sort)
  const effective = choices(visibility).includes(sort)
    ? sort
    : (choices(visibility)[0] ?? 'cost')
  return (
    <CostTaskPage
      identity={identity}
      snapshot={snapshot}
      projectId={projectId}
      visibility={visibility}
      sort={effective}
      setSort={setSort}
    />
  )
}
function CostTaskPage({
  identity,
  snapshot,
  projectId,
  visibility,
  sort,
  setSort,
}: {
  identity: string
  snapshot: DashboardCosts
  projectId?: string
  visibility: UsageMetricVisibility
  sort: Sort
  setSort: (s: Sort) => void
}) {
  const [count, setCount] = useSheetState(`${identity}:count`, 20)
  const [pagingSnapshot, setPagingSnapshot] = useSheetState<DashboardCosts | undefined>(`${identity}:paging`, undefined)
  const [observedSnapshot, setObservedSnapshot] = useState(snapshot.snapshotId)
  if (observedSnapshot !== snapshot.snapshotId) {
    setObservedSnapshot(snapshot.snapshotId)
    setPagingSnapshot(undefined)
  }
  const query = useCostTasks(pagingSnapshot ?? snapshot, projectId, sort, count)
  const [lastPolicy, setLastPolicy] = useSheetState(`${identity}:lastPolicy`, visibility)
  const currentPolicy = query.data?.visibility ?? lastPolicy
  if (currentPolicy.cost !== lastPolicy.cost || currentPolicy.tokens !== lastPolicy.tokens)
    setLastPolicy(currentPolicy)
  const policy = {
    cost: visibility.cost && currentPolicy.cost,
    tokens: visibility.tokens && currentPolicy.tokens,
  }
  const effectiveSort = choices(policy).includes(sort) ? sort : (choices(policy)[0] ?? 'cost')
  const [accepted, setAccepted] = useSheetState<typeof query.data>(`${identity}:accepted`, undefined)
  const [acceptedCount, setAcceptedCount] = useSheetState(`${identity}:acceptedCount`, count)
  const [acceptedSort, setAcceptedSort] = useSheetState(`${identity}:acceptedSort`, sort)
  const [observedSort, setObservedSort] = useState(sort)
  if (observedSort !== sort) {
    setObservedSort(sort)
    setCount(20)
    // Sorting changes presentation, never acceptance of a fresher cohort.
    setPagingSnapshot(accepted ?? pagingSnapshot ?? snapshot)
  }
  if (
    query.data &&
    (!accepted || ((acceptedCount !== count || acceptedSort !== sort) && accepted.snapshotId === query.data.snapshotId))
  ) {
    setAccepted(query.data)
    setAcceptedCount(count)
    setAcceptedSort(sort)
  }
  const data = accepted ?? query.data
  const changed = query.data && data && contentChanged(query.data, data)
  const partial = data?.coverage.projects.some((p) => p.state !== 'complete')
  const currentPartial = query.data?.coverage.projects.some((p) => p.state !== 'complete')
  const coverageChanged = JSON.stringify(data?.coverage) !== JSON.stringify(query.data?.coverage)
  const validProject = !projectId || snapshot.projects.some((p) => p.projectId === projectId)
  return (
    <div className="space-y-3 p-4 text-sm" data-sheet-loading={query.isFetching}>
      <SortSelect value={effectiveSort} onChange={setSort} visibility={policy} />
      {query.isPending && <p>Loading tasks…</p>}
      {query.isError && (
        <p role="alert">
          Could not refresh tasks. {data ? 'Showing stale usage.' : ''}{' '}
          <Button className="min-h-11" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </p>
      )}
      {changed && (
        <Button
          className="min-h-11"
          onClick={() => {
            setAccepted(query.data)
            setAcceptedCount(count)
            setAcceptedSort(sort)
          }}
        >
          Updates available — Show
        </Button>
      )}
      {data && partial && (
        <div>
          <p className="text-muted-foreground">Coverage of displayed tasks:</p>
          <Coverage coverage={data.coverage} retry={() => void query.refetch()} />
        </div>
      )}
      {query.data && currentPartial && coverageChanged && (
        <div>
          <p className="text-muted-foreground">Current source availability:</p>
          <Coverage coverage={query.data.coverage} retry={() => void query.refetch()} />
        </div>
      )}
      {data && (
        <>
          <p>
            {data.tasks.rows.length} of {data.tasks.total} retained tasks
          </p>
          {data.tasks.total === 0 && (
            <p>
              {data.coverage.projects.some((p) => p.state !== 'complete')
                ? 'No tasks could be read from available sources.'
                : 'No retained tasks in this cohort.'}
            </p>
          )}
          {data.tasks.rows.map((row) => (
            <CostTaskRow
              key={`${row.projectId}:${row.id}`}
              row={row}
              visibility={policy}
              disabled={
                !validProject ||
                !query.data ||
                !!(
                  changed &&
                  !query.data?.tasks.rows.some(
                    (item) => item.id === row.id && item.projectId === row.projectId,
                  )
                )
              }
            />
          ))}
          {data.tasks.nextOffset !== null && (
            <Button
              className="min-h-11"
              disabled={query.isFetching}
              onClick={() => {
                setPagingSnapshot(data)
                setCount((n) => n + 20)
              }}
            >
              Show 20 more tasks
            </Button>
          )}
        </>
      )}
    </div>
  )
}
function CostTaskRow({
  row,
  visibility,
  disabled,
}: {
  row: DashboardCostTask
  visibility: UsageMetricVisibility
  disabled: boolean
}) {
  const truth = useDashboardTruth(row)
  disabled = disabled || truth === null
  const attention = deriveAttention({ status: truth?.status ?? row.status })
  return (
    <div className="border-b py-3">
      <div className="flex items-center gap-2">
        <StatusDot tone={attention.tone} pulse={attention.pulse} />
        <Link
          className="flex min-h-11 items-center break-words font-medium hover:underline"
          to={`/p/${encodeURIComponent(row.projectId)}/tasks/${encodeURIComponent(row.id)}`}
          aria-disabled={disabled || undefined}
          tabIndex={disabled ? -1 : undefined}
          onClick={(e) => {
            if (disabled) e.preventDefault()
          }}
        >
          {row.title}
        </Link>
      </div>
      <p className="text-muted-foreground">
        {row.projectId} · {disabled ? 'Checking current state…' : (truth?.status ?? row.status)}
        {row.archived ? ' · Archived' : ''}
        {row.subtask ? ' · Subtask' : ''}
      </p>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
        {choices(visibility).map((metric) => (
          <span key={metric}>
            {labels[metric]}: {format(row[fields[metric]], metric)}
          </span>
        ))}
      </div>
    </div>
  )
}
