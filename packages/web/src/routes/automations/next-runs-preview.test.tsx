import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { NextRunsPreview } from './next-runs-preview'

afterEach(cleanup)

// Monday 14 Sep 2026, 10:00 in Warsaw (08:00Z).
const NOW = Date.parse('2026-09-14T08:00:00.000Z')

describe('NextRunsPreview', () => {
  it('lists the next five runs of a daily schedule in the server zone, with a relative age', () => {
    const { container } = render(
      <NextRunsPreview kind="schedule" schedule={{ type: 'daily', hour: 4, minute: 0 }} intervalSeconds={300} timeZone="Europe/Warsaw" now={NOW} />,
    )
    expect(screen.getByText('Next 5 runs')).not.toBeNull()
    const rows = container.querySelectorAll('[data-slot="next-run"]')
    expect(rows).toHaveLength(5)
    expect(rows[0]?.textContent).toBe('Tue 04:00in 18h')
    expect(rows[1]?.textContent).toBe('Wed 04:00in 2d')
    expect(rows[4]?.textContent).toBe('Sat 04:00in 5d')
  })

  it('a weekly schedule fills five weeks ahead only as far as nine days reach', () => {
    const { container } = render(
      <NextRunsPreview kind="schedule" schedule={{ type: 'weekly', day: 5, hour: 16 }} intervalSeconds={300} timeZone="Europe/Warsaw" now={NOW} />,
    )
    const rows = container.querySelectorAll('[data-slot="next-run"]')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toBe('Fri 16:00in 4d')
  })

  it('describes the poll for a github kind', () => {
    render(<NextRunsPreview kind="github" schedule={{ type: 'daily' }} intervalSeconds={600} timeZone="Europe/Warsaw" now={NOW} />)
    expect(screen.getByText('How it polls')).not.toBeNull()
    expect(screen.getByText(/Checks GitHub every 10 min while cezar is open/)).not.toBeNull()
  })
})

it('describes tracker polling without claiming gh authentication', () => {
  const { container } = render(<NextRunsPreview kind="tracker" schedule={{ type: 'daily' }} intervalSeconds={1800} timeZone="UTC" now={NOW} />)
  expect(container.textContent).toContain('Checks the project tracker every 30 min')
  expect(container.textContent).not.toContain('GitHub')
  expect(container.textContent).not.toContain('through your')
})
