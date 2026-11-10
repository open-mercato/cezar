import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { NIGHTLY, NOW, STALE_PR, TIME_ZONE } from './automations-list.fixtures'
import { StatsStrip } from './stats-strip'

afterEach(cleanup)

const STATS = { runs: 66, failed: 2, agentSeconds: 4 * 3600 + 12 * 60, costUsd: 13.4 }
const UPCOMING = [
  { automation: STALE_PR, at: Date.parse('2026-09-16T12:00:00.000Z') },
  { automation: NIGHTLY, at: Date.parse('2026-09-17T04:00:00.000Z') },
]

const stat = (label: string) => document.querySelector(`[data-slot="stat"][data-label="${label}"]`)

function renderStrip(overrides: Partial<Parameters<typeof StatsStrip>[0]> = {}) {
  const onOpenRail = vi.fn()
  render(
    <StatsStrip
      stats={STATS}
      pollCount={2}
      upcoming={UPCOMING}
      timeZone={TIME_ZONE}
      railOpen={false}
      onOpenRail={onOpenRail}
      {...overrides}
    />,
  )
  return { onOpenRail }
}

describe('StatsStrip', () => {
  it('shows the figures of the week in the design spellings — cost hidden for now (AUTOMATION_COST_VISIBLE)', () => {
    renderStrip()

    expect(stat('runs')?.textContent).toBe('66runs')
    expect(stat('spent')).toBeNull()
    expect(stat('failed')?.textContent).toBe('2failed')
    expect(stat('agent time')?.textContent).toBe('4h 12magent time')
  })

  it('hides the spend when the server reports no cost', () => {
    renderStrip({ stats: { runs: 3, failed: 0, agentSeconds: 90 } })

    expect(stat('spent')).toBeNull()
    expect(stat('runs')?.textContent).toBe('3runs')
    expect(stat('agent time')?.textContent).toBe('2magent time')
  })

  it('colours the failed figure danger only when something failed', () => {
    renderStrip()
    expect(stat('failed')?.querySelector('b')?.className).toContain('text-danger')

    cleanup()
    renderStrip({ stats: { ...STATS, failed: 0 } })
    expect(stat('failed')?.querySelector('b')?.className).not.toContain('text-danger')
  })

  it('counts the continuous polls with a pulsing pending dot', () => {
    renderStrip()

    const polls = document.querySelector('[data-slot="stats-polls"]')
    expect(polls?.textContent).toBe('2 GitHub polls continuous')
    expect(polls?.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('pending')
    expect(polls?.querySelector('[data-slot="status-dot"]')?.className).toContain('animate-pulse')
  })

  it('names the very next run by time and automation', () => {
    renderStrip()

    expect(document.querySelector('[data-slot="stats-next"]')?.textContent).toBe('next 12:00 Stale PR nudge')
  })

  it('shows a dash when nothing is scheduled', () => {
    renderStrip({ upcoming: [] })

    expect(document.querySelector('[data-slot="stats-next"]')?.textContent).toBe('next — ')
  })

  it('opens the rail from the counted button', () => {
    const { onOpenRail } = renderStrip()
    const button = screen.getByRole('button', { name: /Next runs/ })

    expect(button.textContent).toBe('Next runs2')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(button)
    expect(onOpenRail).toHaveBeenCalledTimes(1)
  })

  it('renders times in the server zone, not the browser zone', () => {
    renderStrip({ timeZone: 'Europe/Warsaw', upcoming: [{ automation: STALE_PR, at: NOW }] })

    // 10:24 UTC is 12:24 in Warsaw in September.
    expect(document.querySelector('[data-slot="stats-next"] b')?.textContent).toBe('12:24')
  })
})
