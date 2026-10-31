import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Feed } from './feed'
const state = vi.hoisted(() => ({
  sources: [] as {
    key: string
    state: string
    reason?: string
    fetchedAt?: string
    truncated: boolean
  }[],
  coverage: { projects: [] as { projectId: string; state: string; omittedRuns: number; reason?: string }[] },
}))
const mocks = vi.hoisted(() => ({
  refetch: vi.fn(),
  retryFailed: vi.fn(),
  retryTasks: vi.fn(),
}))
vi.mock('@/api/dashboard', () => ({
  useDashboardFeed: () => ({
    data: { rows: [], sources: state.sources, coverage: state.coverage },
    refetch: mocks.refetch,
    retryFailed: mocks.retryFailed,
    retryTasks: mocks.retryTasks,
  }),
}))
vi.mock('./state', async (importOriginal) => ({
  ...await importOriginal<typeof import('./state')>(),
  useStagedRows: () => ({ rows: [], updates: 0 }),
}))
afterEach(() => {
  cleanup()
  state.coverage = { projects: [] }
  vi.clearAllMocks()
})
const show = () => render(<Feed filter="all" setFilter={vi.fn()} count={20} more={vi.fn()} />)
it('does not call missing remotes refresh failures alongside ready repositories', () => {
  state.sources = [
    {
      key: 'github:github.com/org/repo:issue',
      state: 'ready',
      fetchedAt: '2026-09-19T00:00:00Z',
      truncated: false,
    },
    {
      key: 'github:project:alpha:issue',
      state: 'unavailable',
      reason: 'No GitHub remote',
      truncated: false,
    },
  ]
  show()
  expect(screen.queryByText('GitHub needs attention')).toBeNull()
  expect(screen.queryByText('Retry GitHub')).toBeNull()
  expect(screen.getByText(/org\/repo · Issues/)).toBeTruthy()
})
it('shows loading separately from failures', () => {
  state.sources = [
    {
      key: 'github:project:alpha:issue',
      state: 'unavailable',
      reason: 'Still loading GitHub',
      truncated: false,
    },
  ]
  show()
  expect(screen.getByText('Checking GitHub…')).toBeTruthy()
  expect(screen.queryByText('Retry GitHub')).toBeNull()
})
it('defaults to task results when all projects lack a remote', () => {
  state.sources = [
    {
      key: 'github:project:alpha:issue',
      state: 'unavailable',
      reason: 'No GitHub remote',
      truncated: false,
    },
  ]
  show()
  expect(screen.getByRole('heading', { name: 'Recent results' })).toBeTruthy()
  expect(screen.queryByText('Retry GitHub')).toBeNull()
  expect(screen.getByText('No results in the last 7 days')).toBeTruthy()
})
it('retains actionable failure information for a configured repository', () => {
  state.sources = [
    {
      key: 'github:github.com/org/repo:pr',
      state: 'stale',
      reason: 'Connection failed',
      fetchedAt: '2026-09-19T00:00:00Z',
      truncated: false,
    },
  ]
  show()
  expect(screen.getByText('GitHub needs attention')).toBeTruthy()
  expect(screen.getByText('Retry GitHub')).toBeTruthy()
  expect(screen.getByText(/org\/repo · Pull requests: Connection failed/)).toBeTruthy()
})

it('keeps retry available when one source failed and another is still loading', () => {
  state.sources = [
    {
      key: 'github:github.com/org/repo:pr',
      state: 'unavailable',
      reason: 'Connection failed',
      truncated: false,
    },
    {
      key: 'github:project:alpha:issue',
      state: 'unavailable',
      reason: 'Still loading GitHub',
      truncated: false,
    },
  ]
  show()
  expect(screen.getByText('GitHub needs attention')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Retry GitHub' })).toBeTruthy()
})
