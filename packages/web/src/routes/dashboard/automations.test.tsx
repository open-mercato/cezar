import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { DashboardAutomations } from './automations'
const state = vi.hoisted(() => ({ off: false, error: false, empty: false, tracker: false }))
vi.mock('@/routes/automations/use-automations', () => ({
  useAutomationsGate: () => ({ known: true, off: state.off }),
}))
vi.mock('./automations-data', async (original) => ({
  ...(await original<typeof import('./automations-data')>()),
  useDashboardAutomations: () => ({
    data: state.empty
      ? []
      : [
          {
            id: 'alpha',
            name: 'Alpha',
            data: {
              timeZone: 'UTC',
              automations: Array.from({ length: 4 }, (_, i) => ({
                id: `a${i}`,
                name: `Automation ${i}`,
                enabled: true,
                state: { consecutiveFailures: i === 0 ? 2 : 0 },
                kind: i === 0 ? (state.tracker ? 'tracker' : 'github') : 'schedule',
                nextRunAt: `2030-01-0${i + 1}T10:00:00Z`,
              })),
            },
          },
          ...(state.error
            ? [{ id: 'beta', name: 'Beta', error: 'Could not load automations' }]
            : []),
        ],
    registry: { data: { projects: [{ id: 'alpha', name: 'Alpha' }] } },
    retry: vi.fn(),
  }),
}))
afterEach(() => {
  cleanup()
  state.off = false
  state.error = false
  state.empty = false
  state.tracker = false
})
const show = () =>
  render(
    <MemoryRouter>
      <DashboardAutomations />
    </MemoryRouter>,
  )
it('shows three enabled rows, distinguishes polls, links to scoped details and expands', () => {
  show()
  expect(screen.getByText('4 enabled')).toBeTruthy()
  expect(screen.getByText(/Next check:/)).toBeTruthy()
  expect(screen.getByText('Recent checks failed')).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Automation 0' }).getAttribute('href')).toBe(
    '/p/alpha/automations/a0',
  )
  expect(screen.queryByText('Automation 3')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Show all 4 enabled' }))
  expect(screen.getByText('Automation 3')).toBeTruthy()
})
it('marks partial data instead of claiming a complete count', () => {
  state.error = true
  show()
  expect(screen.getByText('4 enabled · partial')).toBeTruthy()
  expect(screen.getByRole('alert')).toBeTruthy()
})
it('explains empty and disabled states', () => {
  state.empty = true
  show()
  expect(screen.getByText(/No enabled automations/)).toBeTruthy()
  cleanup()
  state.off = true
  show()
  expect(screen.getByText('Automations are disabled in this workspace.')).toBeTruthy()
  expect(screen.queryByText(/No enabled/)).toBeNull()
})

it('describes tracker event polling as a check in the screen and export', () => {
  state.tracker = true
  const { container } = show()
  const row = screen.getByRole('link', { name: 'Automation 0' }).closest('[data-export-row]')!
  expect(row.textContent).toContain('Next check:')
  expect(row.textContent).toContain('Checks for matching events; a task may not be started.')
  const exports = [...container.querySelectorAll<HTMLElement>('[data-dashboard-export]')]
    .flatMap(node => JSON.parse(node.dataset.dashboardExport!))
  expect(exports.find(row => row.entity === 'alpha:a0' && row.metric === 'nextCheckAt')?.value)
    .toBe('2030-01-01T10:00:00.000Z')
  expect(exports.some(row => row.entity === 'alpha:a0' && row.metric === 'nextRunAt')).toBe(false)
  expect(exports.some(row => row.entity === 'alpha:a1' && row.metric === 'nextRunAt')).toBe(true)
})
