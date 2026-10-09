import { zonedParts, type AutomationsResponse } from '@open-mercato/cezar-api-client'

import { PageBody } from '@/components/page'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'

import { EventBlock, HOUR_H, HourGutter, HourLines, NowLine, PollBand, dayStart, minuteOf, occurrencesIn, stacked } from './calendar-parts'

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

/**
 * The Week calendar (spec 2026-09-14-automations-redesign § UI/UX 2, `design-04`): this week,
 * Monday to Sunday in the server zone, every schedule definition's occurrences as blocks —
 * paused ones at half opacity — the enabled GitHub polls as a band above the grid (they have no
 * instants, they run all week), and the current minute drawn through today's column. `now` is
 * re-read every minute so the line keeps moving without a data change.
 */
export function WeekView({ data }: { data: AutomationsResponse }) {
  const now = useNow(60_000)
  const timeZone = data.timeZone
  const today = zonedParts(now, timeZone)
  // Eight midnights: the seven day starts and the boundary after Sunday.
  const bounds = today
    ? Array.from({ length: 8 }, (_, index) => dayStart(now, timeZone, index - (today.weekday - 1)))
    : []
  const weekStart = bounds[0]
  const weekEnd = bounds[7]
  if (!today || weekStart === undefined || weekStart === null || weekEnd === undefined || weekEnd === null) {
    return (
      <PageBody data-slot="week-view">
        <p className="rounded-xl border border-dashed p-10 text-center text-[13px] text-muted-foreground">
          Cannot draw the week: unknown time zone “{timeZone}”.
        </p>
      </PageBody>
    )
  }

  const todayColumn = today.weekday - 1
  const occurrences = occurrencesIn(data.automations, weekStart, weekEnd, timeZone)
  const columns = DAYS.map((label, index) => {
    const start = bounds[index]
    const dayOfMonth = start === undefined || start === null ? null : zonedParts(start, timeZone)?.day ?? null
    return {
      label,
      dayOfMonth,
      isToday: index === todayColumn,
      blocks: stacked(occurrences.filter((occurrence) => occurrence.parts.weekday - 1 === index)),
    }
  })

  return (
    <PageBody data-slot="week-view">
      <div className="min-w-0 overflow-x-auto rounded-xl border bg-card shadow-xs">
       <div className="min-w-[720px]">
        <div className="grid grid-cols-[56px_repeat(7,minmax(0,1fr))] border-b border-border/60">
          <div />
          {columns.map((column) => (
            <div
              key={column.label}
              data-slot="week-day-header"
              data-today={column.isToday ? 'true' : undefined}
              className={cn(
                'flex items-center gap-1.5 border-l border-border/60 px-2.5 py-2.5 text-xs font-medium',
                column.isToday ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              {column.label}
              <span
                className={cn(
                  'rounded-full px-1.5 py-px text-[13px] font-medium tabular-nums',
                  column.isToday ? 'bg-primary text-primary-foreground' : 'text-foreground',
                )}
              >
                {column.dayOfMonth ?? ''}
              </span>
            </div>
          ))}
        </div>
        <PollBand automations={data.automations} />
        <div className="flex max-h-[calc(100dvh-22rem)] min-h-80 overflow-y-auto pt-2">
          <HourGutter />
          {columns.map((column) => (
            <div
              key={column.label}
              data-slot="week-column"
              data-today={column.isToday ? 'true' : undefined}
              className={cn('relative min-w-0 flex-1 border-l border-border/60', column.isToday && 'bg-muted/40')}
              style={{ height: 24 * HOUR_H }}
            >
              <HourLines />
              {column.isToday ? <NowLine minute={minuteOf(today)} /> : null}
              {column.blocks.map(({ occurrence, stack }) => (
                <EventBlock
                  key={`${occurrence.automation.id}-${occurrence.at}`}
                  automation={occurrence.automation}
                  minute={minuteOf(occurrence.parts)}
                  stack={stack}
                />
              ))}
            </div>
          ))}
        </div>
       </div>
      </div>
    </PageBody>
  )
}
