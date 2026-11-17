import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatProviderDescriptor } from '@/lib/chat-providers'

const health = vi.hoisted(() => ({ data: undefined as { capabilities: { localHandoff: boolean } } | undefined }))
vi.mock('@/api/queries', () => ({ useHealth: () => ({ data: health.data }) }))

import { useChatSubscription, useChatSubscriptions } from './use-chat'

const subscribe = vi.fn(() => () => undefined)
const provider = { id: 'telegram', bot: { subscribe } } as unknown as ChatProviderDescriptor
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: new QueryClient() }, children)

describe('chat subscriptions', () => {
  beforeEach(() => { subscribe.mockClear(); health.data = undefined })

  it('subscribes once health arrives after mount on a local cockpit', () => {
    const { rerender } = renderHook(() => useChatSubscription('p', true, provider), { wrapper })
    expect(subscribe).not.toHaveBeenCalled()
    health.data = { capabilities: { localHandoff: true } }
    rerender()
    expect(subscribe).toHaveBeenCalledTimes(1)
  })

  it('opens no WebSocket subscription on a hosted cockpit', () => {
    health.data = { capabilities: { localHandoff: false } }
    renderHook(() => useChatSubscriptions('p', [provider]), { wrapper })
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('subscribes the gallery once health arrives', () => {
    const { rerender } = renderHook(() => useChatSubscriptions('p', [provider]), { wrapper })
    health.data = { capabilities: { localHandoff: true } }
    rerender()
    expect(subscribe).toHaveBeenCalledTimes(1)
  })

  it('keeps one subscription while the descriptor object is rebuilt, and moves it when the provider id changes', () => {
    health.data = { capabilities: { localHandoff: true } }
    const unsubscribe = vi.fn(), listen = vi.fn((_changed: () => void) => unsubscribe)
    const client = new QueryClient(), invalidate = vi.spyOn(client, 'invalidateQueries')
    const own = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
    const rebuilt = (bind: typeof listen, id = 'telegram') => ({ id, bot: { subscribe: bind } }) as unknown as ChatProviderDescriptor
    const view = renderHook((p: ChatProviderDescriptor) => useChatSubscription('alpha', true, p), { wrapper: own, initialProps: rebuilt(listen) })
    view.rerender(rebuilt(listen))
    view.rerender(rebuilt(vi.fn(listen)))
    expect(listen).toHaveBeenCalledTimes(1)
    expect(unsubscribe).not.toHaveBeenCalled()
    listen.mock.calls[0]![0]()
    expect(invalidate).toHaveBeenLastCalledWith({ queryKey: ['alpha', 'telegram-inbound'] })
    view.rerender(rebuilt(listen, 'acme/chat'))
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(listen).toHaveBeenCalledTimes(2)
    view.unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(2)
  })
})
