import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { useWebhookSubscription } from './use-webhooks'
class Stream extends EventTarget {
  static opened: Stream[] = []
  close = vi.fn()
  constructor(readonly url: string) { super(); Stream.opened.push(this) }
  send(type: string, data: string) { this.dispatchEvent(new MessageEvent(type, { data })) }
}
function Subscriber({ project, enabled = true }: { project: string; enabled?: boolean }) { useWebhookSubscription(project, enabled); return null }
afterEach(() => { cleanup(); Stream.opened = []; vi.unstubAllGlobals() })
describe('project webhook subscription lifetime', () => {
  it('opens no stream with the flag off, scopes updates and closes on project switch', () => {
    vi.stubGlobal('EventSource', Stream)
    const client = createQueryClient(); const invalidate = vi.spyOn(client, 'invalidateQueries')
    const view = render(<QueryClientProvider client={client}><Subscriber project="alpha" enabled={false} /></QueryClientProvider>)
    expect(Stream.opened).toHaveLength(0)
    view.rerender(<QueryClientProvider client={client}><Subscriber project="alpha" /></QueryClientProvider>)
    const first = Stream.opened[0]!; expect(first.url).toContain('/p/alpha/webhooks/events')
    first.send('change', '{"changeSequence":1}')
    expect(invalidate).toHaveBeenLastCalledWith({ queryKey: ['alpha', 'webhooks'] })
    invalidate.mockClear(); first.send('change', '{"changeSequence":2,"secret":"forbidden"}'); expect(invalidate).not.toHaveBeenCalled()
    view.rerender(<QueryClientProvider client={client}><Subscriber project="beta" /></QueryClientProvider>)
    expect(first.close).toHaveBeenCalledTimes(1)
    first.send('change', '{"changeSequence":3}'); expect(invalidate).not.toHaveBeenCalled()
    Stream.opened[1]!.send('resync', '{"changeSequence":0}')
    expect(invalidate).toHaveBeenLastCalledWith({ queryKey: ['beta', 'webhooks'] })
    view.unmount(); expect(Stream.opened[1]!.close).toHaveBeenCalledTimes(1)
  })
})
