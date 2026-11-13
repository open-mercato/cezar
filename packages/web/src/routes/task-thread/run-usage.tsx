import { ChevronDownIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { useRunClaudeAccount } from '@/api/agent-accounts'
import { useHealth } from '@/api/queries'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { accountPart, LiveUsage, liveUsageParts } from '@/components/live-usage'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { compactTokens, formatDuration } from '@/lib/format'
import { useLiveUsageEnabled } from '@/lib/live-usage-pref'
import { formatCost } from '@/lib/tasks-table'
import { usageMetricVisibility } from '@/lib/token-metrics'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'

import { isRunActive } from './run-actions'
import { useRunEngine } from './run-engine'

/**
 * The live gauges (opt-in), then the one usage chip — what the run has spent, and on what. Sits
 * under the composer, not in the header: a folded header must not take the gauges with it.
 */
export function RunUsage({
  run,
  continuationEngine,
  className,
}: {
  run: ApiRun
  /** The Session tab's engine picker for the next continuation, shown inside the chip's popover. */
  continuationEngine?: ReactNode
  className?: string
}) {
  // Token and cost visibility is a server capability; read here so no caller has to plumb it.
  const visibility = usageMetricVisibility(useHealth().data)
  const showLiveUsage = useLiveUsageEnabled() && liveUsageParts(run.liveUsage).length > 0
  const account = accountPart(useRunClaudeAccount(run, showLiveUsage))
  return (
    <span
      data-slot="run-usage"
      className={cn('flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-1.5 text-meta text-muted-foreground', className)}
    >
      {showLiveUsage ? <LiveUsage usage={run.liveUsage} account={account} /> : null}
      <UsageChip run={run} showTokens={visibility.tokens} showCost={visibility.cost} continuationEngine={continuationEngine} />
    </span>
  )
}

/**
 * "6m 13s · 46 in · 6.2k out · $0.83" — one mono chip for the run's time, tokens and cost. Its
 * popover is the detail sheet (Proposal 9: anything that needs three lines is a popover with
 * labels): the exact token counts, and the runner, account, model and canonical identity that
 * produced them — the one place `RunRecord.modelIdentity` (#546) is read — plus the engine
 * picker for the next continuation on the Session tab. A phone shows the cost alone.
 */
function UsageChip({
  run,
  showTokens,
  showCost,
  continuationEngine,
}: {
  run: ApiRun
  showTokens: boolean
  showCost: boolean
  continuationEngine?: ReactNode
}) {
  const { runner, account, model, identity, summary } = useRunEngine(run)
  const startedAt = run.startedAt ? Date.parse(run.startedAt) : Number.NaN
  const live = isRunActive(run.status) && !run.finishedAt
  // A running task's clock ticks; a finished one is a fact.
  const now = useNow(1000, live && Number.isFinite(startedAt))
  const endedAt = run.finishedAt ? Date.parse(run.finishedAt) : now
  const duration = Number.isFinite(startedAt) ? formatDuration(endedAt - startedAt) : ''
  const tokens = showTokens && (run.inputTokens !== undefined || run.outputTokens !== undefined)
  const cost = showCost && run.costUsd ? formatCost(run.costUsd) : ''
  const wide = [
    duration,
    tokens ? `${compactTokens(run.inputTokens ?? 0)} in` : '',
    tokens ? `${compactTokens(run.outputTokens ?? 0)} out` : '',
    cost,
  ].filter(Boolean)
  const narrow = [cost || (tokens ? `${compactTokens((run.inputTokens ?? 0) + (run.outputTokens ?? 0))} tokens` : '') || duration].filter(Boolean)
  const exact = (value: number | undefined) => (value === undefined ? '—' : new Intl.NumberFormat().format(value))

  return (
    <Popover>
      <IconTooltip label="Time, tokens, cost and the agent — click for details">
        <PopoverTrigger asChild>
          <button
            type="button"
            data-slot="agent-badge"
            aria-label={`Agent: ${runner}, ${account ? `account ${account}, ` : ''}model ${model}`}
            className="flex shrink-0 items-center gap-1 rounded-sm border border-border bg-card px-1.5 py-px font-mono text-meta tabular-nums text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <span data-slot="usage-summary" className="max-md:hidden">
              {wide.length > 0 ? wide.join(' · ') : summary}
            </span>
            <span className="md:hidden">{narrow.length > 0 ? narrow.join(' · ') : summary}</span>
            <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
          </button>
        </PopoverTrigger>
      </IconTooltip>
      <PopoverContent align="end" data-slot="run-usage-details" className="w-64 p-3 text-label">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          {duration ? (
            <>
              <dt className="text-muted-foreground">Duration</dt>
              <dd className="tabular-nums">{duration}</dd>
            </>
          ) : null}
          {tokens ? (
            <>
              <dt className="text-muted-foreground">Input tokens</dt>
              <dd className="tabular-nums">{exact(run.inputTokens)}</dd>
              <dt className="text-muted-foreground">Output tokens</dt>
              <dd className="tabular-nums">{exact(run.outputTokens)}</dd>
            </>
          ) : null}
          {cost ? (
            <>
              <dt className="text-muted-foreground">Cost</dt>
              <dd className="tabular-nums">{cost}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Runner</dt>
          <dd className="font-mono">{runner}</dd>
          {/* Omitted, not guessed, when no step recorded one: a run from before accounts existed
              cannot be said to have used the discovered account — nothing wrote that down. */}
          {account ? (
            <>
              <dt className="text-muted-foreground">Account</dt>
              <dd data-slot="agent-badge-account" className="font-mono">{account}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Model</dt>
          <dd className="font-mono">{model}</dd>
          {identity ? (
            <>
              <dt className="text-muted-foreground">Identity</dt>
              <dd data-slot="agent-badge-identity" className="font-mono">{identity}</dd>
            </>
          ) : null}
        </dl>
        {continuationEngine ? (
          <div data-slot="agent-badge-engine-picker" className="mt-3 border-t border-border pt-2">
            <p className="pb-1 text-meta text-muted-foreground">Next continuation</p>
            {continuationEngine}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
