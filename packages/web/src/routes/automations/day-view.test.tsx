import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NOW, REVIEW_PRS, TRIAGE, response } from './automations-list.fixtures'
import { HOUR_H } from './calendar-parts'
import { DayView } from './day-view'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>
}

function renderDay(data = response()) {
  render(
    <MemoryRouter initialEntries={['/automations?view=day']}>
      <DayView data={data} />
      <LocationProbe />
    </MemoryRouter>,
  )
}

const title = () => document.querySelector('[data-slot="day-title"]')?.textContent
const blocks = () => Array.from(document.querySelectorAll<HTMLElement>('[data-slot="event-block"]'))
const agenda = () => Array.from(document.querySelectorAll<HTMLElement>('[data-slot="agenda-row"]'))

describe('DayView', () => {
  it('opens on today in the server zone, with the today pill and the count', () => {
    renderDay()

    expect(title()).toBe('Wed 16 Sep')
    expect(screen.getByText('today').closest('[data-slot="pill"]')).not.toBeNull()
    expect(screen.getByText('6 scheduled runs · 2 GitHub polls')).toBeTruthy()
    expect(document.querySelector('[data-slot="day-column"]')?.getAttribute('data-today')).toBe('true')
  })

  it('draws the wide blocks at their minute and the now line at the current one', () => {
    renderDay()

    expect(blocks().map((b) => [b.dataset.automation, b.style.top])).toEqual([
      ['a4', '1px'],
      ['a1', `${(240 / 60) * HOUR_H + 1}px`],
      ['a4', `${(360 / 60) * HOUR_H + 1}px`],
      ['a3', `${(450 / 60) * HOUR_H + 1}px`],
      ['a4', `${(720 / 60) * HOUR_H + 1}px`],
      ['a4', `${(1080 / 60) * HOUR_H + 1}px`],
    ])
    expect(blocks().every((b) => b.className.includes('h-12'))).toBe(true)
    expect(blocks()[1]?.textContent).toBe('Nightly dependency bump04:00 · fix-and-verify · claude')
    expect(document.querySelector<HTMLElement>('[data-slot="now-line"]')?.style.top).toBe(`${((10 * 60 + 24) / 60) * HOUR_H}px`)
  })

  it('tones the agenda: past rows soft with the last run’s dot, future rows plain with a neutral dot', () => {
    renderDay()

    const rows = agenda()
    expect(rows.map((r) => r.dataset.past)).toEqual(['true', 'true', 'true', 'true', 'false', 'false'])

    const past = rows[3] as HTMLElement // CI sweep at 07:30 — it failed
    expect(past.querySelector('span')?.className).toContain('text-soft-foreground')
    expect(past.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('danger')
    expect(past.textContent).toContain('Weekday morning CI sweep')
    expect(past.textContent).toContain('List workflows that failed on main since yesterday 07:30.')

    const future = rows[4] as HTMLElement // Stale PR nudge at 12:00
    expect(future.querySelector('span')?.className).toContain('text-foreground')
    expect(future.querySelector('span')?.textContent).toBe('12:00')
    expect(future.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('neutral')
  })

  it('walks to the previous and the next day, dropping the today pill and the now line', () => {
    renderDay()

    fireEvent.click(screen.getByRole('button', { name: 'Previous day' }))
    expect(title()).toBe('Tue 15 Sep')
    expect(screen.queryByText('today')).toBeNull()
    expect(document.querySelector('[data-slot="now-line"]')).toBeNull()
    // Tuesday carries the paused Flaky test hunt at 02:00, at half opacity, and every row is past.
    const flaky = blocks().find((b) => b.dataset.automation === 'a6')
    expect(flaky?.style.top).toBe(`${(120 / 60) * HOUR_H + 1}px`)
    expect(flaky?.className).toContain('opacity-50')
    expect(agenda().every((r) => r.dataset.past === 'true')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Next day' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next day' }))
    expect(title()).toBe('Thu 17 Sep')
    expect(agenda().every((r) => r.dataset.past === 'false')).toBe(true)
  })

  it('crosses the month boundary on real calendar days', () => {
    renderDay()

    for (let i = 0; i < 15; i += 1) fireEvent.click(screen.getByRole('button', { name: 'Next day' }))
    expect(title()).toBe('Thu 1 Oct')
  })

  it('opens the editor from an agenda row', () => {
    renderDay()

    fireEvent.click(agenda()[1] as HTMLElement)
    expect(screen.getByTestId('location').textContent).toBe('/automations/a1')
  })

  it('says nothing is scheduled while polls still run, and shows those polls as a band and agenda rows', () => {
    renderDay(response({ automations: [TRIAGE, REVIEW_PRS] }))

    expect(screen.getByText('Nothing scheduled — the GitHub polls above still run.')).toBeTruthy()
    expect(screen.getByText('0 scheduled runs · 2 GitHub polls')).toBeTruthy()
    expect(blocks()).toHaveLength(0)
    const band = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="poll-row"]'))
    expect(band.map((row) => row.textContent)).toEqual([
      `${TRIAGE.name}on issue.opened · every 5 min${TRIAGE.runs7d} runs`,
      `${REVIEW_PRS.name}on pull_request.opened · every 10 min${REVIEW_PRS.runs7d} runs`,
    ])
    const polls = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="agenda-poll"]'))
    expect(polls).toHaveLength(2)
    expect(polls[0]?.textContent).toContain('continuous')
    fireEvent.click(polls[0] as HTMLElement)
    expect(screen.getByTestId('location').textContent).toBe(`/automations/${TRIAGE.id}`)
  })

  it('shows no poll band and the plain empty line when no poll is enabled', () => {
    renderDay(response({ automations: [{ ...TRIAGE, enabled: false }] }))

    expect(document.querySelector('[data-slot="poll-band"]')).toBeNull()
    expect(document.querySelectorAll('[data-slot="agenda-poll"]')).toHaveLength(0)
    expect(screen.getByText('Nothing scheduled.')).toBeTruthy()
  })
})
