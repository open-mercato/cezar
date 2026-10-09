import { disclosureContent, FilterSelect, filterLabel, Freshness, InfoHint, Notice, ReportNote, WidgetEmpty, WidgetSkeleton, widgetBody, widgetHeader, widgetHeading } from './presentation'
import { useDashboardFilter } from './url-filter'
import { Table2, ChevronDown, ChartColumn } from 'lucide-react'
import { formatAmount, formatHours } from './format'
import { ExportRows } from './export-rows'
import { type ReactNode } from 'react'
import type { DashboardCosts, DashboardCostSeriesPoint } from '@open-mercato/cezar-api-client'
import { useDashboardCosts } from '@/api/dashboard-costs'
import { useHealth } from '@/api/queries'
import { usageMetricVisibility, type UsageMetricVisibility } from '@/lib/token-metrics'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Coverage } from './rows'
import { accents } from './cost-visuals'
type Metric = 'cost' | 'input' | 'output'
type TrendPeriod = Extract<DashboardCosts['period'], '7d' | '30d'>
const fields = { cost: 'costUsd', input: 'inputTokens', output: 'outputTokens' } as const
const labels = { cost: 'Reported USD', input: 'Input tokens', output: 'Output tokens' } as const
function choices(visibility: UsageMetricVisibility): Metric[] {
  return [
    ...(visibility.cost ? (['cost'] as const) : []),
    ...(visibility.tokens ? (['input', 'output'] as const) : []),
  ]
}
const definitions =
  'Usage is grouped by creation date, not spending date. Completed tasks are grouped by finish date. Calendar days use your current UTC offset (fixed across the period), including today.'
const formatValue = (value: number | null | undefined, metric: Metric) =>
  formatAmount(value, metric === 'cost')

function formatDate(date: string) {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}
/** A thin vertical bar per day. A single series names itself from the card title, so no
 *  legend — per-bar values live in the hover tooltip, not stamped on every bar. */
