import { GithubIcon } from '@/components/icons'
import {
  occurrencesBetween,
  zonedParts,
  zonedWallTimeToUtc,
  type AutomationListEntry,
  type ZonedParts,
} from '@open-mercato/cezar-api-client'

import { StatusDot } from '@/components/status-dot'
import { hm, triggerLabel } from '@/lib/automation-format'
import { useNavigate } from '@/lib/project-router'
import { cn } from '@/lib/utils'

/**
 * The pieces the Week and Day calendars share (spec 2026-09-14-automations-redesign § UI/UX
 * 2–3, kit `EventBlock` / `HourGutter` / `NowLine`), plus the zone-aware day arithmetic both
 * views need. Every instant is placed by its wall time in the SERVER's zone — the one the
 * schedules fire in — so a block sits at the hour the timer will actually launch it.
 */

/** One hour row's height in px — `top = minute / 60 · HOUR_H` places an occurrence. */
export const HOUR_H = 34

/** Height of a block that stacks under another one at the same minute (`top + 26·k`). */
export const STACK_STEP = 26

/** A schedule automation firing at `at`, with its wall-clock parts in the zone. */
export interface CalendarOccurrence {
  automation: AutomationListEntry
  at: number
  parts: ZonedParts
}

/** Minute of the day (0–1439) an occurrence sits at. */
export function minuteOf(parts: Pick<ZonedParts, 'hour' | 'minute'>): number {
  return parts.hour * 60 + parts.minute
}

/**
 * Midnight in the zone of the calendar day `offsetDays` away from the one `now` falls on, as an
 * instant. `null` for an unknown zone. Walks days on the UTC calendar so month and year roll
 * over correctly; the zone only enters when the wall midnight is turned back into an instant.
 */
export function dayStart(now: number, timeZone: string, offsetDays = 0): number | null {
  const parts = zonedParts(now, timeZone)
  if (!parts) return null
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + offsetDays))
  return zonedWallTimeToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), 0, 0, timeZone)
}

/** Every schedule occurrence of every definition (paused ones too) in `[fromMs, toMs)`, ascending. */
export function occurrencesIn(
  automations: readonly AutomationListEntry[],
  fromMs: number,
  toMs: number,
  timeZone: string,
): CalendarOccurrence[] {
  const out: CalendarOccurrence[] = []
  for (const automation of automations) {
    if (automation.kind !== 'schedule' || !automation.schedule) continue
    for (const at of occurrencesBetween(automation.schedule, fromMs, toMs, timeZone)) {
      const parts = zonedParts(at, timeZone)
      if (parts) out.push({ automation, at, parts })
    }
  }
  return out.sort((a, b) => a.at - b.at)
}

/** Occurrences in one column with their stack index: the k-th block at the same minute sits `26·k` lower. */
export function stacked(occurrences: readonly CalendarOccurrence[]): Array<{ occurrence: CalendarOccurrence; stack: number }> {
  const seen = new Map<number, number>()
  return occurrences.map((occurrence) => {
    const minute = minuteOf(occurrence.parts)
    const stack = seen.get(minute) ?? 0
    seen.set(minute, stack + 1)
    return { occurrence, stack }
  })
}

/**
 * One scheduled run on the grid: a card at its minute, the runner's dot (codex → violet, else
 * success) and the name; the `wide` day-view shape adds a second mono line. Paused definitions
 * render at 50% so the week still shows what WOULD fire.
 */
