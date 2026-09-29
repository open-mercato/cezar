import { Freshness } from './presentation'
import { useDashboardFilter } from './url-filter'
import { Table2, ChevronDown } from 'lucide-react'
import { formatAmount, formatHours } from './format'
import { ExportRows } from './export-rows'
import { type ReactNode } from 'react'
import type { DashboardCosts, DashboardCostSeriesPoint } from '@open-mercato/cezar-api-client'
import { useDashboardCosts } from '@/api/dashboard-costs'
import { useHealth } from '@/api/queries'
import { usageMetricVisibility, type UsageMetricVisibility } from '@/lib/token-metrics'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
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
      <div className="flex h-20 items-end gap-0.5" role="group" aria-label="Daily trend">
        {series.map((point) => {
          const value = height(point)
          const pct = Math.max(value > 0 ? 4 : 0, (value / max) * 100)
          return (
            <Tooltip key={point.date}>
              <TooltipTrigger asChild>
                <button
                  data-export-keep
                  aria-label={describe(point)}
                  type="button"
                  className="min-w-0 flex-1 rounded-t-sm transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  style={{ height: '100%', display: 'flex', alignItems: 'end' }}
                >
                  <span
                    style={{ height: `${pct}%` }}
                    className={`block w-full rounded-t-sm ${accent}`}
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent>{renderTooltip(point)}</TooltipContent>
            </Tooltip>
          )
        })}
      </div>
      <div className="mt-1 flex justify-between text-xs text-muted-foreground">
        <span>{formatDate(series[0]!.date)}</span>
        <span>{formatDate(series.at(-1)!.date)}</span>
      </div>
    </TooltipProvider>
  )
}
/** Accessible daily values for the on-screen disclosure and the expanded PDF report. */
function DailyValuesTable({
  metrics,
  series,
}: {
  metrics: Metric[]
  series: DashboardCostSeriesPoint[]
}) {
  return (
    <table className="w-full text-left text-xs">
      <thead>
        <tr className="border-b">
          <th className="py-1 pr-2 font-medium">Date</th>
          {metrics.map((metric) => (
            <th key={metric} className="py-1 pr-2 text-right font-medium">
              {labels[metric]}
            </th>
          ))}
          <th className="py-1 pr-2 text-right font-medium">Completed</th>
          <th className="py-1 text-right font-medium">Avg cycle</th>
        </tr>
      </thead>
      <tbody>
        {series.map((point) => (
          <tr key={point.date} className="border-b last:border-0">
            <td className="py-1 pr-2">{formatDate(point.date)}</td>
            {metrics.map((metric) => (
              <td key={metric} className="py-1 pr-2 text-right tabular-nums">
                {formatValue(point[fields[metric]]?.value, metric)}
              </td>
            ))}
            <td className="py-1 pr-2 text-right tabular-nums">{point.completed}</td>
            <td className="py-1 text-right tabular-nums">
              {point.avgCycleHours === null ? '—' : formatHours(point.avgCycleHours)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
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
    <div className="rounded-xl border p-3">
      <p className={`text-xs font-medium ${accent.text}`}>{labels[metric]}</p>
      <div className="mt-2">
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
    <div className="rounded-xl border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs font-medium text-success">Completed tasks</p>
        <p className="text-xs text-muted-foreground">
          {totalCompleted} done · avg cycle{' '}
          {avgCycleHours === null ? 'unavailable' : formatHours(avgCycleHours)}
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        {timed}/{totalCompleted} completed tasks have valid cycle times.
      </p>
      <div className="mt-2">
        <BarRow
          series={series}
          describe={(p) =>
            `${p.date}: ${p.completed} completed tasks, average cycle ${p.avgCycleHours == null ? 'Unavailable' : formatHours(p.avgCycleHours)}`
          }
          height={(p) => p.completed}
          accent="bg-success"
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
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Trends</h2>
        <label className="flex min-h-11 items-center gap-2 text-xs">
          Period
          <select
            className="min-h-11 rounded-md border bg-background px-2 text-xs"
            value={period}
            onChange={(e) => setPeriod(e.target.value as TrendPeriod)}
          >
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
          </select>
        </label>
      </div>
      <div className="space-y-4 p-4 text-sm">
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

        <details className="text-xs text-muted-foreground">
          <summary data-export-heading="Metric definitions" className="cursor-pointer py-2">
            How these metrics work
          </summary>
          <p>
            Usage is grouped by creation date, not spending date. Completed tasks are grouped by
            finish date. Calendar days use your current UTC offset (fixed across the period),
            including today.
          </p>
        </details>
        {query.isPending && <p>Loading trends…</p>}
        {query.isError && (
          <p role="alert">
            {data ? 'Showing stale trends. Could not refresh.' : 'Could not load trends.'}{' '}
            <Button className="min-h-11" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </p>
        )}
        {data && (
          <p className="text-xs text-muted-foreground">
            <Freshness at={data.asOf} />
          </p>
        )}
        {data && <Coverage coverage={data.coverage} retry={() => void query.refetch()} />}
        {data && empty && (
          <p className="text-muted-foreground">No retained tasks in this period yet.</p>
        )}
        {data && !empty && data.series.length > 0 && (
          <>
            <div className="space-y-4">
              {metrics.length > 0 && (
                <div className="grid gap-3 sm:grid-cols-[repeat(auto-fit,minmax(200px,1fr))]">
                  {metrics.map((metric) => (
                    <TrendMetricChart key={metric} metric={metric} series={data.series} />
                  ))}
                </div>
              )}
              <ThroughputChart series={data.series} />
            </div>
            <details className="group rounded-lg border bg-muted/20 print:block">
              <summary
                data-export-heading="Daily data"
                className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-xs font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden"
              >
                <Table2 className="size-4" aria-hidden="true" /> View data table
                <ChevronDown
                  className="ml-auto size-4 transition-transform group-open:rotate-180"
                  aria-hidden="true"
                />
              </summary>
              <div
                className="max-h-80 overflow-auto border-t p-3 print:max-h-none print:overflow-visible"
                role="region"
                aria-label="Daily trend values"
                tabIndex={0}
              >
                <DailyValuesTable metrics={metrics} series={data.series} />
              </div>
            </details>
          </>
        )}
      </div>
    </Card>
  )
}
