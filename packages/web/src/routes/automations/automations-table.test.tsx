import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AUTOMATIONS,
  CI_SWEEP,
  FLAKY,
  NIGHTLY,
  NOW,
  STALE_PR,
  TRIAGE,
  mockActions,
  response,
  stubResizeObserver,
} from './automations-list.fixtures'
import { AutomationsTable } from './automations-table'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
beforeEach(stubResizeObserver)

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>
}

function renderTable(data = response(), actions = mockActions()) {
  render(
    <MemoryRouter initialEntries={['/automations']}>
      <AutomationsTable data={data} actions={actions} now={NOW} />
      <LocationProbe />
    </MemoryRouter>,
  )
  return { actions }
}

const row = (id: string) => {
  const el = document.querySelector<HTMLTableRowElement>(`[data-slot="automation-row"][data-automation="${id}"]`)
  if (!el) throw new Error(`row ${id} did not render`)
  return el
}
const cells = (id: string) => Array.from(row(id).querySelectorAll('td'))
const headers = () => Array.from(document.querySelectorAll('th')).map((th) => th.textContent)

describe('AutomationsTable', () => {
  it('lays out the design columns in order — Cost 7d hidden for now (AUTOMATION_COST_VISIBLE)', () => {
    renderTable()

    expect(headers()).toEqual(['State', 'Automation', 'Trigger', 'Runs as', 'Next run', 'Last run', 'Runs 7d', ''])
    expect(document.querySelectorAll('[data-slot="automation-row"]')).toHaveLength(AUTOMATIONS.length)
  })

  it('dims a paused row and says so in its pill', () => {
    renderTable()

    expect(row(FLAKY.id).className).toContain('opacity-60')
    expect(row(FLAKY.id).getAttribute('data-enabled')).toBe('false')
    expect(within(row(FLAKY.id)).getByText('paused').closest('[data-slot="pill"]')?.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('neutral')

    expect(row(NIGHTLY.id).className).not.toContain('opacity-60')
    const enabledPill = within(row(NIGHTLY.id)).getByText('enabled').closest('[data-slot="pill"]')
    expect(enabledPill?.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('success')
    expect(enabledPill?.querySelector('[data-slot="status-dot"]')?.className).not.toContain('animate-pulse')
  })

  it('pulses the dot of an enabled GitHub poll', () => {
    renderTable()

    const pill = within(row(TRIAGE.id)).getByText('enabled').closest('[data-slot="pill"]')
    expect(pill?.querySelector('[data-slot="status-dot"]')?.className).toContain('animate-pulse')
  })

  it('wears the dispatch badge with the subtask ceiling', () => {
    renderTable()

    const badge = row(NIGHTLY.id).querySelector('[data-slot="dispatch-badge"]')
    expect(badge?.textContent).toBe('×4')
    expect(badge?.getAttribute('title')).toBe('dispatch · up to 4 subtasks')
    expect(row(STALE_PR.id).querySelector('[data-slot="dispatch-badge"]')).toBeNull()
  })

  it('prints the trigger label with the full text as the tooltip', () => {
    renderTable()

    expect(cells(NIGHTLY.id)[2]?.textContent).toBe('every day at 04:00')
    expect(cells(NIGHTLY.id)[2]?.getAttribute('title')).toBe('every day at 04:00')
    expect(cells(TRIAGE.id)[2]?.textContent).toBe('on issue.opened · every 5 min')
    expect(cells(CI_SWEEP.id)[2]?.textContent).toBe('weekdays at 07:30')
    expect(cells(STALE_PR.id)[2]?.textContent).toBe('every 6 hours')
  })

  it('shows workflow · runner and the autonomous mark in Runs as', () => {
    renderTable()

    const runsAs = cells(NIGHTLY.id)[3]
    expect(runsAs?.textContent).toBe('fix-and-verify·claude·')
    expect(runsAs?.querySelector('[data-slot="autonomous-mark"]')?.getAttribute('title')).toBe('autonomous')
    expect(runsAs?.className).toContain('cz-auto-wide')
    // The weekly changelog is not autonomous — no mark.
    expect(cells('a5')[3]?.querySelector('[data-slot="autonomous-mark"]')).toBeNull()
  })

  it('reports the next run: continuous for a poll, the server instant for a schedule, a dash when paused', () => {
    renderTable()

    expect(cells(TRIAGE.id)[4]?.textContent).toBe('continuous')
    expect(cells(NIGHTLY.id)[4]?.textContent).toBe('Thu 04:00')
    expect(cells(FLAKY.id)[4]?.textContent).toBe('—')
    expect(cells(FLAKY.id)[4]?.className).toContain('text-soft-foreground')
  })

  it('computes the next run from the schedule when the server has not armed one yet', () => {
    renderTable()

    // Every 6 hours, after Wed 10:24 → Wed 12:00.
    expect(cells(STALE_PR.id)[4]?.textContent).toBe('Wed 12:00')
  })

  it('renders the last run with its tone, age and a task link that does not open the row', () => {
    renderTable()

    const last = cells(NIGHTLY.id)[5]
    expect(last?.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('success')
    expect(last?.textContent).toBe('done6htask')
    const link = last?.querySelector<HTMLAnchorElement>('[data-slot="task-link"]')
    expect(link?.getAttribute('href')).toBe('/tasks/t15')

    expect(cells(CI_SWEEP.id)[5]?.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('danger')
    expect(cells('a7')[5]?.textContent).toBe('needs review52mtask')
    expect(cells('a7')[5]?.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('violet')

    fireEvent.click(link as HTMLAnchorElement)
    expect(screen.getByTestId('location').textContent).toBe('/tasks/t15')
  })

  it('shows a dash for an automation that never ran', () => {
    renderTable(response({ automations: [{ ...NIGHTLY, lastRun: undefined }] }))

    expect(cells(NIGHTLY.id)[5]?.textContent).toBe('—')
  })

  it('prints runs over seven days and no cost column while AUTOMATION_COST_VISIBLE is off', () => {
    renderTable()

    expect(cells(NIGHTLY.id)[6]?.textContent).toBe('7')
    expect(headers()).not.toContain('Cost 7d')
    expect(cells(NIGHTLY.id)).toHaveLength(8)
  })

  it('drops the cost column when the server reports no costs at all', () => {
    renderTable(
      response({
        stats: { runs: 1, failed: 0, agentSeconds: 60 },
        automations: AUTOMATIONS.map((automation) => ({ ...automation, costUsd7d: undefined })),
      }),
    )

    expect(headers()).not.toContain('Cost 7d')
    expect(cells(NIGHTLY.id)).toHaveLength(8)
  })

  it('opens the editor when the row is clicked', () => {
    renderTable()

    fireEvent.click(cells(NIGHTLY.id)[1] as HTMLElement)
    expect(screen.getByTestId('location').textContent).toBe('/automations/a1')
  })

  it('keeps the actions cell from opening the row', () => {
    const { actions } = renderTable()

    fireEvent.click(within(row(NIGHTLY.id)).getByRole('button', { name: 'Run now' }))
    expect(actions.runNow).toHaveBeenCalledWith(NIGHTLY)
    expect(screen.getByTestId('location').textContent).toBe('/automations')
  })

  it('marks GitHub rows paused by capability when the forge is unavailable', () => {
    renderTable(response({ available: false, reason: 'gh not installed' }))

    expect(cells(TRIAGE.id)[0]?.textContent).toBe('paused by capability')
    expect(cells(TRIAGE.id)[0]?.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('neutral')
    // A schedule automation is unaffected.
    expect(cells(NIGHTLY.id)[0]?.textContent).toBe('enabled')
  })
})
