import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setApiScope, type UiState } from '@open-mercato/cezar-api-client'
import { putUiState } from '@/api/client'
import { toast } from '@/components/ui/toaster'
import { useAutomationOrder } from './use-automation-order'

vi.mock('@/api/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/client')>(),
  getUiState: vi.fn(async () => ({})),
  putUiState: vi.fn(async (patch: UiState) => patch),
}))
vi.mock('@/components/ui/toaster', () => ({ toast: vi.fn() }))

beforeEach(() => {
  setApiScope(null)
  vi.mocked(putUiState).mockReset().mockImplementation(async (patch) => patch)
  vi.mocked(toast).mockClear()
})
afterEach(() => { cleanup(); setApiScope(null) })

function setup(initial?: UiState) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  if (initial !== undefined) client.setQueryData(['default', 'ui-state'], initial)
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  return { ...renderHook(() => useAutomationOrder(), { wrapper }), client }
}

describe('project automation ordering persistence', () => {
  it('does not write before the first authoritative preference read', () => {
    const { result } = setup()
    expect(result.current.canSave).toBe(false)
    act(() => result.current.setSort('manual'))
    expect(putUiState).not.toHaveBeenCalled()
  })

  it('preserves manual order and forward-compatible siblings when changing sort', async () => {
    const { result, client } = setup({ runsView: 'table', automationList: { sort: 'manual', order: ['b', 'a'], future: 'keep' } })
    act(() => result.current.setSort('nextRun'))
    await waitFor(() => expect(putUiState).toHaveBeenCalledWith({
      automationList: { sort: 'nextRun', order: ['b', 'a'], future: 'keep' },
    }, 'default'))
    expect(client.getQueryData<UiState>(['default', 'ui-state'])?.automationList?.order).toEqual(['b', 'a'])
  })

  it('serializes rapid writes and never restores an older optimistic preference', async () => {
    let finish!: (value: UiState) => void
    vi.mocked(putUiState).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const { result, client } = setup({ automationList: { sort: 'manual', order: ['a', 'b'] } })
    act(() => { result.current.setOrder(['b', 'a']); result.current.setSort('name') })
    await waitFor(() => expect(putUiState).toHaveBeenCalledTimes(1))
    expect(client.getQueryData<UiState>(['default', 'ui-state'])?.automationList?.sort).toBe('name')
    await act(async () => finish({ automationList: { sort: 'manual', order: ['b', 'a'] } }))
    await waitFor(() => expect(putUiState).toHaveBeenCalledTimes(2))
    expect(vi.mocked(putUiState).mock.calls[1]).toEqual([{ automationList: { sort: 'name', order: ['b', 'a'] } }, 'default'])
    expect(client.getQueryData<UiState>(['default', 'ui-state'])?.automationList?.sort).toBe('name')
  })

  it('captures the old project for queued requests and cache responses', async () => {
    let finish!: (value: UiState) => void
    vi.mocked(putUiState).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const { result, client, rerender } = setup({})
    act(() => { result.current.setSort('manual'); result.current.setOrder(['b', 'a']) })
    await waitFor(() => expect(putUiState).toHaveBeenCalledTimes(1))
    client.setQueryData(['another-project', 'ui-state'], { automationList: { sort: 'nextRun' } })
    setApiScope('another-project')
    rerender()
    await act(async () => finish({ automationList: { sort: 'manual', order: [] } }))
    await waitFor(() => expect(putUiState).toHaveBeenCalledTimes(2))
    expect(vi.mocked(putUiState).mock.calls[1]?.[1]).toBe('default')
    expect(client.getQueryData<UiState>(['another-project', 'ui-state'])?.automationList?.sort).toBe('nextRun')
  })

  it('keeps a save serialized when the list is left and reopened', async () => {
    let finish!: (value: UiState) => void
    vi.mocked(putUiState).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const first = setup({})
    act(() => first.result.current.setSort('manual'))
    await waitFor(() => expect(putUiState).toHaveBeenCalledTimes(1))
    first.unmount()
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={first.client}>{children}</QueryClientProvider>
    const reopened = renderHook(() => useAutomationOrder(), { wrapper })
    act(() => reopened.result.current.setSort('nextRun'))
    expect(putUiState).toHaveBeenCalledTimes(1)
    await act(async () => finish({ automationList: { sort: 'manual', order: [] } }))
    await waitFor(() => expect(putUiState).toHaveBeenCalledTimes(2))
    expect(first.client.getQueryData<UiState>(['default', 'ui-state'])?.automationList?.sort).toBe('nextRun')
  })

  it('reports a failed save and invalidates only the captured project', async () => {
    vi.mocked(putUiState).mockRejectedValueOnce(new Error('disk full'))
    const { result, client } = setup({ automationList: { sort: 'name' } })
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    act(() => result.current.setSort('manual'))
    await waitFor(() => expect(toast).toHaveBeenCalledWith('disk full', { tone: 'danger' }))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['default', 'ui-state'] })
  })
})
