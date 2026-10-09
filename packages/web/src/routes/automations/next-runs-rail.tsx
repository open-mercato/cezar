import { CalendarClockIcon } from 'lucide-react'
import { occurrencesBetween, zonedParts, type AutomationListEntry } from '@open-mercato/cezar-api-client'

import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
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
        className="w-[380px] gap-0 sm:max-w-[380px]"
      >
        <SheetHeader className="px-5 pt-5 pb-3">
          <SheetTitle className="inline-flex items-center gap-2 text-[15px]">
            <CalendarClockIcon className="size-4 text-muted-foreground" />
            Next runs
          </SheetTitle>
          <SheetDescription className="text-[13px]">Upcoming scheduled runs, soonest first.</SheetDescription>
        </SheetHeader>
        <div className="overflow-y-auto">
          {upcoming.map((run, index) => {
            const parts = zonedParts(run.at, timeZone)
            const isToday =
              parts !== null && today !== null && parts.year === today.year && parts.month === today.month && parts.day === today.day
            const time = parts ? `${isToday ? '' : `${dayName(parts.weekday)} `}${hm(parts.hour, parts.minute)}` : ''
            return (
              <Button
                key={`${run.automation.id}-${index}`}
                type="button"
                variant="ghost"
                data-slot="next-run-row"
                data-automation={run.automation.id}
                onClick={() => {
                  onOpenChange(false)
                  navigate(`/automations/${encodeURIComponent(run.automation.id)}`)
                }}
                className="grid h-auto min-h-11 w-full cursor-pointer grid-cols-[76px_1fr_auto] items-center justify-normal gap-2 rounded-none px-5 py-2 text-left text-[13px] font-normal text-foreground hover:bg-muted/60 active:translate-y-0"
              >
                <span className="text-[13px] whitespace-nowrap text-muted-foreground tabular-nums">{time}</span>
                <span className="truncate text-[13.5px] font-medium">{run.automation.name}</span>
                <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">{relativeIn(run.at, now)}</span>
              </Button>
            )
          })}
          {upcoming.length === 0 ? (
            <p className="px-5 py-2 text-[13px] text-muted-foreground">No scheduled runs in the next two weeks.</p>
          ) : null}
          <div
            data-slot="next-runs-footer"
            className="mt-2 flex items-center gap-2 border-t border-border px-5 pt-3 pb-2 text-[13px] text-muted-foreground"
          >
            <StatusDot tone="pending" pulse />
            {pollCount} GitHub polls running continuously
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
