import { afterEach, expect, it, vi } from 'vitest'
import { lazyChatTransport } from './host.ts'
import { ChatTransportError, type ChatTransport } from './provider.ts'
import type { ChatConnectionOptions, ChatHealth, ReceiveJournal } from './connection.ts'

afterEach(() => { vi.useRealTimers() })
const journal = {} as ReceiveJournal
function harness(failures: unknown[]) {
  const started = vi.fn(), health: ChatHealth['state'][] = []
  const transport = { guarded: () => transport, connect: () => ({ start: started, stop: async () => {}, health: () => ({ state: 'polling' as const }) }) } as unknown as ChatTransport
  let calls = 0
  const resolve = async () => { const failure = failures[calls++]; if (failure) throw failure; return transport }
  const options = { onHealth: (value: ChatHealth) => { health.push(value.state) } } as ChatConnectionOptions
  const connection = lazyChatTransport(resolve, () => true).connect(journal, options)
  return { connection, started, health, calls: () => calls }
}

// A locked vault or a restarting worker at connect time must back off, never stop the bot durably.
it.each([['a transient transport error', new ChatTransportError({ kind: 'transient' })], ['an error without a ChatFailure', new Error('extension stopped')]])(
  'retries the connect after %s', async (_name, failure) => {
    vi.useFakeTimers()
    const h = harness([failure, failure])
    h.connection.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.health).toEqual(['backoff'])
    expect(h.connection.health()).toEqual({ state: 'backoff' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.calls()).toBe(2)
    await vi.advanceTimersByTimeAsync(1999)
    expect(h.started).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(h.started).toHaveBeenCalledOnce()
    expect(h.health).not.toContain('blocked')
    await h.connection.stop()
  })

it('reports revoked credentials as credentials-unavailable and stops retrying after stop', async () => {
  vi.useFakeTimers()
  const auth = harness([new ChatTransportError({ kind: 'auth' })])
  auth.connection.start(); await vi.advanceTimersByTimeAsync(0)
  expect(auth.health).toEqual(['credentials-unavailable'])
  const pending = harness([new ChatTransportError({ kind: 'transient' })])
  pending.connection.start(); await vi.advanceTimersByTimeAsync(0)
  await pending.connection.stop()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(pending.calls()).toBe(1)
})

it('clamps a rate-limited connect retry to at least one second', async () => {
  vi.useFakeTimers()
  const h = harness([new ChatTransportError({ kind: 'rate_limited', retryAfterMs: 0 })])
  h.connection.start()
  await vi.advanceTimersByTimeAsync(999)
  expect(h.calls()).toBe(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(h.calls()).toBe(2)
  await h.connection.stop()
})
