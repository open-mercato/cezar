import { CalendarClockIcon } from 'lucide-react'
import { occurrencesBetween, zonedParts, type AutomationListEntry } from '@open-mercato/cezar-api-client'

import { StatusDot } from '@/components/status-dot'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { dayName, hm, relativeIn } from '@/lib/automation-format'
import { useNavigate } from '@/lib/project-router'

/**
 * The "Next runs" rail (spec 2026-09-14-automations-redesign § UI/UX 1, `design-02`): a right
 * sheet listing the next twelve occurrences across every ENABLED schedule automation, computed
 * client-side from the same occurrence math the timer runs, so the rail and the scheduler never
 * disagree. GitHub polls have no instants to list; the footer counts them instead.
 */

export interface NextRun {
  automation: AutomationListEntry
  at: number
}

/** The next `limit` occurrences within 14 days across enabled schedule automations, soonest first. */
export function nextRuns(
  automations: readonly AutomationListEntry[],
  now: number,
  timeZone: string,
  limit = 12,
): NextRun[] {
  const out: NextRun[] = []
  for (const automation of automations) {
    if (!automation.enabled || automation.kind !== 'schedule' || !automation.schedule) continue
    for (const at of occurrencesBetween(automation.schedule, now, now + 14 * 86_400_000, timeZone, limit)) {
      out.push({ automation, at })
    }
  }
  return out.sort((a, b) => a.at - b.at).slice(0, limit)
}

export function NextRunsRail({
  open,
  onOpenChange,
  upcoming,
  pollCount,
  timeZone,
  now,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  upcoming: readonly NextRun[]
  /** Enabled GitHub automations — the polls that run continuously. */
  pollCount: number
  timeZone: string
  now: number
}) {
  const navigate = useNavigate()
  const today = zonedParts(now, timeZone)
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        data-slot="next-runs-rail"
        aria-describedby={undefined}
        className="w-[360px] gap-0 sm:max-w-[360px]"
      >
        <SheetHeader className="px-4 pt-4 pb-2">
          <SheetTitle className="inline-flex items-center gap-2 text-sm">
            <CalendarClockIcon className="size-4" />
            Next runs
          </SheetTitle>
          <SheetDescription className="sr-only">Upcoming scheduled runs, soonest first.</SheetDescription>
        </SheetHeader>
        <div className="overflow-y-auto">
          {upcoming.map((run, index) => {
            const parts = zonedParts(run.at, timeZone)
            const isToday =
              parts !== null && today !== null && parts.year === today.year && parts.month === today.month && parts.day === today.day
            const time = parts ? `${isToday ? '' : `${dayName(parts.weekday)} `}${hm(parts.hour, parts.minute)}` : ''
            return (
              <button
                key={`${run.automation.id}-${index}`}
                type="button"
                data-slot="next-run-row"
                data-automation={run.automation.id}
                onClick={() => {
                  onOpenChange(false)
                  navigate(`/automations/${encodeURIComponent(run.automation.id)}`)
                }}
                className="grid w-full cursor-pointer grid-cols-[76px_1fr_auto] items-center gap-2 px-4 py-2 text-left text-[13px] hover:bg-muted"
              >
                <span className="font-mono text-xs font-medium whitespace-nowrap text-muted-foreground tabular-nums">{time}</span>
                <span className="overflow-hidden text-[13px] font-medium text-ellipsis whitespace-nowrap">{run.automation.name}</span>
                <span className="text-[11px] whitespace-nowrap text-soft-foreground">{relativeIn(run.at, now)}</span>
              </button>
            )
          })}
          {upcoming.length === 0 ? (
            <p className="px-4 py-2 text-[12.5px] text-soft-foreground">No scheduled runs in the next two weeks.</p>
          ) : null}
          <div
            data-slot="next-runs-footer"
            className="mt-1.5 flex items-center gap-2 border-t border-border px-3.5 pt-2.5 pb-1 text-xs text-muted-foreground"
          >
            <StatusDot tone="pending" pulse />
            {pollCount} GitHub polls running continuously
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
