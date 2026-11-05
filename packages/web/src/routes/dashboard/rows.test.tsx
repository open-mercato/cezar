import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it } from 'vitest'
import type { DashboardTaskRow } from '@open-mercato/cezar-api-client'
import { dashboardTransition } from '@/api/dashboard-truth'
import { DashboardReconciledContext } from './state'
import { TaskRow, Coverage } from './rows'

afterEach(cleanup)

it.each([
  ['waiting', 'user', 'monitoring paused'],
  ['waiting', 'parent', 'waiting on parent'],
  ['failed', 'user', 'monitoring stopped'],
] as const)('labels a %s hand-off owned by %s, including live updates', (status, owner, label) => {
  const row: DashboardTaskRow = {
    projectId: 'handoff-rows', id: `${status}-${owner}`, title: 'Monitoring task', status,
    archived: false, workflow: 'quick-task', createdAt: '2026-11-05T12:00:00Z',
    lastActivityAt: '2026-11-05T12:00:00Z',
    monitorHandoff: { owner, reason: 'wake-cap', since: '2026-11-05T12:00:00Z' },
  }
  render(
    <MemoryRouter>
      <DashboardReconciledContext.Provider value={true}>
        <TaskRow row={row} />
      </DashboardReconciledContext.Provider>
    </MemoryRouter>,
  )
  expect(screen.getByText(label)).toBeTruthy()
  act(() => dashboardTransition(row.projectId, { ...row, status: 'running', monitorHandoff: undefined }))
  expect(screen.getByText('running')).toBeTruthy()
  act(() => dashboardTransition(row.projectId, row))
  expect(screen.getByText(label)).toBeTruthy()
})

it('labels saved partial task counts without attributing them to complete projects', () => {
  render(<Coverage
    coverage={{ projects: [{ projectId: 'saved', state: 'partial', omittedRuns: 0 }] }}
    count={1}
    retry={() => {}}
  />)
  expect(screen.getByRole('status').textContent).toContain(
    '1 tasks need you in the available data. Complete coverage: 0 of 1 projects.',
  )
  expect(screen.getByRole('status').textContent).toContain('One project has incomplete coverage.')
  expect(screen.queryByText('One project is unavailable.')).toBeNull()
})
