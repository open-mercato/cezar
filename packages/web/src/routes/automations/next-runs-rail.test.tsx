import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AUTOMATIONS, FLAKY, NIGHTLY, NOW, STALE_PR, TIME_ZONE, TRIAGE } from './automations-list.fixtures'
import { NextRunsRail, nextRuns } from './next-runs-rail'

afterEach(cleanup)

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>
}

function renderRail(upcoming = nextRuns(AUTOMATIONS, NOW, TIME_ZONE, 12), pollCount = 2) {
  const onOpenChange = vi.fn()
  render(
    <MemoryRouter initialEntries={['/automations']}>
      <NextRunsRail open onOpenChange={onOpenChange} upcoming={upcoming} pollCount={pollCount} timeZone={TIME_ZONE} now={NOW} />
      <LocationProbe />
    </MemoryRouter>,
  )
  return { onOpenChange }
}

const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-slot="next-run-row"]'))

describe('nextRuns', () => {
  it('lists the next twelve occurrences across enabled schedule automations, soonest first', () => {
    const runs = nextRuns(AUTOMATIONS, NOW, TIME_ZONE, 12)

    expect(runs).toHaveLength(12)
    expect(runs.map((run) => run.at)).toEqual([...runs.map((run) => run.at)].sort((a, b) => a - b))
    expect(runs[0]).toEqual({ automation: STALE_PR, at: Date.parse('2026-09-16T12:00:00.000Z') })
    expect(runs.some((run) => run.automation.id === NIGHTLY.id)).toBe(true)
    // Paused and GitHub automations have no upcoming instants.
    expect(runs.some((run) => run.automation.id === FLAKY.id)).toBe(false)
    expect(runs.some((run) => run.automation.id === TRIAGE.id)).toBe(false)
  })

  it('honours the limit and the fourteen-day window', () => {
    expect(nextRuns(AUTOMATIONS, NOW, TIME_ZONE, 3)).toHaveLength(3)
    // A weekly run alone: exactly two Fridays fall in the next fourteen days.
    expect(nextRuns([AUTOMATIONS[4] as typeof NIGHTLY], NOW, TIME_ZONE, 12)).toHaveLength(2)
  })
})

describe('NextRunsRail', () => {
  it('opens as a sheet titled Next runs with twelve rows', () => {
    renderRail()

    const sheet = screen.getByRole('dialog')
    expect(sheet.getAttribute('data-slot')).toBe('next-runs-rail')
    expect(within(sheet).getByText('Next runs')).toBeTruthy()
    expect(rows()).toHaveLength(12)
  })

  it('prefixes the day only when the run is not today', () => {
    renderRail()

    const [first] = rows()
    expect(first?.children[0]?.textContent).toBe('12:00')
    expect(first?.children[1]?.textContent).toBe('Stale PR nudge')
    expect(first?.children[2]?.textContent).toBe('in 2h')

    const tomorrow = rows().find((row) => row.dataset.automation === NIGHTLY.id)
    expect(tomorrow?.children[0]?.textContent).toBe('Thu 04:00')
    expect(tomorrow?.children[2]?.textContent).toBe('in 18h')
  })

  it('counts the polls in the footer', () => {
    renderRail()

    expect(document.querySelector('[data-slot="next-runs-footer"]')?.textContent).toBe('2 GitHub polls running continuously')
    expect(document.querySelector('[data-slot="next-runs-footer"] [data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('pending')
  })

  it('closes and opens the editor when a row is clicked', () => {
    const { onOpenChange } = renderRail()

    fireEvent.click(rows()[0] as HTMLElement)
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(screen.getByTestId('location').textContent).toBe('/automations/a4')
  })

  it('says so when nothing is scheduled', () => {
    renderRail([], 0)

    expect(rows()).toHaveLength(0)
    expect(screen.getByText('No scheduled runs in the next two weeks.')).toBeTruthy()
    expect(document.querySelector('[data-slot="next-runs-footer"]')?.textContent).toBe('0 GitHub polls running continuously')
  })
})
