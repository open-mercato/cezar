import { cn } from '@/lib/utils'

/**
 * The thread's clock (#941): the small, always-visible time on a conversation turn, the day
 * separators between turns, and the turn duration.
 *
 * Everything here is derived from stamps that were already persisted (`ts` on every run event,
 * `createdAt` on the run and on queued messages) — this module adds no state and no storage.
 *
 * Three rules it exists to keep in one place:
 *
 *  - **Absolute, not relative.** A short local time (`14:32`) inline, the full instant in the
 *    `title`. Nothing ticks, so no row re-renders on a timer and no row changes height between
 *    virtua's measure and its paint.
 *  - **Local, not UTC.** Stamps are ISO/UTC on disk; the cockpit formats in the browser's zone
 *    like the rest of the UI, and day separators compare LOCAL dates for the same reason.
 *  - **Total.** A missing or unparseable stamp renders nothing at all. Old transcripts are hand-
 *    editable files, and a thread must never print `Invalid Date` beside a message.
 */

/** One formatter per shape, built once: hundreds of thread rows format on every paint. */
const CLOCK = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const EXACT = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' })
const DAY = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
const DAY_WITH_YEAR = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
})
const FULL_DAY = new Intl.DateTimeFormat(undefined, { dateStyle: 'full' })

/** The one gate every export goes through: a `Date` worth formatting, or nothing. */
function parse(ts: string | undefined): Date | undefined {
  if (typeof ts !== 'string' || ts === '') return undefined
  const at = new Date(ts)
  return Number.isFinite(at.getTime()) ? at : undefined
}

/** Short local time for an inline stamp — `14:32` / `2:32 PM`, per the reader's locale. */
export function clockLabel(ts: string | undefined): string | undefined {
  const at = parse(ts)
  return at === undefined ? undefined : CLOCK.format(at)
}

/** The full instant, for the `title` the inline time hides behind. */
export function exactLabel(ts: string | undefined): string | undefined {
  const at = parse(ts)
  return at === undefined ? undefined : EXACT.format(at)
}

const keyOf = (at: Date): string =>
  `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`

/**
 * The LOCAL calendar day of a stamp, as `YYYY-MM-DD` — the comparison key that decides where a
 * day separator goes. Local rather than UTC: a message sent at 23:30 in the reader's own evening
 * belongs to that evening, not to tomorrow.
 */
export function localDayKey(ts: string | undefined): string | undefined {
  const at = parse(ts)
  return at === undefined ? undefined : keyOf(at)
}

/**
 * What a separator row says. "Today"/"Yesterday" carry the anchor a returning reader actually
 * wants; anything older gets a weekday + date, with the year once it is not this one.
 *
 * `now` is injected (defaulted, as `scheduledResume` does) so the label is a pure function of
 * its inputs in tests.
 */
export function dayLabel(ts: string | undefined, now: Date = new Date()): string | undefined {
  const at = parse(ts)
  if (at === undefined) return undefined
  const key = keyOf(at)
  if (key === keyOf(now)) return 'Today'
  if (key === keyOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return 'Yesterday'
  return (at.getFullYear() === now.getFullYear() ? DAY : DAY_WITH_YEAR).format(at)
}

/**
 * How long the turn took — `12s` / `4m 12s` / `1h 04m`. Undefined when either end is unknown, and
 * also when the stamps run backwards: two machines' clocks, or a hand-edited file, must not
 * produce a negative "replied in".
 */
export function turnDuration(startedAt: string | undefined, completedAt: string | undefined): string | undefined {
  const start = parse(startedAt)
  const end = parse(completedAt)
  if (start === undefined || end === undefined) return undefined
  const seconds = Math.round((end.getTime() - start.getTime()) / 1000)
  if (seconds < 0) return undefined
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** The stamp on a user bubble: short local time, exact instant on hover. */
export function MessageTime({ ts, className }: { ts: string; className?: string }) {
  const label = clockLabel(ts)
  if (label === undefined) return null
  return (
    <time
      data-slot="message-time"
      dateTime={ts}
      title={exactLabel(ts)}
      className={cn('text-[11px] leading-none text-soft-foreground', className)}
    >
      {label}
    </time>
  )
}

/**
 * The closing stamp of an agent turn — `14:36 · 4m 12s`. Rendered only once `turn.completed`
 * has landed: a live turn shows nothing rather than a running clock or a placeholder that would
 * jump when it fills in.
 */
export function TurnTime({ startedAt, completedAt }: { startedAt?: string; completedAt: string }) {
  const label = clockLabel(completedAt)
  if (label === undefined) return null
  const duration = turnDuration(startedAt, completedAt)
  return (
    <div
      data-slot="turn-time"
      className="flex items-center gap-1.5 px-0.5 text-[11px] leading-none text-soft-foreground"
    >
      <time dateTime={completedAt} title={exactLabel(completedAt)}>
        {label}
      </time>
      {duration !== undefined ? <span title={`Replied in ${duration}`}>· {duration}</span> : null}
    </div>
  )
}

/** The rule between two turns that fall on different local days. Its own thread row, so it
 *  measures like any other and never changes a neighbour's height. */
export function DaySeparator({ ts }: { ts: string }) {
  const label = dayLabel(ts)
  const at = parse(ts)
  if (label === undefined || at === undefined) return null
  return (
    <div
      data-slot="day-separator"
      className="flex items-center gap-3 py-1 text-[11px] font-medium text-soft-foreground"
    >
      <span aria-hidden className="h-px flex-1 bg-border" />
      <time dateTime={localDayKey(ts)} title={FULL_DAY.format(at)}>
        {label}
      </time>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  )
}
