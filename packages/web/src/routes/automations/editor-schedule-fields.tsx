import {
  SCHEDULE_HOURS_OPTIONS,
  WEEKDAY_NAMES,
  cronOf,
  nextOccurrence,
  normalizeSchedule,
  zonedParts,
  type AutomationSchedule,
  type ScheduleType,
} from '@open-mercato/cezar-api-client'

import { BranchChip } from '@/components/branch-chip'
import { Chip } from '@/components/chip'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

import { isScheduleEvery } from './editor-draft'

const TYPES: ReadonlyArray<[ScheduleType, string]> = [
  ['daily', 'Every day'],
  ['weekdays', 'Weekdays'],
  ['weekly', 'Weekly'],
  ['hours', 'Every N hours'],
  ['once', 'Once'],
]

const pad = (n: number): string => String(n).padStart(2, '0')

/** Tomorrow's calendar day in the zone, as `YYYY-MM-DD` — the default date of a new `once`. */
function tomorrowIn(timeZone: string): string {
  const tomorrow = Date.now() + 86_400_000
  const p = zonedParts(tomorrow, timeZone)
  return p ? `${p.year}-${pad(p.month)}-${pad(p.day)}` : new Date(tomorrow).toISOString().slice(0, 10)
}

/**
 * The "On a schedule" half of the When section (spec 2026-09-14-automations-redesign § UI/UX 4.3):
 * the shape chips, the weekday chips for `weekly`, the "every N h" select for `hours`, the HH:MM
 * row for the rest, and the derived cron string — never stored, only shown. `once` (#771) adds a
 * date picker, defaulting to tomorrow in the server's zone, and shows no cron: cron has no year.
 */
export function EditorScheduleFields({
  schedule,
  timeZone,
  onChange,
}: {
  schedule: AutomationSchedule
  /** The server's zone — what the schedule is evaluated in. */
  timeZone: string
  onChange: (schedule: AutomationSchedule) => void
}) {
  const s = normalizeSchedule(schedule)
  const set = (patch: Partial<AutomationSchedule>) => {
    const { date, ...rest } = s
    const next: AutomationSchedule = { ...rest, ...(date ? { date } : {}), ...patch }
    if (next.type === 'once' && !next.date) next.date = tomorrowIn(timeZone)
    onChange(next)
  }
  const passed = s.type === 'once' && s.date !== null
    && nextOccurrence({ type: 'once', date: s.date, hour: s.hour, minute: s.minute }, Date.now(), timeZone) === null
  return (
    <div data-slot="editor-schedule" className="flex flex-col gap-3.5">
      <div role="group" aria-label="Schedule type" className="flex flex-wrap gap-1.5">
        {TYPES.map(([value, label]) => (
          <Chip key={value} active={s.type === value} aria-pressed={s.type === value} onClick={() => set({ type: value })}>
            {label}
          </Chip>
        ))}
      </div>
      {s.type === 'weekly' ? (
        <div role="group" aria-label="Weekday" className="flex flex-wrap gap-1.5">
          {WEEKDAY_NAMES.map((name, index) => (
            <Chip
              key={name}
              active={s.day === index + 1}
              aria-pressed={s.day === index + 1}
              className="px-[9px]"
              onClick={() => set({ day: index + 1 })}
            >
              {name}
            </Chip>
          ))}
        </div>
      ) : null}
      {s.type === 'once' ? (
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          on
          <Input
            type="date"
            aria-label="Date"
            value={s.date ?? ''}
            onChange={(event) => { if (event.target.value) set({ date: event.target.value }) }}
            className="w-40 font-mono"
          />
        </div>
      ) : null}
      {s.type === 'hours' ? (
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          every
          <Select value={String(s.every)} onValueChange={(value) => { const every = Number(value); if (isScheduleEvery(every)) set({ every }) }}>
            <SelectTrigger size="sm" aria-label="Every N hours" className="text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCHEDULE_HOURS_OPTIONS.map((hours) => (
                <SelectItem key={hours} value={String(hours)}>{hours} h</SelectItem>
              ))}
            </SelectContent>
          </Select>
          starting at 00:00
        </div>
      ) : (
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          at
          <Input
            aria-label="Hour"
            inputMode="numeric"
            value={pad(s.hour)}
            onChange={(event) => set({ hour: Math.min(23, Math.max(0, Number(event.target.value) || 0)) })}
            className="w-14 text-center font-mono"
          />
          :
          <Input
            aria-label="Minute"
            inputMode="numeric"
            value={pad(s.minute)}
            onChange={(event) => set({ minute: Math.min(59, Math.max(0, Number(event.target.value) || 0)) })}
            className="w-14 text-center font-mono"
          />
          <span className="font-mono text-xs">{timeZone}</span>
        </div>
      )}
      {s.type === 'once' ? (
        <p data-slot="editor-once-note" className={`m-0 text-xs ${passed ? 'text-danger' : 'text-soft-foreground'}`}>
          {passed ? 'This time has passed — pick a later one to enable it.' : 'Runs a single time, then pauses itself.'}
        </p>
      ) : (
        <div className="flex items-center gap-2.5 font-mono text-xs text-soft-foreground">
          <span>cron</span>
          <BranchChip data-slot="editor-cron">{cronOf(schedule)}</BranchChip>
        </div>
      )}
    </div>
  )
}
