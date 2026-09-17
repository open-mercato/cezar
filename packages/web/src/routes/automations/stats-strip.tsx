import { CalendarClockIcon, Clock3Icon } from 'lucide-react'
import type { AutomationStats } from '@open-mercato/cezar-api-client'

import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { agentTime, timeOnly, usd, AUTOMATION_COST_VISIBLE } from '@/lib/automation-format'
import { cn } from '@/lib/utils'

import type { NextRun } from './next-runs-rail'

/**
 * The list's "This week" strip (spec 2026-09-14-automations-redesign § UI/UX 1): four figures
 * from `stats` — spend only when the server reports cost at all — the continuous-poll count,
 * then the very next run and the button that opens the rail.
 */
export function StatsStrip({
  stats,
  pollCount,
  upcoming,
  timeZone,
  railOpen,
  onOpenRail,
}: {
  stats: AutomationStats
  /** Enabled GitHub automations. */
  pollCount: number
  upcoming: readonly NextRun[]
  timeZone: string
  railOpen: boolean
  onOpenRail: () => void
}) {
  const next = upcoming[0]
  return (
    <div data-slot="stats-strip" className="flex flex-wrap items-center gap-4 text-[12.5px] text-muted-foreground">
      <span className="text-[11px] font-semibold tracking-[.05em] text-soft-foreground uppercase">This week</span>
      <Stat label="runs" value={String(stats.runs)} />
      {AUTOMATION_COST_VISIBLE && stats.costUsd !== undefined ? <Stat label="spent" value={usd(stats.costUsd)} /> : null}
      <Stat label="failed" value={String(stats.failed)} danger={stats.failed > 0} />
      <Stat label="agent time" value={agentTime(stats.agentSeconds)} />
      <span data-slot="stats-polls" className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap">
        <StatusDot tone="pending" pulse />
        {pollCount} GitHub polls continuous
      </span>
      <span className="flex-1" />
      <span data-slot="stats-next" className="inline-flex min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap">
        <Clock3Icon className="size-[13px] text-soft-foreground" />
        next{' '}
        <b className="font-mono text-[12.5px] font-medium text-foreground">{next ? timeOnly(next.at, timeZone) : '—'}</b>{' '}
        <span className="max-w-[180px] overflow-hidden text-ellipsis">{next?.automation.name ?? ''}</span>
      </span>
      <Button variant="outline" size="sm" aria-expanded={railOpen} className="shrink-0" onClick={onOpenRail}>
        <CalendarClockIcon className="size-3.5" />
        Next runs
        <span className="font-mono text-[11px] font-medium text-muted-foreground">{upcoming.length}</span>
      </Button>
    </div>
  )
}

function Stat({ label, value, danger = false }: { label: string; value: string; danger?: boolean }) {
  return (
    <span data-slot="stat" data-label={label} className="inline-flex shrink-0 items-baseline gap-[5px] whitespace-nowrap">
      <b className={cn('font-mono text-sm font-semibold tabular-nums', danger ? 'text-danger' : 'text-foreground')}>{value}</b>
      {label}
    </span>
  )
}
