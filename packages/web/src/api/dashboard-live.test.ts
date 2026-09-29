import { createElement } from 'react'
import { renderHook, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { dashboardKeys, useDashboardTelemetry } from './dashboard'
import { dashboardLive } from './dashboard-live'
import { describe, expect, it, vi } from 'vitest'
import { createDashboardLiveStore } from './dashboard-live'
describe('dashboard samples', () => {
  it('replaces each project independently and expires server-aged samples', () => {
    let now = 0
    const store = createDashboardLiveStore(() => now)
    const sample = {
      projectId: 'a',
      runId: 'one',
      sampledAt: '2026-09-18T00:00:00.000Z',
      cpuPct: null,
      rssBytes: 10,
      procCount: 1,
    }
    store.replace('a', [sample], '2026-09-18T00:00:08.000Z')
    store.replace('b', [{ ...sample, projectId: 'b' }], sample.sampledAt)
    expect(store.getSnapshot().samples).toHaveLength(2)
    now = 2001
    store.expire()
    expect(store.getSnapshot().samples.map((s) => s.projectId)).toEqual(['b'])
    store.remove('b', 'one')
    expect(store.getSnapshot().samples).toEqual([])
  })
  it('does not treat a timestamp-free snapshot as fresh and cleans subscriber timer', () => {
    vi.useFakeTimers()
    const store = createDashboardLiveStore()
    const unsubscribe = store.subscribe(() => {})
    expect(vi.getTimerCount()).toBe(1)
    unsubscribe()
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })
})

it('never seeds telemetry from retained query data when mounting a hidden fleet', () => {
  const client = new QueryClient()
  client.setQueryData(dashboardKeys.telemetry, { asOf: '2026-09-18T00:00:00.000Z', samples: [] })
  const seed = vi.spyOn(dashboardLive, 'seed')
  renderHook(() => useDashboardTelemetry(false), {
    wrapper: ({ children }) => createElement(QueryClientProvider, { client }, children),
  })
  expect(seed).not.toHaveBeenCalled()
  cleanup()
  seed.mockRestore()
  client.clear()
})
