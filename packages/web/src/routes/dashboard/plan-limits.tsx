import { useRef, type RefObject } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import type { PlanUsageReport, PlanUsageWindow, PlanUsageWindowKind } from '@open-mercato/cezar-api-client'
import { usePlanUsage } from '@/api/plan-usage'
import { useProjects } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Segmented } from '@/components/segmented'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { KIND_LONG, approxPp, clockTime, exactPp } from '@/lib/plan-usage'
import { FilterSelect, widgetHeader, widgetHeading } from './presentation'
import {
  PLAN_KINDS,
  PLAN_PARAMS,
  PROVIDER_NAME,
  SEGMENT_FILL,
  byShare,
  chartGeometry,
  isLimitReached,
  lastUsed,
  managerParts,
  panelQuery,
  ranTogether,
  remainderRows,
  topConsumersLine,
  windowChoices,
  windowRange,
  windowSegments,
  windowStatus,
  type SegmentId,
} from './plan-limits-model'

const LEGEND: { id: SegmentId; label: string }[] = [
  { id: 'tasks', label: 'Tasks' },
  { id: 'managers', label: 'Managers' },
  { id: 'internal', label: 'cezar internal' },
  { id: 'unsplit', label: "Couldn't split" },
  { id: 'untracked', label: 'Not tracked' },
  { id: 'before', label: 'Before tracking' },
  { id: 'outside', label: 'Outside cezar' },
  { id: 'left', label: 'Left' },
]

/** Search-param state shared by the card toggle and the details panel; `replace` keeps Back on the page. */
function usePlanParams() {
  const location = useLocation()
  const [search, setSearch] = useSearchParams()
  const entryKey = location.state?.dashboardEntry ?? location.key
  const update = (patch: Record<string, string | null>) =>
    setSearch((previous) => {
      const next = new URLSearchParams(previous)
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) next.delete(key)
        else next.set(key, value)
      }
      return next
    }, { replace: true, state: { ...location.state, dashboardEntry: entryKey } })
  const kindParam = search.get(PLAN_PARAMS.kind)
  const kind: PlanUsageWindowKind = (PLAN_KINDS as readonly string[]).includes(kindParam ?? '') ? kindParam as PlanUsageWindowKind : 'five-hour'
  return { search, update, kind }
}

/** Dashboard → Usage & cost: who used each plan limit (design screens 1 and 2). All projects. */
export function PlanLimits() {
  const { search, update, kind } = usePlanParams()
  const query = usePlanUsage({ kind })
  const trigger = useRef<HTMLElement | null>(null)
  const account = search.get(PLAN_PARAMS.account)
  const open = (key: string | null, target: HTMLElement) => {
    trigger.current = target
    update({ [PLAN_PARAMS.account]: key ?? query.data?.windows[0]?.account.key ?? query.data?.accounts[0]?.key ?? null, [PLAN_PARAMS.window]: null })
  }
  return (
    <Card className="gap-0 py-0" data-plan-limits>
      <div className={widgetHeader}>
        <div>
          <h2 className={widgetHeading}>Plan limits</h2>
          <p className="mt-1 text-label text-muted-foreground">
            Who used your agent subscriptions in the current {kind === 'weekly' ? 'week' : '5-hour window'}
          </p>
        </div>
        <Segmented
          slot="plan-kind"
          label="Limit window"
          value={kind}
          options={[{ value: 'five-hour', label: '5 hours' }, { value: 'weekly', label: 'Week' }]}
          onChange={(value) => update({ [PLAN_PARAMS.kind]: value })}
        />
      </div>
      <div className="p-4">
        <CardBody report={query.data} pending={query.isPending} error={query.isError} retry={() => void query.refetch()} kind={kind} onOpen={open} />
      </div>
      <PlanDetails
        account={account}
        onClose={() => {
          update({ [PLAN_PARAMS.account]: null, [PLAN_PARAMS.window]: null })
        }}
        trigger={trigger}
      />
    </Card>
  )
}

