import { act, cleanup, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AUTOMATIONS, NIGHTLY, NOW, STALE_PR, TRIAGE, response } from './automations-list.fixtures'
import { HOUR_H } from './calendar-parts'
import { WeekView } from './week-view'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function renderWeek(data = response()) {
  render(
    <MemoryRouter initialEntries={['/automations?view=week']}>
      <WeekView data={data} />
    </MemoryRouter>,
  )
}

const columns = () => Array.from(document.querySelectorAll<HTMLElement>('[data-slot="week-column"]'))
const headers = () => Array.from(document.querySelectorAll<HTMLElement>('[data-slot="week-day-header"]'))
const blocksIn = (column: HTMLElement, id?: string) =>
  Array.from(column.querySelectorAll<HTMLElement>(id ? `[data-slot="event-block"][data-automation="${id}"]` : '[data-slot="event-block"]'))

describe('WeekView', () => {
  it('shows this week Monday to Sunday with the dates, today highlighted', () => {
    renderWeek()

    expect(headers().map((h) => h.textContent)).toEqual(['Mon14', 'Tue15', 'Wed16', 'Thu17', 'Fri18', 'Sat19', 'Sun20'])
    expect(headers()[2]?.getAttribute('data-today')).toBe('true')
    expect(headers()[2]?.className).toContain('text-foreground')
    expect(headers()[2]?.querySelector('span')?.className).toContain('bg-primary')
    expect(headers()[1]?.getAttribute('data-today')).toBeNull()
    expect(headers()[1]?.querySelector('span')?.className).not.toContain('bg-primary')
  })

  it('tints today’s column and draws the now line there at the current minute', () => {
    renderWeek()

    const today = columns()[2]
    expect(today?.getAttribute('data-today')).toBe('true')
    expect(today?.className).toContain('bg-muted/35')
    const line = today?.querySelector<HTMLElement>('[data-slot="now-line"]')
    expect(line?.style.top).toBe(`${((10 * 60 + 24) / 60) * HOUR_H}px`)
    expect(document.querySelectorAll('[data-slot="now-line"]')).toHaveLength(1)
    expect(columns()[1]?.className).not.toContain('bg-muted/35')
  })

  it('moves the now line as the minutes pass', () => {
    renderWeek()

    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    const line = document.querySelector<HTMLElement>('[data-slot="now-line"]')
    expect(line?.style.top).toBe(`${((10 * 60 + 25) / 60) * HOUR_H}px`)
  })

  it('bands the enabled GitHub polls above the grid', () => {
    renderWeek()

    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="poll-row"]'))
    expect(rows.map((row) => row.textContent)).toEqual([
      'Triage new issueson issue.opened · every 5 min19 runs',
      'Review open PRson pull_request.opened · every 10 min6 runs',
    ])
  })

  it('omits the poll band when no GitHub automation is enabled', () => {
    renderWeek(response({ automations: [NIGHTLY, { ...TRIAGE, enabled: false }] }))

    expect(document.querySelector('[data-slot="poll-band"]')).toBeNull()
  })

  it('places every occurrence at its minute in the server zone', () => {
    renderWeek()

    for (const column of columns()) {
      const nightly = blocksIn(column, NIGHTLY.id)
      expect(nightly).toHaveLength(1)
      expect(nightly[0]?.style.top).toBe(`${(240 / 60) * HOUR_H + 1}px`)
      expect(blocksIn(column, STALE_PR.id).map((b) => b.style.top)).toEqual(['1px', `${(360 / 60) * HOUR_H + 1}px`, `${(720 / 60) * HOUR_H + 1}px`, `${(1080 / 60) * HOUR_H + 1}px`])
    }
    // Weekdays only: five CI sweeps, none on the weekend.
    expect(columns().map((c) => blocksIn(c, 'a3').length)).toEqual([1, 1, 1, 1, 1, 0, 0])
    // Friday 16:00, once.
    expect(columns().map((c) => blocksIn(c, 'a5').length)).toEqual([0, 0, 0, 0, 1, 0, 0])
  })

  it('renders paused definitions at half opacity on their day', () => {
    renderWeek()

    const flaky = blocksIn(columns()[1] as HTMLElement, 'a6')
    expect(flaky).toHaveLength(1)
    expect(flaky[0]?.className).toContain('opacity-50')
    expect(flaky[0]?.style.top).toBe(`${(120 / 60) * HOUR_H + 1}px`)
    expect(columns().map((c) => blocksIn(c, 'a6').length)).toEqual([0, 1, 0, 0, 0, 0, 0])
  })

  it('stacks same-minute blocks 26px apart', () => {
    const twin = { ...NIGHTLY, id: 'twin', name: 'Twin bump' }
    renderWeek(response({ automations: [...AUTOMATIONS, twin] }))

    const monday = columns()[0] as HTMLElement
    expect(blocksIn(monday, NIGHTLY.id)[0]?.style.top).toBe(`${(240 / 60) * HOUR_H + 1}px`)
    expect(blocksIn(monday, 'twin')[0]?.style.top).toBe(`${(240 / 60) * HOUR_H + 1 + 26}px`)
  })

  it('says so for an unknown zone instead of drawing nothing', () => {
    renderWeek(response({ timeZone: 'Mars/Olympus' }))

    expect(document.querySelector('[data-slot="week-view"]')?.textContent).toContain('unknown time zone')
    expect(columns()).toHaveLength(0)
  })
})
