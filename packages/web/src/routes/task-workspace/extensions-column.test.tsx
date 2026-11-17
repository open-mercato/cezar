import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, renderHook, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { EXTENSION_PANEL_REFETCH_DEBOUNCE_MS, extensionKeys } from '@/api/extensions'
import type { ApiRun } from '@open-mercato/cezar-api-client'

import { ExtensionsColumn, useExtensionTaskView, type ExtensionTaskView } from './extensions-column'

/** The task view's liveness (spec 2026-11-07-extension-placements, "Data flow and liveness"): the run's SSE patches refetch
 *  its task panels, debounced, and only while the view has something to show. */

vi.mock('@/api/queries', async (original) => ({
  ...(await original<typeof import('@/api/queries')>()),
  useHealth: () => ({ data: { capabilities: { extensions: true } } }),
}))
vi.mock('@/api/extensions', async (original) => ({
  ...(await original<typeof import('@/api/extensions')>()),
  useExtensionPlacements: (_projectId: string, _location: string, enabled: boolean) => ({
    data: enabled && placementsEnabled ? { available: true, extensions: [{ extensionId: 'example', name: 'Example', status: 'running', panels: [{ id: 'notes', title: 'Notes', location: 'task' }], commands: [] }] } : undefined,
  }),
}))
let placementsEnabled = true

const run = (status: ApiRun['status']): ApiRun => ({
  id: 'r1', title: 't', workflow: 'quick-task', task: 't', status, createdAt: '2026-07-15T08:00:00.000Z', tokensUsed: 0, archived: false, steps: [],
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  placementsEnabled = true
})

describe('useExtensionTaskView', () => {
  function mount(initial: ApiRun) {
    const client = new QueryClient()
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue()
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    const hook = renderHook(({ current }: { current: ApiRun }) => useExtensionTaskView('alpha', current), { wrapper, initialProps: { current: initial } })
    return { ...hook, invalidate }
  }

  it('refetches this run’s task panels once the run’s patches settle, not per patch', () => {
    vi.useFakeTimers()
    const { result, rerender, invalidate } = mount(run('running'))
    expect(result.current.available).toBe(true)
    // Every patched record is a new object; three in quick succession are one refetch.
    rerender({ current: run('running') })
    rerender({ current: run('running') })
    rerender({ current: run('review') })
    vi.advanceTimersByTime(EXTENSION_PANEL_REFETCH_DEBOUNCE_MS - 1)
    expect(invalidate).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: extensionKeys.taskPanels('alpha', 'r1') })
  })

  it('does nothing while no extension contributes to the task view', () => {
    vi.useFakeTimers()
    placementsEnabled = false
    const { result, rerender, invalidate } = mount(run('running'))
    expect(result.current.available).toBe(false)
    rerender({ current: run('review') })
    vi.advanceTimersByTime(EXTENSION_PANEL_REFETCH_DEBOUNCE_MS * 2)
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('resolves a missing project scope to the boot alias', () => {
    const client = new QueryClient()
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    const { result } = renderHook(() => useExtensionTaskView(null, run('done')), { wrapper })
    expect(result.current.projectId).toBe('default')
  })
  it('returns the same view while nothing it carries changed', () => {
    placementsEnabled = false
    const { result, rerender } = mount(run('running'))
    const first = result.current
    rerender({ current: run('running') })
    expect(result.current).toBe(first)
  })
})

describe('ExtensionsColumn', () => {
  const view = (extensions: ExtensionTaskView['extensions']): ExtensionTaskView =>
    ({ projectId: 'beta', extensions, available: extensions.length > 0, result: undefined, show: () => {}, dismiss: () => {} })
  const settle = (node: ReactNode) => render(<QueryClientProvider client={new QueryClient()}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>)

  it('links the empty state to Settings → Extensions for this task\'s project', () => {
    settle(<ExtensionsColumn view={view([])} run={run('done')} />)
    expect(screen.getByRole('link', { name: 'Open Settings → Extensions' }).getAttribute('href')).toBe('/settings/global/extensions?project=beta')
  })
  it('links a failed worker to its row in this task\'s project', () => {
    const failed = { extensionId: 'broken', name: 'Broken', status: 'failed', error: 'exit 1', panels: [], commands: [] } as unknown as ExtensionTaskView['extensions'][number]
    settle(<ExtensionsColumn view={view([failed])} run={run('done')} />)
    expect(screen.getByRole('link', { name: 'Open Settings → Extensions' }).getAttribute('href')).toBe('/settings/global/extensions?project=beta&extension=broken')
  })
})
