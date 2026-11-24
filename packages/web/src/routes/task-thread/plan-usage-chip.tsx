import { ChevronDownIcon } from 'lucide-react'

import { usePlanUsageConsumers } from '@/api/plan-usage'
import { ApproximateNote, PlanUsageLink, PlanUsageRows, PlanUsageSurface, PlanUsageTitle, type PlanUsageRow } from '@/components/plan-usage-details'
import { approxPp, beforeConsumersWindow, ranTogetherLabel, clockTime, KIND_LABEL, KIND_LONG, PLAN_LIMIT_RUNNERS, planWindowHref, taskWindows } from '@/lib/plan-usage'

const CHIP_CLASS =
  'flex shrink-0 items-center gap-1 rounded-sm border border-border bg-card px-1.5 py-px font-mono text-meta tabular-nums text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none'

/**
 * "This task ≈ N% of 5h" in the usage line (plan-usage design, screen 3). The provider reports per
 * account, so every figure is an estimate tied to one account and one window; no entry is
 * "not measured yet", never 0%.
 */
export function PlanUsageChip({ runId, runner, startedAt }: { runId: string; runner: string; startedAt: string | undefined }) {
  const started = Boolean(startedAt)
  const consumers = usePlanUsageConsumers(started && PLAN_LIMIT_RUNNERS.has(runner))
  if (!started || !consumers.data) return null
  const windows = taskWindows(consumers.data.entries, runId, 'five-hour')
  const latest = windows[0]
  if (!latest) {
    if (!PLAN_LIMIT_RUNNERS.has(runner) || beforeConsumersWindow(startedAt)) return null
    return (
      <span data-slot="plan-usage-chip" data-measured="false" className="shrink-0 text-meta text-soft-foreground">
        This task · plan limit not measured yet
      </span>
    )
  }
  const c = latest.consumer
  const week = taskWindows(consumers.data.entries, runId, 'weekly').find((w) => w.account.key === latest.account.key)
  const earlier = windows.slice(1).reduce((sum, w) => sum + w.consumer.estimatePp, 0)
  const rows: PlanUsageRow[] = [
    ...(c.aloneInferredPp > 0 ? [{ slot: 'plan-usage-alone', label: 'While it was the only cezar task', value: approxPp(c.aloneInferredPp) }] : []),
    ...(c.sharedEstimatePp > 0 ? [{ slot: 'plan-usage-shared', label: `Its share while ${ranTogetherLabel(c)} ran`, value: approxPp(c.sharedEstimatePp) }] : []),
    ...(c.retryWasteEstimatePp > 0 ? [{ slot: 'plan-usage-retry', label: 'of which: failed attempts', value: approxPp(c.retryWasteEstimatePp), indent: true }] : []),
    ...(earlier > 0 ? [{ slot: 'plan-usage-earlier', label: 'Earlier 5-hour limits', value: approxPp(earlier) }] : []),
  ]
  return (
    <PlanUsageSurface
      slot="plan-usage-details"
      tooltip="This task's share of its account's plan limit — click for the breakdown"
      trigger={
        <button type="button" data-slot="plan-usage-chip" data-measured="true" className={CHIP_CLASS}>
          This task {approxPp(c.estimatePp)} of {KIND_LABEL['five-hour']}
          <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
        </button>
      }
    >
      <PlanUsageTitle>Plan limit used by this task</PlanUsageTitle>
      <p data-slot="plan-usage-window" className="text-meta text-muted-foreground">
        {latest.account.label} · {KIND_LONG['five-hour']} {clockTime(latest.startsAt)}–{clockTime(latest.resetsAt)}
      </p>
      <p data-slot="plan-usage-total" className="mt-2 tabular-nums">
        {approxPp(c.estimatePp)} of the 5-hour limit
        {week ? ` · ${approxPp(week.consumer.estimatePp)} of the week` : ''}
      </p>
      <PlanUsageRows rows={rows} />
      <ApproximateNote provider={latest.account.provider} splitBy="task" />
      <PlanUsageLink to={planWindowHref(latest.account.key, latest.windowId)}>See all tasks on this account</PlanUsageLink>
    </PlanUsageSurface>
  )
}
