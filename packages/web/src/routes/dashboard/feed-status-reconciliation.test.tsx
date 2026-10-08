import { it, expect, vi, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { DashboardFeedRow } from '@open-mercato/cezar-api-client'
import { Feed } from '@/routes/dashboard/feed'
import {
  dashboardTransition,
  dashboardTruthRevision,
  reconcileDashboardTruth,
} from '@/api/dashboard-truth'
const state = vi.hoisted(() => ({ rows: [] as DashboardFeedRow[] }))
vi.mock('@/api/dashboard', () => ({
  useDashboardFeed: () => ({
    data: { rows: state.rows, sources: [], coverage: { projects: [] } },
    refetch: vi.fn(),
    retryTasks: vi.fn(),
    retryFailed: vi.fn(),
  }),
}))
it('retains latest status after the operational snapshot reconciles a resumed feed task', () => {
  state.rows = [
    {
      kind: 'task-result',
      key: 'tasks:p:r',
      at: '2026-09-25T00:00:00Z',
      run: {
        projectId: 'p',
        id: 'r',
        title: 'Resumed task',
        status: 'done',
        createdAt: '2026-09-25T00:00:00Z',
        archived: false,
        workflow: 'quick',
      },
    },
  ]
  const view = () => (
    <MemoryRouter>
      <Feed filter="tasks" setFilter={vi.fn()} count={6} more={vi.fn()} />
    </MemoryRouter>
  )
  const rendered = render(view())
  act(() => dashboardTransition('p', { id: 'r', status: 'running', archived: false }))
  expect(screen.getByText('running')).toBeTruthy()
  state.rows = []
  act(() => reconcileDashboardTruth(dashboardTruthRevision(), []))
  rendered.rerender(view())
  expect(screen.getByText('running')).toBeTruthy()
  const exported = [
    ...rendered.container.querySelectorAll<HTMLElement>('[data-dashboard-export]'),
  ].flatMap((el) => JSON.parse(el.dataset.dashboardExport!))
  expect(exported.find((row) => row.metric === 'status')?.value).toBe('running')
})

afterEach(cleanup)
