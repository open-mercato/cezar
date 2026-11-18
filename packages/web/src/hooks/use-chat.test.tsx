import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { telegramDescriptor } from '@/lib/chat-providers/telegram'
import type { ChatProviderDescriptor } from '@/lib/chat-providers'
import { useChatSubscription } from './use-chat'

afterEach(cleanup)
const rebuilt = (subscribe: ChatProviderDescriptor['bot']['subscribe'], id = 'telegram'): ChatProviderDescriptor =>
  ({ ...telegramDescriptor, id, bot: { ...telegramDescriptor.bot, subscribe } }) as ChatProviderDescriptor
function Subscriber({ provider }: { provider: ChatProviderDescriptor }) { useChatSubscription('alpha', true, provider); return null }

it('keeps one subscription while the descriptor object is rebuilt, and moves it when the provider id changes', () => {
  const unsubscribe = vi.fn(), subscribe = vi.fn((_changed: () => void) => unsubscribe)
  const client = new QueryClient(), invalidate = vi.spyOn(client, 'invalidateQueries')
  const show = (provider: ChatProviderDescriptor) => <QueryClientProvider client={client}><Subscriber provider={provider} /></QueryClientProvider>
  const view = render(show(rebuilt(subscribe)))
  view.rerender(show(rebuilt(subscribe)))
  view.rerender(show(rebuilt(vi.fn(subscribe))))
  expect(subscribe).toHaveBeenCalledTimes(1)
  expect(unsubscribe).not.toHaveBeenCalled()
  subscribe.mock.calls[0]![0]()
  expect(invalidate).toHaveBeenLastCalledWith({ queryKey: ['alpha', 'telegram-inbound'] })
  view.rerender(show(rebuilt(subscribe, 'acme/chat')))
  expect(unsubscribe).toHaveBeenCalledTimes(1)
  expect(subscribe).toHaveBeenCalledTimes(2)
  view.unmount()
  expect(unsubscribe).toHaveBeenCalledTimes(2)
})
