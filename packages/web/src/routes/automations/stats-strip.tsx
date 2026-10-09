import { Clock3Icon } from 'lucide-react'
import type { AutomationStats } from '@open-mercato/cezar-api-client'

import { StatusDot } from '@/components/status-dot'
import { agentTime, timeOnly, usd, AUTOMATION_COST_VISIBLE } from '@/lib/automation-format'
import { cn } from '@/lib/utils'

import type { NextRun } from './next-runs-rail'

/**
 * The list's "This week" strip (spec 2026-09-14-automations-redesign § UI/UX 1): four figures
 * from `stats` — spend only when the server reports cost at all — the continuous-poll count,
 * then the very next run. The button that opens the rail lives in the page toolbar.
 */
export function StatsStrip({
  stats,
  pollCount,
  upcoming,
  timeZone,
}: {
  stats: AutomationStats
  /** Enabled GitHub automations. */
  pollCount: number
  upcoming: readonly NextRun[]
  timeZone: string
}) {
  const next = upcoming[0]
  return (
    <div data-slot="stats-strip" className="flex flex-wrap items-center gap-x-5 gap-y-2 px-1 text-[13px] text-muted-foreground">
      <span className="font-medium text-foreground">This week</span>
      <Stat label="runs" value={String(stats.runs)} />
      {AUTOMATION_COST_VISIBLE && stats.costUsd !== undefined ? <Stat label="spent" value={usd(stats.costUsd)} /> : null}
      <Stat label="failed" value={String(stats.failed)} danger={stats.failed > 0} />
      <Stat label="agent time" value={agentTime(stats.agentSeconds)} />
      <span data-slot="stats-polls" className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap">
        <StatusDot tone="pending" pulse />
        {pollCount} GitHub polls continuous
      </span>
      <span data-slot="stats-next" className="ml-auto inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap">
        <Clock3Icon aria-hidden="true" className="size-3.5" />
        Next{' '}
        <b className="font-medium text-foreground tabular-nums">{next ? timeOnly(next.at, timeZone) : '—'}</b>{' '}
        <span className="max-w-[180px] truncate">{next?.automation.name ?? ''}</span>
      </span>
    </div>
  )
}

function Stat({ label, value, danger = false }: { label: string; value: string; danger?: boolean }) {
  return (
    <span data-slot="stat" data-label={label} className="inline-flex shrink-0 items-baseline gap-1.5 whitespace-nowrap">
      <b className={cn('font-semibold tabular-nums', danger ? 'text-danger' : 'text-foreground')}>{value}</b>
      {label}
    </span>
  )
}