function BarRow({
  series,
  height,
  accent,
  renderTooltip,
  describe,
}: {
  series: DashboardCostSeriesPoint[]
  height: (point: DashboardCostSeriesPoint) => number
  accent: string
  describe: (point: DashboardCostSeriesPoint) => string
  renderTooltip: (point: DashboardCostSeriesPoint) => ReactNode
}) {
  const max = Math.max(1, ...series.map(height))
  return (
    <TooltipProvider delayDuration={150}>
      <div className="relative h-24">
        {/* Muted gridlines at 50% and 100%, and a baseline. */}
        <div className="pointer-events-none absolute inset-0 flex flex-col justify-between" aria-hidden="true">
          <span className="border-t border-dashed border-border/70" />
          <span className="border-t border-dashed border-border/70" />
          <span className="border-t border-border" />
        </div>
      <div className="relative flex h-full items-end gap-1" role="group" aria-label="Daily trend">
        {series.map((point) => {
          const value = height(point)
          const pct = Math.max(value > 0 ? 4 : 0, (value / max) * 100)
          return (
            <Tooltip key={point.date}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  data-export-keep
                  aria-label={describe(point)}
                  type="button"
                  className="group/bar h-auto min-w-0 flex-1 gap-0 rounded-none rounded-t-[3px] p-0 hover:bg-muted/70 active:translate-y-0"
                  style={{ height: '100%', display: 'flex', alignItems: 'end' }}
                >
                  <span
                    style={{ height: `${pct}%` }}
                    className={`mx-auto block w-full max-w-7 rounded-t-[3px] ${accent}`}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent sideOffset={4} className="tabular-nums">
                {renderTooltip(point)}
              </TooltipContent>
            </Tooltip>
          )
        })}
      </div>
      </div>
      <div className="mt-1.5 flex justify-between text-xs text-soft-foreground">
        <span>{formatDate(series[0]!.date)}</span>
        <span>{formatDate(series.at(-1)!.date)}</span>
      </div>
    </TooltipProvider>
  )
}
const dataHead = 'h-auto px-0 py-1 font-medium text-muted-foreground'
/** Accessible daily values for the on-screen disclosure and the expanded PDF report. */
function DailyValuesTable({
  metrics,
  series,
}: {
  metrics: Metric[]
  series: DashboardCostSeriesPoint[]
}) {
  return (
    <Table className="text-left text-xs">
      <TableHeader>
        <TableRow className="text-muted-foreground hover:bg-transparent">
          <TableHead className={`${dataHead} pr-2`}>Date</TableHead>
          {metrics.map((metric) => (
            <TableHead key={metric} className={`${dataHead} pr-2 text-right`}>
              {labels[metric]}
            </TableHead>
          ))}
          <TableHead className={`${dataHead} pr-2 text-right`}>Completed</TableHead>
          <TableHead className={`${dataHead} text-right`}>Avg cycle</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {series.map((point) => (
          <TableRow key={point.date} className="border-border/70 hover:bg-transparent">
            <TableCell className="px-0 py-1 pr-2">{formatDate(point.date)}</TableCell>
            {metrics.map((metric) => (
              <TableCell key={metric} className="px-0 py-1 pr-2 text-right tabular-nums">
                {formatValue(point[fields[metric]]?.value, metric)}
              </TableCell>
            ))}
            <TableCell className="px-0 py-1 pr-2 text-right tabular-nums">
              {point.completed}
            </TableCell>
            <TableCell className="p-0 py-1 text-right tabular-nums">
              {point.avgCycleHours === null ? '—' : formatHours(point.avgCycleHours)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
function TrendMetricChart({
  metric,
  series,
}: {
  metric: Metric
  series: DashboardCostSeriesPoint[]
}) {
  const accent = accents[metric]
  const field = fields[metric]
  const reported = series.reduce((n, p) => n + (p[field]?.reportedTasks ?? 0), 0)
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-2 text-[13px] font-medium">
        <span className={`size-2 rounded-[2px] ${accent.fill}`} aria-hidden="true" />
        {labels[metric]}
      </p>
      <div className="mt-3">
        <BarRow
          series={series}
          describe={(p) =>
            `${p.date}, ${labels[metric]}: ${formatValue(p[field]?.value, metric)}, ${p[field]?.reportedTasks ?? 0} of ${p.tasks} tasks reported`
          }
          height={(p) => p[field]?.value ?? 0}
          accent={accent.fill}
          renderTooltip={(p) => (
            <p>
              {formatDate(p.date)} · {formatValue(p[field]?.value, metric)} ·{' '}
              {p[field]?.reportedTasks ?? 0}/{p.tasks} tasks reported
            </p>
          )}
        />
      </div>
      {reported === 0 && (
        <p className="mt-2 text-xs text-muted-foreground">No reports in this period.</p>
      )}
    </div>
  )
}
function ThroughputChart({ series }: { series: DashboardCostSeriesPoint[] }) {
  const totalCompleted = series.reduce((n, p) => n + p.completed, 0)
  const weightedHours = series.reduce(
    (sum, p) => sum + (p.avgCycleHours ?? 0) * (p.cycleReportedTasks ?? p.completed),
    0,
  )
  const timed = series.reduce((n, p) => n + (p.cycleReportedTasks ?? p.completed), 0)
  const avgCycleHours = timed ? weightedHours / timed : null
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="flex items-center gap-2 text-[13px] font-medium">
          <span className="size-2 rounded-[2px] bg-success" aria-hidden="true" />
          Completed tasks
        </p>
        <p className="text-xs text-muted-foreground tabular-nums">
          {totalCompleted} done · avg cycle{' '}
          {avgCycleHours === null ? 'unavailable' : formatHours(avgCycleHours)}
        </p>
      </div>
      <p className="text-xs text-soft-foreground">
        {timed}/{totalCompleted} completed tasks have valid cycle times.
      </p>
      <div className="mt-3">
        <BarRow
          series={series}
          describe={(p) =>
            `${p.date}: ${p.completed} completed tasks, average cycle ${p.avgCycleHours == null ? 'Unavailable' : formatHours(p.avgCycleHours)}`
          }
          height={(p) => p.completed}
          accent="bg-success/80"
          renderTooltip={(p) => (
            <div>
              <p>
                {formatDate(p.date)} · {p.completed} completed
              </p>
              <p>
                Avg cycle{' '}
                {p.avgCycleHours === null ? 'unavailable' : formatHours(p.avgCycleHours)} ·
                Median{' '}
                {p.medianCycleHours === null ? 'unavailable' : formatHours(p.medianCycleHours)}
              </p>
            </div>
          )}
        />
      </div>
      {totalCompleted === 0 && (
        <p className="mt-2 text-xs text-muted-foreground">No tasks finished in this period.</p>
      )}
    </div>
  )
}
export function DashboardTrends() {
  const visibility = usageMetricVisibility(useHealth().data)
  return <Trends visibility={visibility} />
}
export function Trends({ visibility }: { visibility: UsageMetricVisibility }) {
  const [period, setPeriod] = useDashboardFilter('trendPeriod', ['7d', '30d'] as const, '7d')
  const sort: DashboardCosts['sort'] = visibility.cost ? 'cost' : 'input'
  const query = useDashboardCosts(period, sort, `${visibility.cost}:${visibility.tokens}`)
  const data = query.data
  const empty =
    data &&
    data.totals.tasks === 0 &&
    data.coverage.projects.every((project) => project.state === 'complete') &&
    data.series.every((point) => point.tasks === 0 && point.completed === 0)
  const metrics = choices({
    cost: visibility.cost && data?.visibility.cost !== false,
    tokens: visibility.tokens && data?.visibility.tokens !== false,
  })
  return (
    <Card className="gap-0 py-0">
      <div className={widgetHeader}>
        <div className="flex items-center gap-1">
          <h2 className={widgetHeading}>Trends</h2>
          <InfoHint label="How these metrics work">{definitions}</InfoHint>
        </div>
        <Label className={filterLabel}>
          Period
          <FilterSelect<TrendPeriod>
            value={period}
            onValueChange={setPeriod}
            options={[
              { value: '7d', label: 'Last 7 days' },
              { value: '30d', label: 'Last 30 days' },
            ]}
          />
        </Label>
      </div>
      <div className={widgetBody}>
        {data && (
          <ExportRows
            rows={
              empty
                ? []
                : data.series.flatMap((point) => [
                    ...metrics.map((metric) => ({
                      section: 'daily-creation-cohort',
                      entity: point.date,
                      metric: fields[metric],
                      value: point[fields[metric]]?.value ?? null,
                      unit: metric === 'cost' ? 'USD' : 'tokens',
                      reportedTasks: point[fields[metric]]?.reportedTasks ?? 0,
                      totalTasks: point.tasks,
                      asOf: data.asOf,
                      note: 'Lifetime usage grouped by task creation date; not daily spend',
                    })),
                    {
                      section: 'daily-completions',
                      entity: point.date,
                      metric: 'completed',
                      value: point.completed,
                      unit: 'tasks',
                      asOf: data.asOf,
                    },
                    {
                      section: 'daily-completions',
                      entity: point.date,
                      metric: 'avgCycleHours',
                      value: point.avgCycleHours,
                      reportedTasks: point.cycleReportedTasks ?? point.completed,
                      totalTasks: point.completed,
                      unit: 'hours',
                      asOf: data.asOf,
                    },
                    {
                      section: 'daily-completions',
                      entity: point.date,
                      metric: 'medianCycleHours',
                      value: point.medianCycleHours,
                      unit: 'hours',
                      asOf: data.asOf,
                    },
                  ])
            }
          />
        )}

        <ReportNote>{definitions}</ReportNote>
        {query.isPending && <WidgetSkeleton label="Loading trends…" />}
        {query.isError && (
          <Notice
            action={
              <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                Retry
              </Button>
            }
          >
            {data ? 'Showing stale trends. Could not refresh.' : 'Could not load trends.'}
          </Notice>
        )}
        {data && <Coverage coverage={data.coverage} retry={() => void query.refetch()} />}
        {data && empty && (
          <WidgetEmpty icon={ChartColumn} title="No retained tasks in this period yet." />
        )}
        {data && !empty && data.series.length > 0 && (
          <>
            <div className="space-y-8 pt-1">
              {metrics.length > 0 && (
                <div className="grid gap-x-10 gap-y-8 sm:grid-cols-[repeat(auto-fit,minmax(200px,1fr))]">
                  {metrics.map((metric) => (
                    <TrendMetricChart key={metric} metric={metric} series={data.series} />
                  ))}
                </div>
              )}
              <ThroughputChart series={data.series} />
            </div>
            <Collapsible className="group print:block">
              <CollapsibleTrigger
                data-export-heading="Daily data"
                className="flex w-fit cursor-pointer items-center gap-1.5 rounded-sm text-[13px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 no-hover:min-h-11"
              >
                <Table2 className="size-3.5" aria-hidden="true" /> View data table
                <ChevronDown
                  className="size-3.5 transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none"
                  aria-hidden="true"
                />
              </CollapsibleTrigger>
              <CollapsibleContent forceMount className={`${disclosureContent} print:block!`}>
                <div
                  className="mt-3 max-h-80 overflow-auto print:max-h-none print:overflow-visible"
                  role="region"
                  aria-label="Daily trend values"
                  tabIndex={0}
                >
                  <DailyValuesTable metrics={metrics} series={data.series} />
                </div>
              </CollapsibleContent>
            </Collapsible>
          </>
        )}
        {data && (
          <p className="text-xs text-soft-foreground">
            <Freshness at={data.asOf} />
          </p>
        )}
      </div>
    </Card>
  )
}
