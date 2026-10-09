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
import { Coverage } from './rows'
import { formatAmount, formatHours } from './format'
import { CircleCheck, Cpu, Workflow } from 'lucide-react'
import { FilterSelect, filterLabel, Freshness, InfoHint, Notice, ReportNote, tableHead, tableRow, WidgetEmpty, WidgetSkeleton, widgetBody, widgetHeader, widgetHeading, widgetMeta } from './presentation'
import { useDashboardFilter } from './url-filter'

type Period = DashboardInsights['period']
const periodText = (period: Period) => `Last ${period === '7d' ? 7 : 30} calendar days`
const bandLabel = 'text-[15px] leading-6 font-semibold text-foreground'
const panel = 'min-w-0 rounded-xl border bg-card p-5 shadow-xs'
const th = tableHead
const backendsDefinition =
  'Tasks that finished done or failed in the period, by the backend and model their steps ran on. Includes subtasks. Cost is reported USD only.'
const automationsDefinition =
  'Tasks each automation created in the period and how they ended. Active means still running, queued, waiting on you, or waiting to resume after a usage limit.'

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
  if (query.isPending) return <WidgetSkeleton label="Loading insights…" />
  if (!query.isError) return null
  return (
    <Notice
      action={
        <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
          Retry insights
        </Button>
      }
    >
      {query.data ? 'Showing previous results. ' : ''}Could not refresh insights.
    </Notice>
  )
}

