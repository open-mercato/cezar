import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { getDashboardTasks } from '@/api/dashboard'
import type { DashboardSnapshot, DashboardTaskRow } from '@open-mercato/cezar-api-client'
import { useDisplacedRows } from './pages'
vi.mock('@/api/dashboard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/dashboard')>()),
  getDashboardTasks: vi.fn(),
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
it('finds a staged question that moved into reviews instead of claiming it no longer needs input', async () => {
  const row: DashboardTaskRow = {
    id: 'task',
    projectId: 'shop',
    title: 'Question moved',
    status: 'waiting',
    createdAt: '2026-09-18T00:00:00.000Z',
    archived: false,
    workflow: 'quick',
  }
  const snapshot: DashboardSnapshot = {
    snapshotId: 'fresh',
    asOf: row.createdAt,
    expiresAt: row.createdAt,
    coverage: { projects: [] },
    counts: { questions: 0, reviews: 1, running: 0, monitoring: 0, queued: 0, scheduled: 0 },
    questions: { rows: [], total: 0, nextOffset: null },
    reviews: { rows: [{ ...row, status: 'review' }], total: 1, nextOffset: null },
  }
  vi.mocked(getDashboardTasks).mockImplementation(async (snapshotId, group, offset) => ({
    snapshotId,
    asOf: row.createdAt,
    coverage: snapshot.coverage,
    page: {
      rows: group === 'needs-you' && offset === 0 ? [{ ...row, status: 'review' }] : [],
      total: 1,
      nextOffset: null,
    },
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { result } = renderHook(() => useDisplacedRows(snapshot, 'questions', 3, [row]), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  })
  await waitFor(() => expect(result.current.data?.get('shop:task')?.status).toBe('review'))
  expect(getDashboardTasks).toHaveBeenCalledWith(
    'fresh',
    'needs-you',
    0,
    20,
    expect.any(AbortSignal),
  )
  client.clear()
})