export function EventBlock({
  automation,
  minute,
  stack = 0,
  wide = false,
}: {
  automation: AutomationListEntry
  /** Minute of the day in the server zone. */
  minute: number
  /** Position among same-minute blocks (0 = first). */
  stack?: number
  wide?: boolean
}) {
  const navigate = useNavigate()
  const time = hm(Math.floor(minute / 60), minute % 60)
  const runAs = [automation.task.workflow, automation.task.runner].filter(Boolean).join(' · ')
  return (
    <button
      type="button"
      data-slot="event-block"
      data-automation={automation.id}
      data-enabled={automation.enabled ? 'true' : 'false'}
      title={`${automation.name} · ${time}`}
      onClick={() => navigate(`/automations/${encodeURIComponent(automation.id)}`)}
      className={cn(
        'absolute right-[3px] left-[3px] flex cursor-pointer overflow-hidden rounded-[6px] border border-border bg-card text-left text-[11.5px] leading-[1.3] font-medium text-foreground shadow-xs',
        wide ? 'h-12 flex-col items-start gap-[3px] px-2 py-[5px]' : 'h-6 flex-row items-center gap-1.5 px-1.5',
        !automation.enabled && 'opacity-50',
      )}
      style={{ top: (minute / 60) * HOUR_H + 1 + STACK_STEP * stack }}
    >
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <StatusDot tone={automation.task.runner === 'codex' ? 'violet' : 'success'} />
        <span className="overflow-hidden text-ellipsis whitespace-nowrap">{automation.name}</span>
      </span>
      {wide ? (
        <span className="max-w-full overflow-hidden font-mono text-[10.5px] leading-[1.3] font-normal text-ellipsis whitespace-nowrap text-muted-foreground">
          {time}
          {runAs ? ` · ${runAs}` : ''}
        </span>
      ) : null}
    </button>
  )
}

/** The 48px hour column: `01:00` … `23:00`, midnight left blank, each label nudged up onto its line. */
export function HourGutter() {
  return (
    <div data-slot="hour-gutter" className="w-12 shrink-0">
      {Array.from({ length: 24 }, (_, hour) => (
        <div
          key={hour}
          className="-translate-y-[6px] pr-2 text-right font-mono text-[10.5px] text-soft-foreground"
          style={{ height: HOUR_H }}
        >
          {hour ? hm(hour) : ''}
        </div>
      ))}
    </div>
  )
}

/** The current minute, as a 2px primary rule with an 8px dot at its left end. */
export function NowLine({ minute }: { minute: number }) {
  return (
    <div
      aria-hidden="true"
      data-slot="now-line"
      className="absolute inset-x-0 z-[2] h-[2px] bg-primary"
      style={{ top: (minute / 60) * HOUR_H }}
    >
      <span className="absolute -top-[3px] -left-[3px] size-[8px] rounded-full bg-primary" />
    </div>
  )
}

/** The 24 hour rules of one column. */
export function HourLines() {
  return (
    <>
      {Array.from({ length: 24 }, (_, hour) => (
        <div key={hour} aria-hidden="true" className="absolute inset-x-0 h-px bg-border" style={{ top: hour * HOUR_H }} />
      ))}
    </>
  )
}

/**
 * The continuous GitHub polls, as a band above the hour grid (spec 2026-09-14 § UI/UX 2, and
 * on the Day view too — a poll has no hour to sit at, but it IS running that day). One row per
 * ENABLED poll; nothing at all when there is none.
 */
export function PollBand({ automations }: { automations: readonly AutomationListEntry[] }) {
  const polls = automations.filter((automation) => automation.kind === 'github' && automation.enabled)
  if (!polls.length) return null
  return (
    <div data-slot="poll-band" className="grid grid-cols-[48px_minmax(0,1fr)] border-b border-border">
      <div className="py-2 pr-2 text-right font-mono text-[10.5px] text-soft-foreground">poll</div>
      <div className="flex flex-col gap-1 border-l border-border px-2 py-1.5">
        {polls.map((automation) => (
          <div
            key={automation.id}
            data-slot="poll-row"
            className="flex h-[22px] min-w-0 items-center gap-2 overflow-hidden rounded-[6px] border border-violet/25 bg-violet/8 px-2 text-[11.5px] font-medium"
          >
            <GithubIcon className="size-3 shrink-0 text-violet" />
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">{automation.name}</span>
            <span className="overflow-hidden font-mono text-[10.5px] font-normal text-ellipsis whitespace-nowrap text-muted-foreground">
              {triggerLabel(automation)}
            </span>
            <span className="ml-auto shrink-0 font-mono text-[10.5px] font-normal whitespace-nowrap text-soft-foreground">
              {automation.runs7d} runs
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
