import { createElement } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { workspaceQueryKeys } from '@/api/queries'
import { useDashboardAutomations } from './automations-data'

const registry = vi.hoisted(() => ({
  data: { projects: [{ id: 'one', name: 'Original', status: 'ok' }] },
  refetch: vi.fn(),
}))
vi.mock('@/api/queries', async (original) => ({
  ...(await original<typeof import('@/api/queries')>()),
  useProjects: () => registry,
}))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('reconciles automations with the dashboard and reflects project renames', async () => {
  const fetcher = vi.fn(
    async (_input: RequestInfo | URL) => new Response(JSON.stringify({ error: 'offline' }), { status: 503 }),
  )
  vi.stubGlobal('fetch', fetcher)
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  const hook = renderHook(() => useDashboardAutomations(true), {
    wrapper: ({ children }) => createElement(QueryClientProvider, { client }, children),
  })
  await waitFor(() => expect(hook.result.current.data?.[0]?.name).toBe('Original'))
  expect(String(fetcher.mock.calls[0]?.[0])).toContain('/workspace/dashboard/automations?projectId=one')
  const before = fetcher.mock.calls.length
  await act(async () => {
    await client.invalidateQueries({ queryKey: workspaceQueryKeys.dashboard })
  })
  expect(fetcher.mock.calls.length).toBe(before + 1)
  registry.data = { projects: [{ id: 'one', name: 'Renamed', status: 'ok' }] }
  hook.rerender()
  await waitFor(() => expect(hook.result.current.data?.[0]?.name).toBe('Renamed'))
  hook.unmount()
  client.clear()
})