function CardBody({ report, pending, error, retry, kind, onOpen }: {
  report: PlanUsageReport | undefined
  pending: boolean
  error: boolean
  retry: () => void
  kind: PlanUsageWindowKind
  onOpen: (key: string | null, target: HTMLElement) => void
}) {
  if (!report) {
    if (pending) return <p role="status" className="text-sm text-muted-foreground">Loading plan limits…</p>
    if (error) return (
      <p role="alert" className="text-sm">
        Could not load plan limits.{' '}
        <Button variant="outline" className="min-h-11" onClick={retry}>Retry</Button>
      </p>
    )
    return null
  }
  if (!report.tracking.enabled) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Plan-limit tracking is off on this machine (<code className="font-mono">CEZ_USAGE_LOG=0</code>).
        {report.tracking.reason ? ` ${report.tracking.reason}` : ''}
      </p>
    )
  }
  const windows = [...report.windows].sort((a, b) => a.account.key.localeCompare(b.account.key))
  const silent = report.accounts.filter((a) => !windows.some((w) => w.account.key === a.key))
  if (windows.length === 0 && silent.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        <p role="status">No plan-limit readings yet. They appear once a Claude or Codex task reports its limit.</p>
        <NotListed />
      </div>
    )
  }
  return (
    <div className="grid gap-4">
      {windows.map((w) => <AccountBar key={w.id} window={w} onOpen={onOpen} />)}
      {silent.map((a) => (
        <p key={a.key} className="text-sm text-muted-foreground">
          <button type="button" className="font-medium text-foreground underline-offset-2 hover:underline" onClick={(e) => onOpen(a.key, e.currentTarget)}>
            {a.label}
          </button>{' '}
          · no reading in the current {kind === 'weekly' ? 'week' : '5 hours'}
        </p>
      ))}
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-label text-muted-foreground" aria-label="Legend">
        {LEGEND.map((item) => (
          <li key={item.id} className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className={`size-2.5 rounded-sm ${SEGMENT_FILL[item.id]}`} />
            {item.label}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <NotListed />
        <Button variant="ghost" className="min-h-11" onClick={(e) => onOpen(null, e.currentTarget)}>Details →</Button>
      </div>
    </div>
  )
}

function NotListed() {
  return <p className="text-label text-muted-foreground">Tools without plan limits (OpenCode, Cursor, API keys…) aren't listed: they don't report them.</p>
}

function segmentsLabel(w: PlanUsageWindow): string {
  return windowSegments(w).map((s) => `${s.label} ${s.id === 'tasks' || s.id === 'managers' ? approxPp(s.pp) : exactPp(s.pp)}`).join(', ')
}

/** A span inside the account button, whose label carries the breakdown (`segmentsLabel`). */
function StackedBar({ window: w }: { window: PlanUsageWindow }) {
  const segments = windowSegments(w)
  return (
    <span className="flex h-3 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
      {segments.map((s) => (
        <span key={s.id} data-segment={s.id} className={`h-full ${SEGMENT_FILL[s.id]}`} style={{ width: `${s.width}%` }} />
      ))}
    </span>
  )
}

function AccountBar({ window: w, onOpen }: { window: PlanUsageWindow; onOpen: (key: string, target: HTMLElement) => void }) {
  const line = topConsumersLine(w)
  const reached = isLimitReached(w)
  return (
    <button
      type="button"
      data-plan-account={w.account.key}
      aria-label={`${w.account.label}: ${windowStatus(w)}. ${segmentsLabel(w)}. Show details`}
      className="grid w-full gap-2 rounded-lg p-2 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
      onClick={(e) => onOpen(w.account.key, e.currentTarget)}
    >
      <span className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
        <span className="font-medium">{w.account.label}</span>
        <span className={reached ? 'font-medium text-danger' : 'text-muted-foreground tabular-nums'}>{windowStatus(w)}</span>
      </span>
      <StackedBar window={w} />
      {line ? <span className="text-label text-muted-foreground">{line}</span> : null}
    </button>
  )
}

/** The side panel: openable from `?view=costs&planAccount=<key>&planWindow=<current|previous|windowId>&planKind=<five-hour|weekly>`. */
function PlanDetails({ account, onClose, trigger }: { account: string | null; onClose: () => void; trigger: RefObject<HTMLElement | null> }) {
  return (
    <Sheet open={!!account} onOpenChange={(open) => { if (!open) onClose() }}>
      <SheetContent
        className="w-full overflow-y-auto sm:max-w-3xl"
        onCloseAutoFocus={(e) => {
          if (!trigger.current?.isConnected) return
          e.preventDefault()
          trigger.current.focus()
        }}
      >
        <SheetHeader>
          <SheetTitle>Plan limits · details</SheetTitle>
          <SheetDescription>Every share is an estimate: providers report usage per account, never per task.</SheetDescription>
        </SheetHeader>
        {account ? <PanelBody account={account} /> : null}
      </SheetContent>
    </Sheet>
  )
}

function PanelBody({ account }: { account: string }) {
  const { search, update } = usePlanParams()
  const q = panelQuery(search.get(PLAN_PARAMS.window), search.get(PLAN_PARAMS.kind))
  const report = usePlanUsage({ account, ...q })
  const w = report.data?.windows[0]
  const kind = w?.kind ?? q.kind ?? 'five-hour'
  const history = usePlanUsage({ account, kind, window: 'all' })
  const accounts = useAccountsList(report.data)
  const pickerValue = q.kind ? `${q.kind}:${q.window}` : q.window
  const choices = windowChoices(kind, history.data?.windows ?? [], q.kind ? undefined : q.window)
  return (
    <div className="grid gap-5 px-4 pb-6" data-sheet-loading={report.isPending ? 'true' : 'false'}>
      <div className="flex flex-wrap gap-3">
        <FilterSelect
          label="Account"
          value={account}
          onValueChange={(key) => update({ [PLAN_PARAMS.account]: key })}
          options={accounts.some((a) => a.value === account) ? accounts : [...accounts, { value: account, label: account }]}
        />
        <FilterSelect
          label="Window"
          value={pickerValue}
          onValueChange={(value) => {
            const [k, sel] = value.split(':')
            if (sel && (PLAN_KINDS as readonly string[]).includes(k!)) update({ [PLAN_PARAMS.kind]: k!, [PLAN_PARAMS.window]: sel === 'current' ? null : sel })
            else update({ [PLAN_PARAMS.window]: value })
          }}
          options={choices}
        />
      </div>
      {report.isPending ? <p role="status" className="text-sm text-muted-foreground">Loading…</p>
        : report.isError ? (
          <p role="alert" className="text-sm">Could not load this window. <Button variant="outline" className="min-h-11" onClick={() => void report.refetch()}>Retry</Button></p>
        ) : !w ? (
          <p role="status" className="text-sm text-muted-foreground">No readings for this account in this window.</p>
        ) : (
          <WindowDetails window={w} hints={report.data!.hints.filter((h) => h.windowId === w.id)} />
        )}
    </div>
  )
}

function useAccountsList(report: PlanUsageReport | undefined) {
  const card = usePlanUsage({})
  const seen = new Map<string, string>()
  for (const a of [...(card.data?.accounts ?? []), ...(report?.accounts ?? [])]) seen.set(a.key, a.label)
  return [...seen].map(([value, label]) => ({ value, label }))
}

function WindowDetails({ window: w, hints }: { window: PlanUsageWindow; hints: PlanUsageReport['hints'] }) {
  const provider = PROVIDER_NAME[w.account.provider]
  return (
    <>
      <p className="text-sm">
        <span className="font-medium">{w.account.label}</span>
        <span className="text-muted-foreground"> · {KIND_LONG[w.kind]} · {windowRange(w)} · {windowStatus(w)}</span>
      </p>
      <section aria-labelledby="plan-chart-title" className="grid gap-2">
        <h3 id="plan-chart-title" className="text-sm font-medium">How the limit filled up <span className="font-normal text-muted-foreground">(one step per reading from {provider})</span></h3>
        <StepChart window={w} />
      </section>
      <ConsumerTable window={w} provider={provider} />
      {hints.length > 0 && (
        <section aria-labelledby="plan-hints-title" className="grid gap-2 rounded-lg border p-3">
          <h3 id="plan-hints-title" className="text-sm font-medium">Worth a look</h3>
          <ul className="grid list-disc gap-1.5 pl-5 text-sm">
            {hints.map((h) => <li key={h.id}>{h.text}</li>)}
          </ul>
        </section>
      )}
    </>
  )
}

const CHART_W = 600
const CHART_H = 160

function StepChart({ window: w }: { window: PlanUsageWindow }) {
  const g = chartGeometry(w, CHART_W, CHART_H)
  const used = lastUsed(w)
  const label = `${w.readings.length} readings; ${used === null ? 'no reading' : `last ${exactPp(used)}`}${g.limit ? `; limit reached at ${clockTime(g.limit.at)}` : ''}`
  return (
    <svg viewBox={`-36 -8 ${CHART_W + 44} ${CHART_H + 30}`} className="h-auto w-full text-muted-foreground" role="img" aria-label={label} data-plan-chart>
      {[0, 50, 100].map((pct) => {
        const y = CHART_H - (pct / 100) * CHART_H
        return (
          <g key={pct}>
            <line x1={0} x2={CHART_W} y1={y} y2={y} stroke="currentColor" strokeOpacity={0.2} />
            <text x={-6} y={y + 4} textAnchor="end" fontSize={11} fill="currentColor">{pct}%</text>
          </g>
        )
      })}
      {g.ticks.map((t) => (
        <text key={t.x} x={t.x} y={CHART_H + 18} textAnchor="middle" fontSize={11} fill="currentColor">{t.label}</text>
      ))}
      {g.limit && (
        <g data-limit-marker className="text-danger">
          <line x1={g.limit.x} x2={g.limit.x} y1={0} y2={CHART_H} stroke="currentColor" strokeDasharray="4 3" />
          <text x={Math.min(g.limit.x + 4, CHART_W - 110)} y={12} fontSize={11} fill="currentColor">limit reached {clockTime(g.limit.at)}</text>
        </g>
      )}
      {g.path && <path d={g.path} fill="none" stroke="var(--color-violet)" strokeWidth={2} />}
      {g.points.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={2.5} fill="var(--color-violet)" />)}
    </svg>
  )
}

function ConsumerTable({ window: w, provider }: { window: PlanUsageWindow; provider: string }) {
  const projects = useProjects().data?.projects
  const projectName = (id?: string) => (id ? projects?.find((p) => p.id === id)?.name ?? id : '—')
  const used = lastUsed(w)
  const cell = 'px-2 py-2 align-top'
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="text-left text-label text-muted-foreground">
          <tr className="border-b">
            {['Used by', 'Project', 'Share', 'Ran alone', 'Ran together with', 'Failed attempts'].map((h) => (
              <th key={h} scope="col" className={`${cell} font-medium`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {byShare(w.consumers).map((c) => {
            const parts = managerParts(c)
            return (
              <tr key={c.id} className="border-b" data-consumer={c.id}>
                <td className={cell}>
                  {c.kind === 'task' && c.projectId && c.runId ? (
                    <Link className="underline-offset-2 hover:underline" to={`/p/${encodeURIComponent(c.projectId)}/tasks/${encodeURIComponent(c.runId)}`}>{c.title}</Link>
                  ) : c.kind === 'manager' && c.managerId ? (
                    <Link className="underline-offset-2 hover:underline" to={`/manager/${encodeURIComponent(c.managerId)}`}>{c.title}</Link>
                  ) : c.title}
                  {parts ? <span className="block text-label text-muted-foreground">{parts}</span> : null}
                </td>
                <td className={cell}>{c.kind === 'task' ? projectName(c.projectId) : '—'}</td>
                <td className={`${cell} tabular-nums`}>{approxPp(c.estimatePp)}</td>
                <td className={`${cell} tabular-nums`}>{approxPp(c.aloneInferredPp)}</td>
                <td className={cell}>{ranTogether(c)}</td>
                <td className={`${cell} tabular-nums`}>{c.retryWasteEstimatePp > 0 ? approxPp(c.retryWasteEstimatePp) : '—'}</td>
              </tr>
            )
          })}
          {remainderRows(w).map((r) => (
            <tr key={r.id} className="border-b text-muted-foreground" data-remainder={r.id}>
              <td className={cell} colSpan={2}>{r.label}</td>
              <td className={`${cell} tabular-nums`} colSpan={4}>{r.value}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-medium">
            <td className={cell} colSpan={2}>Total</td>
            <td className={`${cell} tabular-nums`} colSpan={4}>
              {used === null ? '—' : exactPp(used)} <span className="font-normal text-muted-foreground">= what {provider} reported for the account</span>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
