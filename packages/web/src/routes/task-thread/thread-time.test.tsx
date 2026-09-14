import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import {
  DaySeparator,
  MessageTime,
  TurnTime,
  clockLabel,
  dayLabel,
  exactLabel,
  localDayKey,
  turnDuration,
} from './thread-time'

/**
 * The thread's clock (#941).
 *
 * Assertions avoid pinning the reader's locale: the labels go through `Intl` with an undefined
 * locale on purpose, so what is asserted here is the SHAPE (a time is present, a day key is the
 * local calendar date, a duration reads the way the issue specifies) and the machine-readable
 * `dateTime` attribute — never the exact en-US spelling of a month.
 *
 * Local stamps are built as `new Date(y, m, d, …).toISOString()` rather than written as UTC
 * literals, so a suite running in any timezone still asserts the same local day.
 */

afterEach(cleanup)

const localIso = (
  year: number,
  month: number,
  day: number,
  hour = 12,
  minute = 0,
): string => new Date(year, month - 1, day, hour, minute).toISOString()

const GARBAGE = ['', 'not a date', undefined]

describe('thread-time formatters', () => {
  it('formats a short local time and a full instant for the tooltip', () => {
    const ts = localIso(2026, 8, 30, 14, 32)
    expect(clockLabel(ts)).toMatch(/\b\d{1,2}:32\b/)
    // The tooltip carries the date too — that is the whole reason it exists.
    expect(exactLabel(ts)).toContain('2026')
    expect(exactLabel(ts)).not.toBe(clockLabel(ts))
  })

  it.each(GARBAGE)('renders nothing rather than Invalid Date for %o', (ts) => {
    expect(clockLabel(ts)).toBeUndefined()
    expect(exactLabel(ts)).toBeUndefined()
    expect(localDayKey(ts)).toBeUndefined()
    expect(dayLabel(ts)).toBeUndefined()
    expect(turnDuration(ts, ts)).toBeUndefined()
  })

  it('keys a stamp by its LOCAL calendar day', () => {
    // 23:30 local belongs to that evening, whatever UTC says about it.
    expect(localDayKey(localIso(2026, 8, 30, 23, 30))).toBe('2026-08-30')
    expect(localDayKey(localIso(2026, 1, 5, 0, 15))).toBe('2026-01-05')
  })

  it('names today and yesterday, and dates anything older', () => {
    const now = new Date(2026, 7, 30, 18, 0)
    expect(dayLabel(localIso(2026, 8, 30, 9, 0), now)).toBe('Today')
    expect(dayLabel(localIso(2026, 8, 29, 23, 59), now)).toBe('Yesterday')
    const older = dayLabel(localIso(2026, 8, 24, 9, 0), now)
    expect(older).toContain('24')
    expect(older).not.toMatch(/Today|Yesterday/)
    // Crossing a month boundary backwards is still just "yesterday".
    expect(dayLabel(localIso(2026, 7, 31, 20, 0), new Date(2026, 7, 1, 9, 0))).toBe('Yesterday')
  })

  it('names the year once the day is not in the current one', () => {
    const now = new Date(2026, 7, 30, 18, 0)
    expect(dayLabel(localIso(2025, 12, 30, 9, 0), now)).toContain('2025')
    expect(dayLabel(localIso(2026, 1, 2, 9, 0), now)).not.toContain('2025')
  })

  it.each([
    [0, '0s'],
    [12_000, '12s'],
    [59_400, '59s'],
    [252_000, '4m 12s'],
    [3_840_000, '1h 04m'],
    [86_400_000, '24h 00m'],
  ])('formats %ims as %s', (ms, expected) => {
    const start = localIso(2026, 8, 30, 9, 0)
    const end = new Date(new Date(start).getTime() + ms).toISOString()
    expect(turnDuration(start, end)).toBe(expected)
  })

  it('omits the duration when a stamp is missing or the clocks disagree', () => {
    const start = localIso(2026, 8, 30, 9, 0)
    const end = localIso(2026, 8, 30, 9, 5)
    expect(turnDuration(undefined, end)).toBeUndefined()
    expect(turnDuration(start, undefined)).toBeUndefined()
    // Backwards is never rendered as a negative "replied in".
    expect(turnDuration(end, start)).toBeUndefined()
  })
})

describe('thread-time components', () => {
  it('renders the user bubble stamp as a machine-readable time with the exact instant on hover', () => {
    const ts = localIso(2026, 8, 30, 14, 32)
    render(<MessageTime ts={ts} />)
    const time = document.querySelector('[data-slot="message-time"]')!
    expect(time.getAttribute('datetime')).toBe(ts)
    expect(time.getAttribute('title')).toBe(exactLabel(ts))
    expect(time.textContent).toBe(clockLabel(ts))
  })

  it('renders nothing at all for an unusable stamp', () => {
    render(<MessageTime ts="nonsense" />)
    expect(document.querySelector('[data-slot="message-time"]')).toBeNull()
    cleanup()
    render(<TurnTime completedAt="nonsense" startedAt="nonsense" />)
    expect(document.querySelector('[data-slot="turn-time"]')).toBeNull()
    cleanup()
    render(<DaySeparator ts="nonsense" />)
    expect(document.querySelector('[data-slot="day-separator"]')).toBeNull()
  })

  it('closes a turn with its completion time and duration', () => {
    const startedAt = localIso(2026, 8, 30, 14, 32)
    const completedAt = new Date(new Date(startedAt).getTime() + 252_000).toISOString()
    render(<TurnTime startedAt={startedAt} completedAt={completedAt} />)
    const row = document.querySelector('[data-slot="turn-time"]')!
    expect(row.querySelector('time')?.getAttribute('datetime')).toBe(completedAt)
    expect(row.textContent).toContain('· 4m 12s')
  })

  it('shows the completion time alone when the turn has no known start', () => {
    const completedAt = localIso(2026, 8, 30, 14, 36)
    render(<TurnTime completedAt={completedAt} />)
    const row = document.querySelector('[data-slot="turn-time"]')!
    expect(row.textContent).toBe(clockLabel(completedAt))
  })

  it('labels a day separator with the local date, machine-readable', () => {
    const ts = localIso(2026, 8, 24, 9, 0)
    render(<DaySeparator ts={ts} />)
    const time = document.querySelector('[data-slot="day-separator"] time')!
    expect(time.getAttribute('datetime')).toBe('2026-08-24')
    expect(time.textContent).toBe(dayLabel(ts))
  })

  /**
   * The rules either side are `aria-hidden` and a non-focusable `separator` takes no name from its
   * content, so without an explicit label the day change would reach sighted readers only.
   */
  it('announces the day change, keeping the relative word in front of the full date', () => {
    const dated = localIso(2026, 8, 24, 9, 0)
    render(<DaySeparator ts={dated} />)
    const row = () => document.querySelector('[data-slot="day-separator"]')!
    expect(row().getAttribute('role')).toBe('separator')
    // Its own label already carries the date, so the name is the unabbreviated one, not both.
    expect(row().getAttribute('aria-label')).toContain('2026')
    expect(row().getAttribute('aria-label')).not.toContain(dayLabel(dated)!)

    cleanup()
    const now = new Date()
    render(<DaySeparator ts={new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9).toISOString()} />)
    // "Today" is the anchor a returning reader wants; the date follows so it is not just relative.
    expect(row().getAttribute('aria-label')).toContain('Today, ')
    expect(row().getAttribute('aria-label')).toContain(String(now.getFullYear()))
  })
})
