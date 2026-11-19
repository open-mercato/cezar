import { ChevronDownIcon } from 'lucide-react'
import { Link as RouterLink } from 'react-router'

import type { PlanUsageConsumerWindow } from '@open-mercato/cezar-api-client'
import { usePlanUsageConsumers } from '@/api/plan-usage'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { approxPp, clockTime, KIND_LABEL, KIND_LONG, PLAN_LIMIT_RUNNERS, planWindowHref, taskWindows } from '@/lib/plan-usage'

const CHIP_CLASS =
  'flex shrink-0 items-center gap-1 rounded-sm border border-border bg-card px-1.5 py-px font-mono text-meta tabular-nums text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none'

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** "2 other tasks", "1 other task and 1 manager". */
export function ranTogetherLabel(c: PlanUsageConsumerWindow['consumer']): string {
  const { tasks, managers } = c.ranTogetherWith
  const parts = [tasks > 0 ? plural(tasks, 'other task') : '', managers > 0 ? plural(managers, 'manager') : '']
  return parts.filter(Boolean).join(' and ') || 'other cezar work'
}

/**
 * "This task ≈ N% of 5h" in the usage line (plan-usage design, screen 3). The provider reports per
 * account, so every figure is an estimate tied to one account and one window; no entry is
 * "not measured yet", never 0%.
 */
export function PlanUsageChip({ runId, runner, started }: { runId: string; runner: string; started: boolean }) {
  const consumers = usePlanUsageConsumers(started)
  if (!started || !consumers.data) return null
  const windows = taskWindows(consumers.data.entries, runId, 'five-hour')
  const latest = windows[0]
  if (!latest) {
    if (!PLAN_LIMIT_RUNNERS.has(runner)) return null
    return (
      <span data-slot="plan-usage-chip" data-measured="false" className="shrink-0 text-meta text-soft-foreground">
        This task · plan limit not measured yet
      </span>
    )
  }
  const c = latest.consumer
  const week = taskWindows(consumers.data.entries, runId, 'weekly').find((w) => w.account.key === latest.account.key)
  const earlier = windows.slice(1).reduce((sum, w) => sum + w.consumer.estimatePp, 0)
  const provider = latest.account.provider === 'codex' ? 'Codex' : 'Claude'
  const own = latest.account.provider === 'codex' ? 'Codex' : 'Claude Code'
  const weight = latest.account.provider === 'codex' ? 'tokens' : 'cost'
  return (
    <Popover>
      <IconTooltip label="This task's share of its account's plan limit — click for the breakdown">
        <PopoverTrigger asChild>
          <button type="button" data-slot="plan-usage-chip" data-measured="true" className={CHIP_CLASS}>
            This task {approxPp(c.estimatePp)} of {KIND_LABEL['five-hour']}
            <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
          </button>
        </PopoverTrigger>
      </IconTooltip>
      <PopoverContent align="end" data-slot="plan-usage-details" className="w-80 p-3 text-label">
        <p className="font-medium text-foreground">Plan limit used by this task</p>
        <p data-slot="plan-usage-window" className="text-meta text-muted-foreground">
          {latest.account.label} · {KIND_LONG['five-hour']} {clockTime(latest.startsAt)}–{clockTime(latest.resetsAt)}
        </p>
        <p data-slot="plan-usage-total" className="mt-2 tabular-nums">
          {approxPp(c.estimatePp)} of the 5-hour limit
          {week ? ` · ${approxPp(week.consumer.estimatePp)} of the week` : ''}
        </p>
        <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 tabular-nums">
          {c.aloneInferredPp > 0 ? (
            <>
              <dt className="text-muted-foreground">While it was the only cezar task</dt>
              <dd data-slot="plan-usage-alone">{approxPp(c.aloneInferredPp)}</dd>
            </>
          ) : null}
          {c.sharedEstimatePp > 0 ? (
            <>
              <dt className="text-muted-foreground">Its share while {ranTogetherLabel(c)} ran</dt>
              <dd data-slot="plan-usage-shared">{approxPp(c.sharedEstimatePp)}</dd>
            </>
          ) : null}
          {c.retryWasteEstimatePp > 0 ? (
            <>
              <dt className="pl-3 text-muted-foreground">of which: failed attempts</dt>
              <dd data-slot="plan-usage-retry">{approxPp(c.retryWasteEstimatePp)}</dd>
            </>
          ) : null}
          {earlier > 0 ? (
            <>
              <dt className="text-muted-foreground">Earlier 5-hour limits</dt>
              <dd data-slot="plan-usage-earlier">{approxPp(earlier)}</dd>
            </>
          ) : null}
        </dl>
        <p className="mt-2 text-meta text-muted-foreground">
          Approximate: {provider} reports usage per account, so busy periods are split by each task's {weight}, and
          your own {own} sessions can't be told apart.
        </p>
        <RouterLink
          to={planWindowHref(latest.account.key, latest.windowId)}
          data-slot="plan-usage-link"
          className="mt-2 inline-block text-meta text-primary underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
        >
          See all tasks on this account
        </RouterLink>
      </PopoverContent>
    </Popover>
  )
}
