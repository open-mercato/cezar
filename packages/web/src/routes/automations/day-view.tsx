import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { useState } from 'react'
import { zonedParts, type AutomationsResponse } from '@open-mercato/cezar-api-client'

import { GithubIcon } from '@/components/icons'
import { PageBody } from '@/components/page'
import { StatusDot } from '@/components/status-dot'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { dayName, hm, statusTone, triggerLabel } from '@/lib/automation-format'
import { useNavigate } from '@/lib/project-router'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'

import { EventBlock, HOUR_H, HourGutter, HourLines, NowLine, PollBand, dayStart, minuteOf, occurrencesIn, stacked } from './calendar-parts'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/**
 * The Day calendar (spec 2026-09-14-automations-redesign § UI/UX 3, `design-05`): one day's
 * column with the wide block shape beside an agenda of the same runs. Opens on today in the
 * server zone; the arrows walk real calendar days, not the week's seven slots, so Sunday's
 * "next" is next Monday. A past agenda row wears the last run's tone — what happened — a future
 * one a neutral dot — what will.
 */
export function DayView({ data }: { data: AutomationsResponse }) {
  const now = useNow(60_000)
  const navigate = useNavigate()
  const [offset, setOffset] = useState(0)
  const timeZone = data.timeZone
  const start = dayStart(now, timeZone, offset)
  const end = dayStart(now, timeZone, offset + 1)
  const parts = start === null ? null : zonedParts(start, timeZone)
  const today = zonedParts(now, timeZone)
  if (start === null || end === null || !parts || !today) {
    return (
      <PageBody data-slot="day-view">
        <p className="rounded-xl border border-dashed p-10 text-center text-[13px] text-muted-foreground">
          Cannot draw the day: unknown time zone “{timeZone}”.
        </p>
      </PageBody>
    )
  }

  const isToday = offset === 0
  const events = stacked(occurrencesIn(data.automations, start, end, timeZone))
  const polls = data.automations.filter((automation) => automation.kind === 'github' && automation.enabled)
  const title = `${dayName(parts.weekday)} ${parts.day} ${MONTHS[parts.month - 1] ?? ''}`

  return (
    <PageBody data-slot="day-view" className="grid grid-cols-[minmax(0,1fr)_320px] items-start gap-6 max-lg:grid-cols-1">
      <div className="min-w-0 overflow-hidden rounded-xl border bg-card shadow-xs">
        <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2.5">
          <Button variant="ghost" size="icon-sm" aria-label="Previous day" onClick={() => setOffset((value) => value - 1)}>
            <ChevronLeftIcon aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Next day" onClick={() => setOffset((value) => value + 1)}>
            <ChevronRightIcon aria-hidden="true" />
          </Button>
          <span data-slot="day-title" className="text-[15px] font-semibold whitespace-nowrap">{title}</span>
          {isToday ? (
            <Badge variant="outline" className="gap-1.5 font-normal">
              <StatusDot tone="success" />
              Today
            </Badge>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setOffset(0)}>Today</Button>
          )}
          <span className="ml-auto text-[13px] whitespace-nowrap text-muted-foreground tabular-nums max-sm:hidden">
            {events.length} scheduled runs{polls.length ? ` · ${polls.length} GitHub poll${polls.length === 1 ? '' : 's'}` : ''}
          </span>
        </div>
        <PollBand automations={data.automations} />
        <div className="flex max-h-[calc(100dvh-22rem)] min-h-80 overflow-y-auto pt-2">
          <HourGutter />
          <div data-slot="day-column" data-today={isToday ? 'true' : undefined} className="relative flex-1 border-l border-border/60" style={{ height: 24 * HOUR_H }}>
            <HourLines />
            {isToday ? <NowLine minute={minuteOf(today)} /> : null}
            {events.map(({ occurrence, stack }) => (
              <EventBlock
                key={`${occurrence.automation.id}-${occurrence.at}`}
                automation={occurrence.automation}
                minute={minuteOf(occurrence.parts)}
                stack={stack}
                wide
              />
            ))}
          </div>
        </div>
      </div>
      <section data-slot="agenda" className="min-w-0">
        <h2 className="px-2 pb-2 text-[15px] font-semibold">Agenda</h2>
        {polls.map((automation) => (
          <Button
            key={automation.id}
            type="button"
            variant="ghost"
            data-slot="agenda-poll"
            onClick={() => navigate(`/automations/${encodeURIComponent(automation.id)}`)}
            className="grid h-auto w-full cursor-pointer grid-cols-[44px_1fr] items-start justify-normal gap-2.5 rounded-lg px-2 py-2 text-left font-normal whitespace-normal text-foreground hover:bg-muted/60 active:translate-y-0"
          >
            <span className="pt-px text-xs text-muted-foreground">Poll</span>
            <span className="min-w-0">
              <span className="flex items-center gap-2 text-[13.5px] font-medium">
                <GithubIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{automation.name}</span>
              </span>
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                {triggerLabel(automation)} · continuous
              </span>
            </span>
          </Button>
        ))}
        {events.map(({ occurrence }) => {
          const past = occurrence.at < now
          const { automation } = occurrence
          return (
            <Button
              key={`${automation.id}-${occurrence.at}`}
              type="button"
              variant="ghost"
              data-slot="agenda-row"
              data-past={past ? 'true' : 'false'}
              onClick={() => navigate(`/automations/${encodeURIComponent(automation.id)}`)}
              className="grid h-auto w-full cursor-pointer grid-cols-[44px_1fr] items-start justify-normal gap-2.5 rounded-lg px-2 py-2 text-left font-normal whitespace-normal text-foreground hover:bg-muted/60 active:translate-y-0"
            >
              <span className={cn('pt-px text-[13px] font-medium tabular-nums', past ? 'text-muted-foreground' : 'text-foreground')}>
                {hm(occurrence.parts.hour, occurrence.parts.minute)}
              </span>
              <span className="min-w-0">
                <span className={cn('flex items-center gap-2 text-[13.5px] font-medium', past && 'text-muted-foreground')}>
                  <StatusDot tone={past && automation.lastRun ? statusTone(automation.lastRun.status) : 'neutral'} />
                  <span className="truncate">{automation.name}</span>
                </span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {automation.task.prompt}
                </span>
              </span>
            </Button>
          )
        })}
        {events.length === 0 ? (
          <p className="px-2 py-2 text-[13px] text-muted-foreground">
            {polls.length ? 'Nothing scheduled — the GitHub polls above still run.' : 'Nothing scheduled.'}
          </p>
        ) : null}
      </section>
    </PageBody>
  )
}
