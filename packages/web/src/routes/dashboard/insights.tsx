import type { ReactNode } from 'react'
import { Link } from 'react-router'
import type {
  DashboardAutomationStat,
  DashboardBackendStat,
  DashboardFailureReason,
  DashboardInsights,
} from '@open-mercato/cezar-api-client'
import { useDashboardInsights } from '@/api/dashboard-insights'
import { useProjects } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { StatusDot } from '@/components/status-dot'
import { shortAge } from '@/lib/format'
import { useAutomationsGate } from '@/routes/automations/use-automations'
import { useDashboardAutomations } from './automations-data'
import { ExportRows } from './export-rows'
import { formatAmount, formatHours } from './format'
import { FilterSelect, filterLabel, Freshness, widgetHeader, widgetHeading } from './presentation'
import { useDashboardFilter } from './url-filter'

type Period = DashboardInsights['period']
const periodText = (period: Period) => `Last ${period === '7d' ? 7 : 30} calendar days`
const bandLabel = 'font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground'
const panel = 'min-w-0 rounded-lg border bg-card-2 p-4'
const th =
  'whitespace-nowrap px-3 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-soft-foreground'

function useProjectName() {
  const projects = useProjects().data?.projects
  return (id: string) => projects?.find((p) => p.id === id)?.name ?? id
}
const taskPath = (projectId: string, id: string) =>
  `/p/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(id)}`

function PeriodSelect({
  label,
  value,
  onChange,
}: {
  label: string
  value: Period
  onChange: (value: Period) => void
}) {
  return (
    <label className={filterLabel}>
      {label}
      <FilterSelect value={value} onChange={(e) => onChange(e.target.value === '30d' ? '30d' : '7d')}>
        <option value="7d">Last 7 days</option>
        <option value="30d">Last 30 days</option>
      </FilterSelect>
    </label>
  )
}

function InsightState({ query }: { query: ReturnType<typeof useDashboardInsights> }) {
  if (query.isPending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading insights…
      </p>
    )
  if (!query.isError) return null
  return (
    <p role="alert" className="text-sm">
      {query.data ? 'Showing previous results. ' : ''}Could not refresh insights.{' '}
      <Button variant="outline" onClick={() => void query.refetch()}>
        Retry insights
      </Button>
    </p>
  )
}

/** Delivered work and failure reasons: the two answers under the overview's outcome tiles. */
export function OutcomeInsights({ period, active }: { period: Period; active: boolean }) {
  const query = useDashboardInsights(period, active)
  const data = query.data
  return (
    <div className="space-y-3">
      <InsightState query={query} />
      {data && (
        <div className="grid gap-3 lg:grid-cols-2">
          <Delivered data={data} />
          <FailureReasons data={data} />
        </div>
      )}
    </div>
  )
}

function Delivered({ data }: { data: DashboardInsights }) {
  const d = data.delivered
  const stats: { label: string; value: ReactNode; note?: string }[] = [
    { label: 'PRs opened', value: d.prsOpened, note: `${d.prsTouched} touched` },
    {
      label: 'Lines',
      value: (
        <>
          <span className="text-success">+{d.additions.toLocaleString('en-US')}</span>{' '}
          <span className="text-danger">−{d.deletions.toLocaleString('en-US')}</span>
        </>
      ),
    },
    { label: 'Files', value: d.files.toLocaleString('en-US') },
    { label: 'Issues', value: d.issues },
  ]
  return (
    <section className={panel} aria-label="Delivered">
      <ExportRows
        rows={Object.entries(d).map(([metric, value]) => ({
          section: 'delivered',
          metric,
          value,
          unit: ['additions', 'deletions'].includes(metric)
            ? 'lines'
            : metric === 'files'
              ? 'files'
              : 'count',
          asOf: data.asOf,
          note: `Completed since ${data.windowStart}`,
        }))}
      />
      <h3 className={bandLabel}>Delivered</h3>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="min-w-0">
            <dt className="text-xs text-soft-foreground">{s.label}</dt>
            <dd className="mt-1 truncate text-xl font-semibold tracking-tight tabular-nums">
              {s.value}
            </dd>
            {s.note && <dd className="text-xs text-soft-foreground">{s.note}</dd>}
          </div>
        ))}
      </dl>
      <span className="mt-3 block text-xs text-soft-foreground">
        From {d.completedTasks} completed {d.completedTasks === 1 ? 'task' : 'tasks'} ·{' '}
        {d.measuredTasks} with a stored diff
      </span>
    </section>
  )
}

