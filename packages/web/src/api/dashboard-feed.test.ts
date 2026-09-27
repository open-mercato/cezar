import { createElement } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { useDashboardFeed } from './dashboard'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it.each(['github', 'all'] as const)(
  'retries the failed GitHub request in %s feed',
  async (filter) => {
    const requests: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        requests.push(String(input))
        return new Response(JSON.stringify({ error: 'offline' }), { status: 503 })
      }),
    )
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const hook = renderHook(() => useDashboardFeed(filter, true), {
      wrapper: ({ children }) => createElement(QueryClientProvider, { client }, children),
    })
    await waitFor(() => expect(hook.result.current.githubError).toBe(true))
    const before = requests.filter((url) => url.includes('filter=github')).length
    await act(async () => {
      await hook.result.current.retryFailed()
    })
    expect(requests.filter((url) => url.includes('filter=github')).length).toBe(
      before + 1,
    )
    if (filter === 'github')
      expect(requests.some((url) => url.includes('filter=tasks'))).toBe(false)
    hook.unmount()
    client.clear()
  },
)

it('reconciles fresh task results after a missed event without overwriting in-flight transitions', async () => {
  const { dashboardTransition, dashboardTruth } = await import('./dashboard-truth')
  dashboardTransition('feed-recovery', { id: 'task', status: 'running', archived: false })
  let resolve!: (response: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done
        }),
    ),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const hook = renderHook(() => useDashboardFeed('tasks', true), {
    wrapper: ({ children }) => createElement(QueryClientProvider, { client }, children),
  })
  const answer = {
    asOf: '2026-09-25T00:00:00Z',
    windowStart: '2026-09-18T00:00:00Z',
    filter: 'tasks',
    sources: [],
    coverage: { projects: [] },
    truncated: false,
    rows: [
      {
        kind: 'task-result',
        key: 'task',
        at: '2026-09-25T00:00:00Z',
        run: {
          projectId: 'feed-recovery',
          id: 'task',
          status: 'done',
          archived: false,
          title: 'Task',
          createdAt: '2026-09-25T00:00:00Z',
          workflow: 'quick',
        },
      },
    ],
  }
  await act(async () => {
    resolve(Response.json(answer))
  })
  await waitFor(() => expect(hook.result.current.data).toBeDefined())
  expect(dashboardTruth('feed-recovery', 'task')?.status).toBe('done')
  let pending!: Promise<unknown>
  act(() => {
    pending = hook.result.current.retryTasks()
  })
  act(() =>
    dashboardTransition('feed-recovery', {
      id: 'task',
      status: 'running',
      archived: false,
    }),
  )
  await act(async () => {
    resolve(Response.json(answer))
    await pending
  })
  expect(dashboardTruth('feed-recovery', 'task')?.status).toBe('running')
  hook.unmount()
  client.clear()
})
