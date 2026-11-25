import { formatPlanPp, type PlanUsageConsumerWindow, type RunRecord } from '@open-mercato/cezar-api-client'

import { IconTooltip } from '@/components/ui/icon-tooltip'
import { approxPp, beforeConsumersWindow, clockTime, KIND_LONG, PLAN_LIMIT_RUNNERS, taskWindows } from '@/lib/plan-usage'
import { cn } from '@/lib/utils'

/** What the Tasks table's "Plan limit" cell says for one run (plan-usage design, screen 4). */
export type PlanLimitCell =
  | { kind: 'share'; estimatePp: number; nextPp: number; retry: boolean; alone: boolean; title: string }
  | { kind: 'not-measured' }
  | { kind: 'not-reported' }
  | { kind: 'none' }

/**
 * `entries` undefined = the ledger has not answered (a dash, not a claim). The run's FIRST 5-hour window is the figure; later windows it continued into are "+N% next".
 * No entry is never 0%: "not measured yet" for a tool with limits, "not reported" for the rest.
 */
export function planLimitCell(
  run: Pick<RunRecord, 'id' | 'runner' | 'startedAt'>,
  entries: PlanUsageConsumerWindow[] | undefined,
  defaultRunner: string | undefined,
): PlanLimitCell {
  if (entries === undefined) return { kind: 'none' }
  const windows = taskWindows(entries, run.id, 'five-hour').reverse()
  const first = windows[0]
  if (!first) {
    if (!run.startedAt || beforeConsumersWindow(run.startedAt)) return { kind: 'none' }
    return PLAN_LIMIT_RUNNERS.has(run.runner ?? defaultRunner ?? 'claude') ? { kind: 'not-measured' } : { kind: 'not-reported' }
  }
  const later = windows.slice(1)
  return {
    kind: 'share',
    estimatePp: first.consumer.estimatePp,
    nextPp: later.reduce((sum, w) => sum + w.consumer.estimatePp, 0),
    retry: windows.some((w) => w.consumer.retryWasteEstimatePp > 0),
    alone: windows.every((w) => w.consumer.sharedEstimatePp === 0),
    title: `${first.account.label} · ${KIND_LONG['five-hour']} ${clockTime(first.startsAt)}–${clockTime(first.resetsAt)}`,
  }
}

/** One consumers response split per run, so a row's input changes only when its own share does. */
export function planWindowsByRun(entries: PlanUsageConsumerWindow[]): Map<string, PlanUsageConsumerWindow[]> {
  const byRun = new Map<string, PlanUsageConsumerWindow[]>()
  for (const entry of entries) {
    const runId = entry.consumer.kind === 'task' ? entry.consumer.runId : undefined
    if (runId === undefined || entry.kind !== 'five-hour') continue
    byRun.set(runId, [...(byRun.get(runId) ?? []), entry])
  }
  return byRun
}

export function PlanLimitCellView({ cell }: { cell: PlanLimitCell }) {
  if (cell.kind === 'none') return <span className="text-xs text-soft-foreground">—</span>
  if (cell.kind !== 'share') {
    return (
      <span data-slot="plan-limit" data-state={cell.kind} className="text-xs text-soft-foreground">
        {cell.kind === 'not-measured' ? 'not measured yet' : 'not reported'}
      </span>
    )
  }
  return (
    <span data-slot="plan-limit" data-state="share" className="inline-flex flex-col items-end gap-0.5">
      <span className="inline-flex items-center gap-1 font-mono text-xs tabular-nums text-muted-foreground">
        <span data-slot="plan-limit-share">{approxPp(cell.estimatePp)} 5h</span>
        {cell.retry ? (
          <IconTooltip label="Part went to a failed attempt" side="top">
            <span data-slot="plan-limit-retry" tabIndex={0} aria-label="Part went to a failed attempt" className="text-warning outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
              ↻
            </span>
          </IconTooltip>
        ) : null}
        {cell.alone ? <span data-slot="plan-limit-alone" className="text-soft-foreground">alone</span> : null}
        {cell.nextPp > 0 ? (
          <span data-slot="plan-limit-next" className="text-soft-foreground">+{formatPlanPp(cell.nextPp)}% next</span>
        ) : null}
      </span>
      <span aria-hidden="true" className="h-1 w-16 overflow-hidden rounded-full bg-muted">
        <span
          data-slot="plan-limit-bar"
          className={cn('block h-full rounded-full', cell.estimatePp >= 50 ? 'bg-warning' : 'bg-primary/70')}
          style={{ width: `${Math.max(2, Math.min(100, cell.estimatePp))}%` }}
        />
      </span>
    </span>
  )
}
