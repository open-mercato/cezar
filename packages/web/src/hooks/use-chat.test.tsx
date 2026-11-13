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
})