/** Delivered work and failure reasons: the two answers under the overview's outcome tiles. */
export function OutcomeInsights({ period, active }: { period: Period; active: boolean }) {
  const query = useDashboardInsights(period, active)
  const data = query.data
  return (
    <div className="space-y-4">
      {query.isPending ? (
        <div className="grid gap-6 @3xl:grid-cols-2">
          <div className={panel}>
            <InsightState query={query} />
          </div>
          <div className={`${panel} @max-3xl:hidden`} aria-hidden="true">
            <WidgetSkeleton label="" />
          </div>
        </div>
      ) : (
        <InsightState query={query} />
      )}
      {data && <Coverage coverage={data.coverage} retry={() => void query.refetch()} />}
      {data && (
        <div className="grid gap-6 @3xl:grid-cols-2">
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
      <dl className="mt-4 flex flex-wrap gap-x-10 gap-y-4">
        {stats.map((s) => (
          <div key={s.label} className="min-w-16">
            <dt className="text-[13px] text-muted-foreground">{s.label}</dt>
            <dd className="mt-1 text-2xl leading-8 font-semibold tracking-tight whitespace-nowrap tabular-nums">
              {s.value}
            </dd>
            {s.note && <dd className="text-xs text-soft-foreground">{s.note}</dd>}
          </div>
        ))}
      </dl>
      <span className="mt-4 block text-xs text-muted-foreground">
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
          <span className={widgetMeta}>{total} failed</span>
        )}
      </div>
      {total === 0 ? (
        <WidgetEmpty icon={CircleCheck} title="No failed outcomes in this period" className="md:p-6" />
      ) : (
        <ul className="mt-4 space-y-4">
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
        <span className="text-xs tabular-nums text-muted-foreground">{reason.count}</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div className="h-full rounded-full bg-danger/60" style={{ width: `${(reason.count / total) * 100}%` }} />
      </div>
      <span className="mt-1.5 block truncate text-xs text-soft-foreground" title={latest.message}>
        Latest:{' '}
        <Link className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" to={taskPath(latest.projectId, latest.id)}>
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
  mixed: 'Mixed backends',
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
    <section data-dashboard-module="backends" className="min-w-0">
    <Card className="gap-0 py-0" data-export-context={`Backends: ${periodText(period)}; finished tasks`}>
      <div className={widgetHeader}>
        <div className="flex items-center gap-1">
          <h2 className={widgetHeading}>Backends & models</h2>
          <InfoHint label="About backends and models">{backendsDefinition}</InfoHint>
        </div>
        <PeriodSelect label="Finished" value={period} onChange={setPeriod} />
      </div>
      <div className={widgetBody}>
        <InsightState query={query} />
        {data && (
          <>
            <ReportNote>{backendsDefinition}</ReportNote>
            <Coverage coverage={data.coverage} retry={() => void query.refetch()} />
            {data.backends.length ? (
              <div className="-mx-3 overflow-x-auto" role="region" aria-label="Backend comparison" tabIndex={0}>
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
              <WidgetEmpty icon={Cpu} title="No finished tasks in this period." />
            )}
            <span className="block text-xs text-soft-foreground">
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
    </section>
  )
}

function BackendRow({ stat: b, cost }: { stat: DashboardBackendStat; cost: boolean }) {
  const rate = percent(b.done, b.finished)
  const usd = b.costUsd?.value
  return (
    <tr className={tableRow}>
      <td className="px-3 py-2.5">
        <span className="block font-medium">{backendName(b.backend)}</span>
        <span className="block font-mono text-[11px] text-soft-foreground">
          {b.backend === 'mixed' ? 'steps ran on different backends' : (b.model ?? 'default model')}
        </span>
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums">{b.finished}</td>
      <td className="min-w-40 px-3 py-2.5">
        <span className="flex items-center gap-2">
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-danger/30" aria-hidden="true">
            <span className="block h-full rounded-full bg-success" style={{ width: `${rate}%` }} />
          </span>
          <span className="w-10 text-right text-xs tabular-nums">{rate}%</span>
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
  /** `removed` only when the project's definitions were READ and it is not among them; a
   *  failed or pending read is `unknown` — never report a deletion we did not observe. */
  definition: 'known' | 'removed' | 'unknown'
  stat?: DashboardAutomationStat
}

/** What each automation launched in the period, including the ones that launched nothing. */
export function AutomationOutcomes() {
  // The period control lives in the page header (index.tsx); both read the same URL key.
  const [period] = useDashboardFilter('automations', ['7d', '30d'] as const, '7d')
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
        definition: 'known',
      })
  const read = new Set(
    (definitions.data ?? []).flatMap((project) => (project.data && !project.error ? [project.id] : [])),
  )
  const detailsFailed =
    definitions.isError ||
    definitions.registry.isError ||
    (definitions.data ?? []).some((project) => project.error)
  for (const stat of data?.automations ?? []) {
    const key = `${stat.projectId}\u0000${stat.automationId}`
    const known = rows.get(key)
    rows.set(
      key,
      known
        ? { ...known, stat }
        : {
            ...stat,
            name: stat.automationId,
            definition: read.has(stat.projectId) ? 'removed' : 'unknown',
            stat,
          },
    )
  }
  const sorted = [...rows.values()].sort(
    (a, b) =>
      (b.stat?.tasks ?? 0) - (a.stat?.tasks ?? 0) ||
      Number(b.enabled ?? false) - Number(a.enabled ?? false) ||
      a.name.localeCompare(b.name),
  )
  return (
    <section data-dashboard-module="automation-outcomes" className="min-w-0">
    <Card className="gap-0 py-0" data-export-context={`Launched: Last ${period === '7d' ? 7 : 30} days; Automation outcomes: tasks created in ${periodText(period)}`}>
      <div className={widgetHeader}>
        <div className="flex items-center gap-1">
          <h2 className={widgetHeading}>Automation outcomes</h2>
          <InfoHint label="About automation outcomes">{automationsDefinition}</InfoHint>
        </div>
        <span className={widgetMeta}>Launched in the last {period === '7d' ? 7 : 30} days</span>
      </div>
      <div className={widgetBody}>
        {gate.off ? (
          <WidgetEmpty icon={Workflow} title="Automations are disabled in this workspace." />
        ) : (
          <>
            <InsightState query={query} />
            {data && (
              <>
                <ReportNote>{automationsDefinition}</ReportNote>
                <Coverage coverage={data.coverage} retry={() => void query.refetch()} />
                {detailsFailed && (
                  <Notice
                    action={
                      <Button variant="outline" size="sm" onClick={definitions.retry}>
                        Retry automations
                      </Button>
                    }
                  >
                    Some automation details could not be loaded. Their outcomes are shown by id.
                  </Notice>
                )}
                {sorted.length ? (
                  <div className="-mx-3 overflow-x-auto" role="region" aria-label="Automation outcomes" tabIndex={0}>
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
                  <WidgetEmpty icon={Workflow} title="No automations yet.">
                    Create one in a project's Automations page.
                  </WidgetEmpty>
                )}
                <span className="block text-xs text-soft-foreground">
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
    </section>
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
    <tr className={tableRow}>
      <td className="px-3 py-2.5">
        {row.definition === 'removed' ? (
          <span className="block font-medium">{row.name}</span>
        ) : (
          <Link
            className="block font-medium underline-offset-4 hover:underline"
            to={`/p/${encodeURIComponent(row.projectId)}/automations/${encodeURIComponent(row.automationId)}`}
          >
            {row.name}
          </Link>
        )}
        <span className="flex items-center gap-1.5 text-xs text-soft-foreground">
          <StatusDot tone={row.enabled ? 'success' : 'neutral'} />
          {projectName(row.projectId)} ·{' '}
          {row.definition === 'removed'
            ? 'Removed'
            : row.definition === 'unknown'
              ? 'Details unavailable'
              : row.enabled
                ? 'Enabled'
                : 'Disabled'}
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
