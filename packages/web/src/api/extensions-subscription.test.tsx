import { QueryClient, QueryClientProvider, hashKey, hydrate } from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useExtensionSubscription } from './extensions'
import { queryKeys } from './queries'
import { subscribeTopic } from './ws'

vi.mock('./ws', () => ({ subscribeTopic: vi.fn(() => () => {}) }))
afterEach(() => { cleanup(); vi.mocked(subscribeTopic).mockClear() })

/** The topic is local-only: a hosted cockpit (extensions capability off) opens no browser socket. */
function mount(extensions: boolean | undefined) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  client.setQueryData(queryKeys.health, { capabilities: { localHandoff: extensions === true, extensions } } as never)
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  return { client, ...renderHook(() => useExtensionSubscription(), { wrapper }) }
}

describe('useExtensionSubscription', () => {
  it('subscribes only when the cockpit reports extensions as available', () => {
    mount(true)
    expect(subscribeTopic).toHaveBeenCalledWith('extensions', expect.any(Function))
  })
  it('re-reads every project\'s extension queries on a change frame', () => {
    const { client } = mount(true)
    for (const projectId of ['alpha', 'beta']) client.setQueryData(['extensions', projectId, 'list'], { extensions: [] })
    vi.mocked(subscribeTopic).mock.calls[0]![1]({ changed: true })
    for (const projectId of ['alpha', 'beta']) expect(client.getQueryState(['extensions', projectId, 'list'])?.isInvalidated).toBe(true)
  })
  it('subscribes once health arrives after mount, and releases when extensions turn off', () => {
    const { client } = mount(undefined)
    expect(subscribeTopic).not.toHaveBeenCalled()
    const release = vi.fn()
    vi.mocked(subscribeTopic).mockReturnValueOnce(release)
    act(() => { client.setQueryData(queryKeys.health, { capabilities: { localHandoff: true, extensions: true } } as never) })
    expect(subscribeTopic).toHaveBeenCalledTimes(1)
    act(() => { client.setQueryData(queryKeys.health, { capabilities: { localHandoff: true, extensions: false } } as never) })
    expect(release).toHaveBeenCalledTimes(1)
  })
  it('ignores cache events of every query but health', () => {
    const { client } = mount(true)
    const read = vi.spyOn(client, 'getQueryData')
    act(() => { for (let index = 0; index < 5; index += 1) client.setQueryData(['runs', index], { index }) })
    expect(read).not.toHaveBeenCalled()
  })
  it('releases a topic opened on hydrated health once the live answer turns extensions off', () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
    const release = vi.fn()
    vi.mocked(subscribeTopic).mockReturnValueOnce(release)
    hydrate(client, { mutations: [], queries: [{ queryKey: queryKeys.health, queryHash: hashKey(queryKeys.health), state: { data: { capabilities: { localHandoff: true, extensions: true } }, dataUpdatedAt: 1, status: 'success' } as never }] })
    renderHook(() => useExtensionSubscription(), { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> })
    expect(subscribeTopic).toHaveBeenCalledTimes(1)
    act(() => { client.setQueryData(queryKeys.health, { capabilities: { localHandoff: true, extensions: false } } as never) })
    expect(release).toHaveBeenCalledTimes(1)
  })
  it('opens no topic on a hosted cockpit or before health answered', () => {
    mount(false)
    mount(undefined)
    expect(subscribeTopic).not.toHaveBeenCalled()
  })
})
