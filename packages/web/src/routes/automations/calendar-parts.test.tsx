import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { AUTOMATIONS, CI_SWEEP, FLAKY, NIGHTLY, NOW, STALE_PR, TIME_ZONE } from './automations-list.fixtures'
import { EventBlock, HOUR_H, HourGutter, NowLine, dayStart, minuteOf, occurrencesIn, stacked } from './calendar-parts'

afterEach(cleanup)

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>
}

const block = () => document.querySelector<HTMLElement>('[data-slot="event-block"]')

describe('dayStart', () => {
  it('is midnight in the zone of the day `now` falls on, walked by whole days', () => {
    expect(dayStart(NOW, TIME_ZONE)).toBe(Date.parse('2026-09-16T00:00:00.000Z'))
    expect(dayStart(NOW, TIME_ZONE, -2)).toBe(Date.parse('2026-09-14T00:00:00.000Z'))
    expect(dayStart(NOW, TIME_ZONE, 15)).toBe(Date.parse('2026-10-01T00:00:00.000Z'))
    // Warsaw midnight is 22:00 UTC the evening before.
    expect(dayStart(NOW, 'Europe/Warsaw')).toBe(Date.parse('2026-09-15T22:00:00.000Z'))
  })

  it('is null for an unknown zone', () => {
    expect(dayStart(NOW, 'Mars/Olympus')).toBeNull()
  })
})

describe('occurrencesIn', () => {
  it('lists every schedule definition, paused ones included, ascending, with wall parts', () => {
    const from = Date.parse('2026-09-15T00:00:00.000Z')
    const to = Date.parse('2026-09-16T00:00:00.000Z')
    const occurrences = occurrencesIn(AUTOMATIONS, from, to, TIME_ZONE)

    expect(occurrences.map((o) => `${o.automation.id}@${minuteOf(o.parts)}`)).toEqual([
      'a4@0',
      'a6@120',
      'a1@240',
      'a4@360',
      'a3@450',
      'a4@720',
      'a4@1080',
    ])
    expect(occurrences.every((o) => o.at >= from && o.at < to)).toBe(true)
    expect(occurrences[1]?.automation).toBe(FLAKY)
  })
})

describe('stacked', () => {
  it('numbers blocks that share a minute', () => {
    const from = Date.parse('2026-09-16T00:00:00.000Z')
    const twin = { ...NIGHTLY, id: 'twin', name: 'Twin' }
    const result = stacked(occurrencesIn([NIGHTLY, twin, STALE_PR], from, from + 86_400_000, TIME_ZONE))

    expect(result.map((r) => [r.occurrence.automation.id, r.stack])).toEqual([
      ['a4', 0],
      ['a1', 0],
      ['twin', 1],
      ['a4', 0],
      ['a4', 0],
      ['a4', 0],
    ])
  })
})

describe('EventBlock', () => {
  function renderBlock(ui: React.ReactElement) {
    render(
      <MemoryRouter initialEntries={['/automations?view=week']}>
        <div style={{ position: 'relative' }}>{ui}</div>
        <LocationProbe />
      </MemoryRouter>,
    )
  }

  it('sits at its minute: top = minute / 60 · 34 + 1', () => {
    renderBlock(<EventBlock automation={NIGHTLY} minute={240} />)

    expect(block()?.style.top).toBe(`${(240 / 60) * HOUR_H + 1}px`)
    expect(block()?.className).toContain('h-6')
    expect(block()?.getAttribute('title')).toBe('Nightly dependency bump · 04:00')
    expect(block()?.textContent).toBe('Nightly dependency bump')
  })

  it('stacks 26px lower per same-minute sibling', () => {
    renderBlock(<EventBlock automation={NIGHTLY} minute={240} stack={2} />)

    expect(block()?.style.top).toBe(`${(240 / 60) * HOUR_H + 1 + 52}px`)
  })

  it('tones the dot by runner: codex violet, anything else success', () => {
    renderBlock(<EventBlock automation={CI_SWEEP} minute={450} />)
    expect(block()?.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('violet')

    cleanup()
    renderBlock(<EventBlock automation={NIGHTLY} minute={240} />)
    expect(block()?.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('success')
  })

  it('fades a paused definition to half', () => {
    renderBlock(<EventBlock automation={FLAKY} minute={120} />)

    expect(block()?.className).toContain('opacity-50')
    expect(block()?.getAttribute('data-enabled')).toBe('false')
  })

  it('grows to the wide shape with a second mono line for the day view', () => {
    renderBlock(<EventBlock automation={NIGHTLY} minute={240} wide />)

    expect(block()?.className).toContain('h-12')
    expect(block()?.textContent).toBe('Nightly dependency bump04:00 · fix-and-verify · claude')
  })

  it('opens the editor', () => {
    renderBlock(<EventBlock automation={NIGHTLY} minute={240} />)

    fireEvent.click(block() as HTMLElement)
    expect(screen.getByTestId('location').textContent).toBe('/automations/a1')
  })
})

describe('HourGutter', () => {
  it('labels 23 hours, leaving midnight blank, one 34px row each', () => {
    render(<HourGutter />)

    const cells = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="hour-gutter"] > div'))
    expect(cells).toHaveLength(24)
    expect(cells.map((cell) => cell.textContent)).toEqual(['', '01:00', '02:00', '03:00', '04:00', '05:00', '06:00', '07:00', '08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00', '21:00', '22:00', '23:00'])
    expect(cells.every((cell) => cell.style.height === `${HOUR_H}px`)).toBe(true)
  })
})

describe('NowLine', () => {
  it('draws the current minute in primary', () => {
    render(<NowLine minute={10 * 60 + 24} />)

    const line = document.querySelector<HTMLElement>('[data-slot="now-line"]')
    expect(line?.style.top).toBe(`${(624 / 60) * HOUR_H}px`)
    expect(line?.className).toContain('bg-primary')
    expect(line?.getAttribute('aria-hidden')).toBe('true')
    expect(line?.querySelector('span')?.className).toContain('rounded-full')
  })
})
