import {
  SCHEDULE_HOURS_OPTIONS,
  WEEKDAY_NAMES,
  cronOf,
  normalizeSchedule,
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
]

const pad = (n: number): string => String(n).padStart(2, '0')

/**
 * The "On a schedule" half of the When section (spec 2026-09-14-automations-redesign § UI/UX 4.3):
 * the shape chips, the weekday chips for `weekly`, the "every N h" select for `hours`, the HH:MM
 * row for the rest, and the derived cron string — never stored, only shown.
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
  const set = (patch: Partial<AutomationSchedule>) => onChange({ ...s, ...patch })
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
      <div className="flex items-center gap-2.5 font-mono text-xs text-soft-foreground">
        <span>cron</span>
        <BranchChip data-slot="editor-cron">{cronOf(s)}</BranchChip>
      </div>
    </div>
  )
}
