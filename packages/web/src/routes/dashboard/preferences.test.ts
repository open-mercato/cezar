import { createElement } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import {
  dashboardPreferencesInputSchema,
  dashboardPreferencesSchema,
} from '@open-mercato/cezar-api-client'
import { defaultOrder, resetViewOrder, useDashboardPreferences } from './preferences'

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }))
vi.mock('@/api/queries', async (original) => ({
  ...(await original<typeof import('@/api/queries')>()),
  useWorkspaceUiState: () => ({ data: mocks.read() }),
}))
vi.mock('@/api/client', async (original) => ({
  ...(await original<typeof import('@/api/client')>()),
  putWorkspaceUiState: mocks.write,
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('preserves future widget slots and preferences through visibility, drag and reset writes', async () => {
  const order = ['overview', 'future-widget', ...defaultOrder.slice(1), 'future-last']
  const saved = {
    dashboard: { order, tiles: { futureWidget: false }, futureSetting: { mode: 'new' } },
  }
  mocks.read.mockReturnValue(saved)
  mocks.write.mockImplementation(
    async (input) => dashboardPreferencesInputSchema.parse(input.dashboard) && input,
  )
  expect(dashboardPreferencesSchema.parse(saved.dashboard).order).toEqual(order)
  const client = new QueryClient()
  const hook = renderHook(() => useDashboardPreferences(), {
    wrapper: ({ children }) => createElement(QueryClientProvider, { client }, children),
  })
  expect(hook.result.current.order).toEqual(defaultOrder)
  act(() => hook.result.current.setTiles({ ...hook.result.current.tiles, fleet: false }))
  await waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(1))
  expect(mocks.write.mock.calls[0]![0].dashboard).toMatchObject(saved.dashboard)
  const reversed = [...defaultOrder].reverse()
  act(() => hook.result.current.setOrder(reversed))
  await waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(2))
  const moved = mocks.write.mock.calls[1]![0].dashboard.order
  expect(moved).toEqual([reversed[0], 'future-widget', ...reversed.slice(1), 'future-last'])
  act(() => hook.result.current.setOrder(resetViewOrder(reversed, [...defaultOrder])))
  await waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(3))
  expect(mocks.write.mock.calls[2]![0].dashboard.order).toEqual(order)
  hook.unmount()
  client.clear()
})

it('can save visibility and reorder at the 200 future-widget boundary without losing entries', async () => {
  const future = Array.from({ length: 200 }, (_, i) => 'future-' + i)
  mocks.read.mockReturnValue({ dashboard: { order: future } })
  mocks.write.mockImplementation(async (input) => {
    dashboardPreferencesInputSchema.parse(input.dashboard)
    return input
  })
  const client = new QueryClient()
  const hook = renderHook(() => useDashboardPreferences(), {
    wrapper: ({ children }) => createElement(QueryClientProvider, { client }, children),
  })
  act(() => hook.result.current.setTiles({ ...hook.result.current.tiles, fleet: false }))
  await waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(1))
  expect(
    dashboardPreferencesInputSchema.safeParse(mocks.write.mock.calls[0]![0].dashboard).success,
  ).toBe(true)
  expect(mocks.write.mock.calls[0]![0].dashboard.order).toEqual([...future, ...defaultOrder])
  act(() => hook.result.current.setOrder([...defaultOrder].reverse()))
  await waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(2))
  expect(
    dashboardPreferencesInputSchema.safeParse(mocks.write.mock.calls[1]![0].dashboard).success,
  ).toBe(true)
  expect(mocks.write.mock.calls[1]![0].dashboard.order).toEqual([
    ...future,
    ...[...defaultOrder].reverse(),
  ])
  expect(hook.result.current.failed).toBe(false)
  hook.unmount()
  client.clear()
})
