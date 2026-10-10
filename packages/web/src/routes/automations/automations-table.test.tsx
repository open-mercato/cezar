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
const details = (id: string) => row(id).querySelector('[data-slot="automation-details"]')
const headers = () => Array.from(document.querySelectorAll('th')).map((th) => th.textContent)

describe('AutomationsTable', () => {
  it('lays out the six columns in order — no state, runs-as, runs or cost column of their own', () => {
    renderTable()

    expect(headers()).toEqual(['Automation', 'Trigger', 'Next run', 'Last result', 'Enabled', 'Actions'])
    expect(document.querySelectorAll('[data-slot="automation-row"]')).toHaveLength(AUTOMATIONS.length)
  })

  it('dims a paused row and says so in its switch', () => {
    renderTable()

    expect(cells(FLAKY.id)[0]?.firstElementChild?.className).toContain('opacity-60')
    expect(row(FLAKY.id).getAttribute('data-enabled')).toBe('false')
    const paused = within(row(FLAKY.id)).getByRole('switch', { name: 'Enable Flaky test hunt' })
    expect(paused.getAttribute('aria-checked')).toBe('false')
    expect(cells(FLAKY.id)[4]?.contains(paused)).toBe(true)

    expect(cells(NIGHTLY.id)[0]?.firstElementChild?.className).not.toContain('opacity-60')
    expect(row(NIGHTLY.id).getAttribute('data-enabled')).toBe('true')
    expect(within(row(NIGHTLY.id)).getByRole('switch', { name: 'Pause Nightly dependency bump' }).getAttribute('aria-checked')).toBe('true')
  })

  it('pauses and enables from the row switch without opening the row', () => {
    const { actions } = renderTable()

    fireEvent.click(within(row(NIGHTLY.id)).getByRole('switch'))
    expect(actions.toggleEnabled).toHaveBeenLastCalledWith(NIGHTLY)
    fireEvent.click(within(row(FLAKY.id)).getByRole('switch'))
    expect(actions.toggleEnabled).toHaveBeenLastCalledWith(FLAKY)
    // The cell around the switch is not a way into the editor either.
    fireEvent.click(cells(NIGHTLY.id)[4] as HTMLElement)
    expect(screen.getByTestId('location').textContent).toBe('/automations')
  })

  it('disables the switch while a mutation is in flight', () => {
    renderTable(response(), mockActions({ busy: true }))

    expect(within(row(NIGHTLY.id)).getByRole('switch')).toHaveProperty('disabled', true)
    expect(within(row(FLAKY.id)).getByRole('switch')).toHaveProperty('disabled', true)
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

    expect(cells(NIGHTLY.id)[1]?.textContent).toBe('every day at 04:00')
    expect(cells(NIGHTLY.id)[1]?.getAttribute('title')).toBe('every day at 04:00')
    expect(cells(TRIAGE.id)[1]?.textContent).toBe('on issue.opened · every 5 min')
    expect(cells(CI_SWEEP.id)[1]?.textContent).toBe('weekdays at 07:30')
    expect(cells(STALE_PR.id)[1]?.textContent).toBe('every 6 hours')
  })

  it('shows workflow · runner on the name’s second line and the autonomous mark beside the name', () => {
    renderTable()

    const name = cells(NIGHTLY.id)[0]
    expect(details(NIGHTLY.id)?.textContent).toBe('fix-and-verify · claude · 7 runs this week')
    expect(name?.querySelector('[data-slot="autonomous-mark"]')?.getAttribute('title')).toBe('autonomous')
    // The weekly changelog is not autonomous — no mark.
    expect(cells('a5')[0]?.querySelector('[data-slot="autonomous-mark"]')).toBeNull()
  })

  it('reports the next run: continuous for a poll, the server instant for a schedule, a dash when paused', () => {
    renderTable()

    expect(cells(TRIAGE.id)[2]?.textContent).toBe('Continuous')
    expect(cells(NIGHTLY.id)[2]?.textContent).toBe('Thu 04:00')
    expect(cells(NIGHTLY.id)[2]?.className).toContain('text-foreground')
    expect(cells(FLAKY.id)[2]?.textContent).toBe('—')
    expect(cells(FLAKY.id)[2]?.className).toContain('text-muted-foreground')
  })

  it('computes the next run from the schedule when the server has not armed one yet', () => {
    renderTable()

    // Every 6 hours, after Wed 10:24 → Wed 12:00.
    expect(cells(STALE_PR.id)[2]?.textContent).toBe('Wed 12:00')
  })

  it('renders the last run with its tone, age and a task link that does not open the row', () => {
    renderTable()

    const last = cells(NIGHTLY.id)[3]
    expect(last?.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('success')
    expect(last?.textContent).toBe('done6h')
    const link = last?.querySelector<HTMLAnchorElement>('[data-slot="task-link"]')
    expect(link?.getAttribute('href')).toBe('/tasks/t15')
    expect(link?.getAttribute('title')).toBe('Open the task')
    expect(link?.textContent).toBe('done')

    expect(cells(CI_SWEEP.id)[3]?.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('danger')
    expect(cells('a7')[3]?.textContent).toBe('needs review52m')
    expect(cells('a7')[3]?.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('violet')

    fireEvent.click(link as HTMLAnchorElement)
    expect(screen.getByTestId('location').textContent).toBe('/tasks/t15')
  })

  it('shows a dash for an automation that never ran', () => {
    renderTable(response({ automations: [{ ...NIGHTLY, lastRun: undefined }] }))

    expect(cells(NIGHTLY.id)[3]?.textContent).toBe('—')
  })

  it('prints runs over seven days on the second line and no cost while AUTOMATION_COST_VISIBLE is off', () => {
    renderTable()

    expect(details(NIGHTLY.id)?.textContent).toContain('7 runs this week')
    expect(details('a5')?.textContent).toBe('fix-and-verify · claude · 1 run this week')
    expect(details(NIGHTLY.id)?.textContent).not.toContain('$')
    expect(headers()).not.toContain('Cost 7d')
    expect(cells(NIGHTLY.id)).toHaveLength(6)
  })

  it('prints no cost when the server reports no costs at all', () => {
    renderTable(
      response({
        stats: { runs: 1, failed: 0, agentSeconds: 60 },
        automations: AUTOMATIONS.map((automation) => ({ ...automation, costUsd7d: undefined })),
      }),
    )

    expect(headers()).not.toContain('Cost 7d')
    expect(details(NIGHTLY.id)?.textContent).toBe('fix-and-verify · claude · 7 runs this week')
    expect(cells(NIGHTLY.id)).toHaveLength(6)
  })

  it('opens the editor when the row is clicked', () => {
    renderTable()

    fireEvent.click(cells(NIGHTLY.id)[0] as HTMLElement)
    expect(screen.getByTestId('location').textContent).toBe('/automations/a1')
  })

  it('keeps the actions cell from opening the row', async () => {
    const { actions } = renderTable()

    // Radix opens the menu on pointerdown, not click.
    fireEvent.pointerDown(within(row(NIGHTLY.id)).getByRole('button', { name: 'More' }))
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Run now' }))
    expect(actions.runNow).toHaveBeenCalledWith(NIGHTLY)
    expect(screen.getByTestId('location').textContent).toBe('/automations')
  })

  it('marks GitHub rows paused by capability when the forge is unavailable', () => {
    renderTable(response({ available: false, reason: 'gh not installed' }))

    expect(cells(TRIAGE.id)[4]?.querySelector('[data-slot="capability-paused"]')?.textContent).toBe('paused by capability')
    // The definition itself is still enabled — the capability is what holds it.
    expect(within(row(TRIAGE.id)).getByRole('switch').getAttribute('aria-checked')).toBe('true')
    // A schedule automation is unaffected.
    expect(row(NIGHTLY.id).querySelector('[data-slot="capability-paused"]')).toBeNull()
  })
})
