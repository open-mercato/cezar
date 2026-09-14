import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { useState } from 'react'
import { zonedParts, type AutomationsResponse } from '@open-mercato/cezar-api-client'

import { GithubIcon } from '@/components/icons'
import { Pill } from '@/components/pill'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
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
      <div data-slot="day-view" className="p-5">
        <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          Cannot draw the day: unknown time zone “{timeZone}”.
        </p>
      </div>
    )
  }

  const isToday = offset === 0
  const events = stacked(occurrencesIn(data.automations, start, end, timeZone))
  const polls = data.automations.filter((automation) => automation.kind === 'github' && automation.enabled)
  const title = `${dayName(parts.weekday)} ${parts.day} ${MONTHS[parts.month - 1] ?? ''}`

  return (
    <div data-slot="day-view" className="grid grid-cols-[minmax(0,1fr)_320px] items-start gap-4 p-5 max-md:grid-cols-1">
      <Card flush>
        <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
          <Button variant="ghost" size="icon-sm" aria-label="Previous day" onClick={() => setOffset((value) => value - 1)}>
            <ChevronLeftIcon className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Next day" onClick={() => setOffset((value) => value + 1)}>
            <ChevronRightIcon className="size-3.5" />
          </Button>
          <span data-slot="day-title" className="text-sm font-semibold whitespace-nowrap">{title}</span>
          {isToday ? <Pill dot="success">today</Pill> : null}
          <span className="ml-auto text-xs whitespace-nowrap text-muted-foreground">
            {events.length} scheduled runs{polls.length ? ` · ${polls.length} GitHub poll${polls.length === 1 ? '' : 's'}` : ''}
          </span>
        </div>
        <PollBand automations={data.automations} />
        <div className="flex max-h-[600px] overflow-y-auto">
          <HourGutter />
          <div data-slot="day-column" data-today={isToday ? 'true' : undefined} className="relative flex-1 border-l border-border" style={{ height: 24 * HOUR_H }}>
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
      </Card>
      <Card flush data-slot="agenda" className="py-3">
        <div className="px-3.5 pb-2 text-[11px] font-semibold tracking-[.05em] text-soft-foreground uppercase">Agenda</div>
        {polls.map((automation) => (
          <button
            key={automation.id}
            type="button"
            data-slot="agenda-poll"
            onClick={() => navigate(`/automations/${encodeURIComponent(automation.id)}`)}
            className="grid w-full cursor-pointer grid-cols-[48px_1fr] gap-2.5 px-3.5 py-2 text-left hover:bg-muted"
          >
            <span className="font-mono text-[10.5px] font-medium text-soft-foreground">poll</span>
            <span className="min-w-0">
              <span className="flex items-center gap-2 text-[13px] font-medium">
                <GithubIcon className="size-3 shrink-0 text-violet" />
                <span className="overflow-hidden text-ellipsis whitespace-nowrap">{automation.name}</span>
              </span>
              <span className="mt-0.5 block overflow-hidden font-mono text-[11.5px] leading-[1.4] text-ellipsis whitespace-nowrap text-soft-foreground">
                {triggerLabel(automation)} · continuous
              </span>
            </span>
          </button>
        ))}
        {events.map(({ occurrence }) => {
          const past = occurrence.at < now
          const { automation } = occurrence
          return (
            <button
              key={`${automation.id}-${occurrence.at}`}
              type="button"
              data-slot="agenda-row"
              data-past={past ? 'true' : 'false'}
              onClick={() => navigate(`/automations/${encodeURIComponent(automation.id)}`)}
              className="grid w-full cursor-pointer grid-cols-[48px_1fr] gap-2.5 px-3.5 py-2 text-left hover:bg-muted"
            >
              <span className={cn('font-mono text-xs font-medium tabular-nums', past ? 'text-soft-foreground' : 'text-foreground')}>
                {hm(occurrence.parts.hour, occurrence.parts.minute)}
              </span>
              <span className="min-w-0">
                <span className={cn('flex items-center gap-2 text-[13px] font-medium', past && 'text-muted-foreground')}>
                  <StatusDot tone={past && automation.lastRun ? statusTone(automation.lastRun.status) : 'neutral'} />
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap">{automation.name}</span>
                </span>
                <span className="mt-0.5 block overflow-hidden text-[11.5px] leading-[1.4] text-ellipsis whitespace-nowrap text-soft-foreground">
                  {automation.task.prompt}
                </span>
              </span>
            </button>
          )
        })}
        {events.length === 0 ? (
          <p className="px-3.5 py-2 text-[12.5px] text-soft-foreground">
            {polls.length ? 'Nothing scheduled — the GitHub polls above still run.' : 'Nothing scheduled.'}
          </p>
        ) : null}
      </Card>
    </div>
  )
}
