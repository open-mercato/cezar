import { ChevronDownIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { useRunClaudeAccount } from '@/api/agent-accounts'
import { useHealth } from '@/api/queries'
import type { ApiRun, ModelUsage } from '@open-mercato/cezar-api-client'
import { accountPart, LiveUsage, liveUsageParts } from '@/components/live-usage'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { compactTokens, formatDuration } from '@/lib/format'
import { useLiveUsageEnabled } from '@/lib/live-usage-pref'
import { formatCost } from '@/lib/tasks-table'
import { otherRunModels, stepModelRows } from '@/lib/actual-model'
import { usageMetricVisibility } from '@/lib/token-metrics'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'

import { PlanUsageChip } from './plan-usage-chip'
import { isRunActive } from './run-actions'
import { useRunEngine } from './run-engine'

/**
 * The live gauges (opt-in), then the one usage chip — what the run has spent, and on what. Sits
 * under the composer, not in the header: a folded header must not take the gauges with it.
 */
export function RunUsage({
  run,
  continuationEngine,
  reportedModel,
  className,
}: {
  run: ApiRun
  /** The Session tab's engine picker for the next continuation, shown inside the chip's popover. */
  continuationEngine?: ReactNode
  /** The thread's last `session.started.model` — the actual model of a run recorded before
   *  `RunRecord.actualModel` existed. */
  reportedModel?: string
  className?: string
}) {
  // Token and cost visibility is a server capability; read here so no caller has to plumb it.
  const visibility = usageMetricVisibility(useHealth().data)
  const showLiveUsage = useLiveUsageEnabled() && liveUsageParts(run.liveUsage).length > 0
  const account = accountPart(useRunClaudeAccount(run, showLiveUsage))
  const { runner } = useRunEngine(run, reportedModel)
  // Shrinkable: a fixed-width strip in the right-aligned dock overflowed off the phone's left edge.
  return (
    <span
      data-slot="run-usage"
      className={cn('flex min-w-0 flex-wrap items-center justify-end gap-1.5 text-meta text-muted-foreground', className)}
    >
      {showLiveUsage ? <LiveUsage usage={run.liveUsage} account={account} /> : null}
      <PlanUsageChip runId={run.id} runner={runner} startedAt={run.startedAt} />
      <UsageChip
        run={run}
        showTokens={visibility.tokens}
        showCost={visibility.cost}
        continuationEngine={continuationEngine}
        reportedModel={reportedModel}
      />
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
  reportedModel,
}: {
  run: ApiRun
  showTokens: boolean
  showCost: boolean
  continuationEngine?: ReactNode
  reportedModel?: string
}) {
  const { runner, account, model, actualModel, modelLabel, identity, summary } = useRunEngine(run, reportedModel)
  const steps = stepModelRows(run)
  const earlier = otherRunModels(run, actualModel)
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
            aria-label={`Agent: ${runner}, ${account ? `account ${account}, ` : ''}model ${modelLabel}`}
            className="flex shrink-0 items-center gap-1 rounded-sm border border-border bg-card px-1.5 py-px font-mono text-meta tabular-nums text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <span data-slot="usage-summary" className="max-md:hidden">
              {wide.length > 0 ? wide.join(' · ') : summary}
            </span>
            {/* The model the agent actually ran, beside what was asked: "auto → claude-opus-…".
                The bare summary above already names it when there are no numbers yet. */}
            {wide.length > 0 && actualModel ? (
              <span data-slot="agent-badge-model" title={modelLabel} className="max-w-64 truncate max-md:hidden">
                · {modelLabel}
              </span>
            ) : null}
            <span className="md:hidden">{narrow.length > 0 ? narrow.join(' · ') : summary}</span>
            <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
          </button>
        </PopoverTrigger>
      </IconTooltip>
      <PopoverContent align="end" data-slot="run-usage-details" className="w-72 p-3 text-label">
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
          {actualModel ? (
            <>
              <dt className="text-muted-foreground">Ran as</dt>
              <dd data-slot="agent-badge-actual-model" className="font-mono break-all">{actualModel}</dd>
            </>
          ) : null}
          {earlier.length > 0 ? (
            <>
              <dt className="text-muted-foreground">Also used</dt>
              <dd data-slot="agent-badge-other-models" className="font-mono break-all">{earlier.join(', ')}</dd>
            </>
          ) : null}
          {identity ? (
            <>
              <dt className="text-muted-foreground">Identity</dt>
              <dd data-slot="agent-badge-identity" className="font-mono">{identity}</dd>
            </>
          ) : null}
        </dl>
        {steps.length > 1 || steps.some((row) => row.others.length > 0) ? (
          <div data-slot="agent-badge-step-models" className="mt-3 border-t border-border pt-2">
            <p className="pb-1 text-meta text-muted-foreground">Models per step</p>
            <ul className="flex flex-col gap-0.5">
              {steps.map((row) => (
                <li key={row.stepId} data-step-id={row.stepId} className="flex min-w-0 gap-2">
                  <span className="shrink-0 text-muted-foreground">{row.name}</span>
                  <span className="min-w-0 break-all font-mono">
                    {row.actual}
                    {row.others.length > 0 ? (
                      <span className="text-muted-foreground">
                        {' + '}
                        {row.others.map((entry) => modelShare(entry, showTokens, showCost)).join(', ')}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
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

/** A side model with the first available share the cockpit is configured to show. */
function modelShare(entry: ModelUsage, showTokens: boolean, showCost: boolean): string {
  if (showCost && entry.costUsd !== undefined && entry.costUsd > 0) {
    return `${entry.model} (${formatCost(entry.costUsd)})`
  }
  const tokens = (entry.inputTokens ?? 0) + (entry.outputTokens ?? 0)
  return showTokens && tokens > 0 ? `${entry.model} (${compactTokens(tokens)} tokens)` : entry.model
}
