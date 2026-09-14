import { PlayIcon, ScrollTextIcon } from 'lucide-react'

import type { AutomationLastRun } from '@open-mercato/cezar-api-client'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { statusLabel, statusTone, usd, AUTOMATION_COST_VISIBLE } from '@/lib/automation-format'
import { shortAge } from '@/lib/format'

/**
 * The edit screen's "Last run" card (spec 2026-09-14-automations-redesign § UI/UX 4): the newest
 * launch's state, age and cost, and the two things one does next — fire it again, or read the log.
 */
export function LastRunCard({
  lastRun,
  onRunNow,
  onLog,
  busy = false,
  now,
}: {
  lastRun: AutomationLastRun
  onRunNow: () => void
  onLog?: () => void
  busy?: boolean
  now?: number
}) {
  return (
    <Card flush data-slot="last-run-card" className="px-3.5 py-3">
      <div className="mb-2 text-[11px] font-semibold tracking-[.05em] uppercase text-soft-foreground">Last run</div>
      <div className="flex items-center gap-2 text-[13px]">
        <StatusDot tone={statusTone(lastRun.status)} />
        {statusLabel(lastRun.status)}
        <span className="text-[11.5px] text-soft-foreground">{shortAge(lastRun.ts, now)}</span>
        {AUTOMATION_COST_VISIBLE && lastRun.costUsd !== undefined ? (
          <span className="ml-auto font-mono text-xs text-muted-foreground">{usd(lastRun.costUsd)}</span>
        ) : null}
      </div>
      <div className="mt-2.5 flex gap-1.5">
        <Button variant="outline" size="sm" disabled={busy} onClick={onRunNow}>
          <PlayIcon aria-hidden="true" className="size-3" />
          Run now
        </Button>
        {onLog ? (
          <Button variant="ghost" size="sm" onClick={onLog}>
            <ScrollTextIcon aria-hidden="true" className="size-3" />
            View log
          </Button>
        ) : null}
      </div>
    </Card>
  )
}