function FailureReasons({ data }: { data: DashboardInsights }) {
  const projectName = useProjectName()
  const { total, reasons } = data.failures
  return (
    <section className={panel} aria-label="Why tasks failed">
      <ExportRows
        rows={reasons.map((r) => ({
          section: 'failures',
          entity: r.label,
          metric: r.category,
          value: r.count,
          unit: 'tasks',
          asOf: data.asOf,
          note: r.latest.message,
        }))}
      />
      <div className="flex items-baseline justify-between gap-2">
        <h3 className={bandLabel}>Why tasks failed</h3>
        {total > 0 && (
          <span className="font-mono text-[11px] text-soft-foreground">{total} failed</span>
        )}
      </div>
      {total === 0 ? (
        <span className="mt-4 flex items-center gap-2.5 text-sm text-muted-foreground">
          <StatusDot tone="success" />
          No failed outcomes in this period
        </span>
      ) : (
        <ul className="mt-3 space-y-3">
          {reasons.map((reason) => (
            <FailureReason
              key={`${reason.category}:${reason.label}`}
              reason={reason}
              total={total}
              projectName={projectName}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

function FailureReason({
  reason,
  total,
  projectName,
}: {
  reason: DashboardFailureReason
  total: number
  projectName: (id: string) => string
}) {
  const { latest } = reason
  return (
    <li className="min-w-0">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 truncate font-medium" title={reason.label}>
          {reason.label}
        </span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">{reason.count}</span>
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div className="h-full rounded-full bg-danger/70" style={{ width: `${(reason.count / total) * 100}%` }} />
      </div>
      <span className="mt-1.5 block truncate text-xs text-soft-foreground" title={latest.message}>
        Latest:{' '}
        <Link className="text-muted-foreground hover:text-foreground hover:underline" to={taskPath(latest.projectId, latest.id)}>
          {latest.title}
        </Link>{' '}
        · {projectName(latest.projectId)}
        {latest.step ? ` · ${latest.step}` : ''} · {shortAge(latest.at)} ago
      </span>
    </li>
  )
}

const backendNames: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  pi: 'Pi',
  unknown: 'Unknown backend',
}
const backendName = (id: string) => backendNames[id] ?? id
const percent = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0)

/** Which backend and model finish work, how fast, and at what reported cost. */
export function BackendComparison() {
  const [period, setPeriod] = useDashboardFilter('backends', ['7d', '30d'] as const, '7d')
  const query = useDashboardInsights(period)
  const data = query.data
  const cost = data?.visibility.cost
  return (
    <Card className="gap-0 py-0" data-export-context={`Backends: ${periodText(period)}; finished tasks`}>
      <div className={widgetHeader}>
        <h2 className={widgetHeading}>Backends & models</h2>
        <PeriodSelect label="Finished" value={period} onChange={setPeriod} />
      </div>
      <div className="space-y-3 p-4">
        <InsightState query={query} />
        {data && (
          <>
            <p className="text-xs text-muted-foreground">
              Tasks that finished done or failed in the period, by the backend and model that ran
              them. Includes subtasks. Cost is reported USD only.
            </p>
            {data.backends.length ? (
              <div className="overflow-x-auto" role="region" aria-label="Backend comparison" tabIndex={0}>
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr>
                      <th className={th}>Backend</th>
                      <th className={`${th} text-right`}>Finished</th>
                      <th className={th}>Success</th>
                      <th className={`${th} text-right`}>Median cycle</th>
                      {cost && <th className={`${th} text-right`}>Reported USD</th>}
                      {cost && <th className={`${th} text-right`}>Per completed</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {data.backends.map((b) => (
                      <BackendRow key={`${b.backend}:${b.model ?? ''}`} stat={b} cost={!!cost} />
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="py-4 text-sm text-muted-foreground">No finished tasks in this period.</p>
            )}
            <span className="block font-mono text-[11px] text-soft-foreground">
              <Freshness at={data.asOf} />
            </span>
            <ExportRows
              rows={data.backends.flatMap((b) =>
                (['finished', 'done', 'failed', 'medianCycleHours'] as const).map((metric) => ({
                  section: 'backends',
                  entity: `${b.backend}${b.model ? `:${b.model}` : ''}`,
                  metric,
                  value: b[metric],
                  unit: metric === 'medianCycleHours' ? 'hours' : 'tasks',
                  asOf: data.asOf,
                })),
              )}
            />
          </>
        )}
      </div>
    </Card>
  )
}

function BackendRow({ stat: b, cost }: { stat: DashboardBackendStat; cost: boolean }) {
  const rate = percent(b.done, b.finished)
  const usd = b.costUsd?.value
  return (
    <tr className="border-t transition-colors hover:bg-muted/30">
      <td className="px-3 py-2.5">
        <span className="block font-medium">{backendName(b.backend)}</span>
        <span className="block font-mono text-[11px] text-soft-foreground">
          {b.model ?? 'default model'}
        </span>
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums">{b.finished}</td>
      <td className="min-w-40 px-3 py-2.5">
        <span className="flex items-center gap-2">
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-danger/40" aria-hidden="true">
            <span className="block h-full rounded-full bg-success" style={{ width: `${rate}%` }} />
          </span>
          <span className="w-10 text-right font-mono text-xs tabular-nums">{rate}%</span>
        </span>
        <span className="block text-xs text-soft-foreground">
          {b.done} done · {b.failed} failed
        </span>
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums">
        {b.timedTasks ? formatHours(b.medianCycleHours) : '—'}
      </td>
      {cost && (
        <td className="px-3 py-2.5 text-right tabular-nums">
          {usd == null ? '—' : formatAmount(usd, true)}
          <span className="block text-xs text-soft-foreground">
            {b.costUsd?.reportedTasks ?? 0}/{b.finished} reported
          </span>
        </td>
      )}
      {cost && (
        <td className="px-3 py-2.5 text-right tabular-nums">
          {usd == null || !b.done ? '—' : formatAmount(usd / b.done, true)}
        </td>
      )}
    </tr>
  )
}

type AutomationRow = {
  projectId: string
  automationId: string
  name: string
  enabled?: boolean
  removed: boolean
  stat?: DashboardAutomationStat
}

/** What each automation launched in the period, including the ones that launched nothing. */
export function AutomationOutcomes() {
  const [period, setPeriod] = useDashboardFilter('automations', ['7d', '30d'] as const, '7d')
  const gate = useAutomationsGate()
  const query = useDashboardInsights(period)
  const definitions = useDashboardAutomations(gate.known && !gate.off)
  const projectName = useProjectName()
  const data = query.data
  const cost = data?.visibility.cost
  const rows = new Map<string, AutomationRow>()
  for (const project of definitions.data ?? [])
    for (const a of project.data?.automations ?? [])
      rows.set(`${project.id}\u0000${a.id}`, {
        projectId: project.id,
        automationId: a.id,
        name: a.name,
        enabled: a.enabled,
        removed: false,
      })
  for (const stat of data?.automations ?? []) {
    const key = `${stat.projectId}\u0000${stat.automationId}`
    const known = rows.get(key)
    rows.set(key, known ? { ...known, stat } : { ...stat, name: stat.automationId, removed: true, stat })
  }
  const sorted = [...rows.values()].sort(
    (a, b) =>
      (b.stat?.tasks ?? 0) - (a.stat?.tasks ?? 0) ||
      Number(b.enabled ?? false) - Number(a.enabled ?? false) ||
      a.name.localeCompare(b.name),
  )
  return (
    <Card className="gap-0 py-0" data-export-context={`Automation outcomes: tasks created in ${periodText(period)}`}>
      <div className={widgetHeader}>
        <h2 className={widgetHeading}>Automation outcomes</h2>
        <PeriodSelect label="Launched" value={period} onChange={setPeriod} />
      </div>
      <div className="space-y-3 p-4">
        {gate.off ? (
          <p className="text-sm text-muted-foreground">Automations are disabled in this workspace.</p>
        ) : (
          <>
            <InsightState query={query} />
            {data && (
              <>
                <p className="text-xs text-muted-foreground">
                  Tasks each automation created in the period and how they ended. Active means
                  still running, queued or waiting on you.
                </p>
                {sorted.length ? (
                  <div className="overflow-x-auto" role="region" aria-label="Automation outcomes" tabIndex={0}>
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr>
                          <th className={th}>Automation</th>
                          <th className={`${th} text-right`}>Tasks</th>
                          <th className={`${th} text-right`}>Done</th>
                          <th className={`${th} text-right`}>Failed</th>
                          <th className={`${th} text-right`}>Active</th>
                          <th className={th}>Last run</th>
                          {cost && <th className={`${th} text-right`}>Reported USD</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {sorted.map((row) => (
                          <AutomationOutcome
                            key={`${row.projectId}:${row.automationId}`}
                            row={row}
                            cost={!!cost}
                            projectName={projectName}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="py-4 text-sm text-muted-foreground">
                    No automations yet. Create one in a project's Automations page.
                  </p>
                )}
                <span className="block font-mono text-[11px] text-soft-foreground">
                  <Freshness at={data.asOf} />
                </span>
                <ExportRows
                  rows={sorted.flatMap((row) =>
                    (['tasks', 'done', 'failed', 'active'] as const).map((metric) => ({
                      section: 'automation-outcomes',
                      entity: `${row.projectId}:${row.automationId}`,
                      metric,
                      value: row.stat?.[metric] ?? 0,
                      unit: 'tasks',
                      asOf: data.asOf,
                      note: row.name,
                    })),
                  )}
                />
              </>
            )}
          </>
        )}
      </div>
    </Card>
  )
}

function AutomationOutcome({
  row,
  cost,
  projectName,
}: {
  row: AutomationRow
  cost: boolean
  projectName: (id: string) => string
}) {
  const s = row.stat
  const cell = 'px-3 py-2.5 text-right tabular-nums'
  const zero = (n: number | undefined) => (n ? n : <span className="text-soft-foreground">0</span>)
  return (
    <tr className="border-t transition-colors hover:bg-muted/30">
      <td className="px-3 py-2.5">
        {row.removed ? (
          <span className="block font-medium">{row.name}</span>
        ) : (
          <Link
            className="block font-medium hover:underline"
            to={`/p/${encodeURIComponent(row.projectId)}/automations/${encodeURIComponent(row.automationId)}`}
          >
            {row.name}
          </Link>
        )}
        <span className="flex items-center gap-1.5 text-xs text-soft-foreground">
          <StatusDot tone={row.enabled ? 'success' : 'neutral'} />
          {projectName(row.projectId)} ·{' '}
          {row.removed ? 'Removed' : row.enabled ? 'Enabled' : 'Disabled'}
        </span>
      </td>
      <td className={cell}>{zero(s?.tasks)}</td>
      <td className={cell}>{zero(s?.done)}</td>
      <td className={`${cell} ${s?.failed ? 'text-danger' : ''}`}>{zero(s?.failed)}</td>
      <td className={cell}>{zero(s?.active)}</td>
      <td className="whitespace-nowrap px-3 py-2.5 text-xs text-muted-foreground">
        {s?.lastRunAt ? (
          <time dateTime={s.lastRunAt} title={new Date(s.lastRunAt).toLocaleString()}>
            {shortAge(s.lastRunAt)} ago · {s.lastStatus}
          </time>
        ) : (
          '—'
        )}
      </td>
      {cost && (
        <td className={cell}>
          {s?.costUsd?.value == null ? '—' : formatAmount(s.costUsd.value, true)}
        </td>
      )}
    </tr>
  )
}
