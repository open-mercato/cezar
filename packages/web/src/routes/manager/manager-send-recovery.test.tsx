import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MANAGER_SEND_INTERRUPTED, MANAGER_SEND_TIMEOUT_MS, resetManagerSendKeys, sendManagerMessage } from '@/api/managers'
import { createQueryClient } from '@/api/query-client'
import { Composer } from '@/components/composer/composer'
import { resetToasts, Toaster } from '@/components/ui/toaster'

// Relay incident 2026-11-15: a send in flight when the tunnel dropped never settled, so the
// composer sat on Sending… and queued every later message behind it, after the reconnect too.

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

/** Every manager POST in `hung` never answers and ignores its abort, as a dead tunnel does. */
function stubFetch(hung: Set<number>) {
  let posts = 0
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/workspace/managers/') && init?.method === 'POST') {
      posts += 1
      if (hung.has(posts)) return new Promise<Response>(() => undefined)
      return Promise.resolve(json({ ok: true, attachments: 0 }))
    }
    return Promise.resolve(json({}))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  resetManagerSendKeys()
  vi.useFakeTimers()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => {
  cleanup()
  resetToasts()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('sendManagerMessage over a dropped tunnel', () => {
  it('rejects once the send has gone unanswered too long', async () => {
    stubFetch(new Set([1]))
    const sent = sendManagerMessage('g', 'hi')
    const settled = vi.fn()
    sent.catch(settled)
    await act(async () => { await vi.advanceTimersByTimeAsync(MANAGER_SEND_TIMEOUT_MS - 1) })
    expect(settled).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    await expect(sent).rejects.toThrow(MANAGER_SEND_INTERRUPTED)
  })

  it('rejects at once when the device goes offline', async () => {
    stubFetch(new Set([1]))
    const sent = sendManagerMessage('g', 'hi')
    window.dispatchEvent(new Event('offline'))
    await expect(sent).rejects.toThrow(MANAGER_SEND_INTERRUPTED)
  })

  it('aborts the request it gave up on', async () => {
    const fetchMock = stubFetch(new Set([1]))
    const sent = sendManagerMessage('g', 'hi').catch(() => undefined)
    await act(async () => { await vi.advanceTimersByTimeAsync(MANAGER_SEND_TIMEOUT_MS) })
    await sent
    const init = fetchMock.mock.calls.find(([url]) => String(url).includes('/messages'))?.[1]
    expect(init?.signal?.aborted).toBe(true)
  })
})

describe('resending a message the server may already have', () => {
  const sentKeys = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls
      .filter(([url, init]) => String(url).includes('/messages') && (init as RequestInit | undefined)?.method === 'POST')
      .map(([, init]) => (JSON.parse(String((init as RequestInit).body)) as { idempotencyKey?: string }).idempotencyKey)

  it('carries the same key when the interrupted text is sent again', async () => {
    const fetchMock = stubFetch(new Set([1]))
    const first = sendManagerMessage('g', 'are you there?').catch(() => undefined)
    await act(async () => { await vi.advanceTimersByTimeAsync(MANAGER_SEND_TIMEOUT_MS) })
    await first
    await sendManagerMessage('g', 'are you there?')
    const [a, b] = sentKeys(fetchMock)
    expect(a).toMatch(/^[0-9a-f-]{36}$/)
    expect(b).toBe(a)
  })

  it('gives a message sent after one that landed a key of its own', async () => {
    const fetchMock = stubFetch(new Set())
    await sendManagerMessage('g', 'ok')
    await sendManagerMessage('g', 'ok')
    const [a, b] = sentKeys(fetchMock)
    expect(b).not.toBe(a)
  })

  it('gives an interrupted text a new key once another message to that manager landed', async () => {
    const fetchMock = stubFetch(new Set([1]))
    const first = sendManagerMessage('g', 'yes').catch(() => undefined)
    await act(async () => { await vi.advanceTimersByTimeAsync(MANAGER_SEND_TIMEOUT_MS) })
    await first
    await sendManagerMessage('g', 'something else')
    await sendManagerMessage('g', 'yes')
    const [a, , c] = sentKeys(fetchMock)
    expect(c).not.toBe(a)
  })

  it('keeps the key of a send still in flight when another message lands', async () => {
    const fetchMock = stubFetch(new Set([1]))
    const first = sendManagerMessage('g', 'deploy it').catch(() => undefined)
    await sendManagerMessage('g', 'chip')
    await act(async () => { await vi.advanceTimersByTimeAsync(MANAGER_SEND_TIMEOUT_MS) })
    await first
    await sendManagerMessage('g', 'deploy it')
    const [a, , c] = sentKeys(fetchMock)
    expect(c).toBe(a)
  })

  it('keeps the other interrupted key when one interrupted message is resent', async () => {
    const fetchMock = stubFetch(new Set([1, 2]))
    const sends = [sendManagerMessage('g', 'text'), sendManagerMessage('g', 'answer', undefined, 'ask-1')].map((s) => s.catch(() => undefined))
    await act(async () => { await vi.advanceTimersByTimeAsync(MANAGER_SEND_TIMEOUT_MS) })
    await Promise.all(sends)
    await sendManagerMessage('g', 'answer', undefined, 'ask-1')
    await sendManagerMessage('g', 'text')
    const [a, b, c, d] = sentKeys(fetchMock)
    expect(c).toBe(b)
    expect(d).toBe(a)
  })

  it('gives different text, or another manager, a key of its own', async () => {
    const fetchMock = stubFetch(new Set([1, 2, 3]))
    const sends = [sendManagerMessage('g', 'one'), sendManagerMessage('g', 'two'), sendManagerMessage('h', 'one')].map((s) => s.catch(() => undefined))
    await act(async () => { await vi.advanceTimersByTimeAsync(MANAGER_SEND_TIMEOUT_MS) })
    await Promise.all(sends)
    expect(new Set(sentKeys(fetchMock)).size).toBe(3)
  })

  it('sends without the key to a server that does not know it', async () => {
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      bodies.push(body)
      if ('idempotencyKey' in body) {
        return Promise.resolve(new Response(JSON.stringify({ error: "Unrecognized key: \"idempotencyKey\"" }), { status: 400, headers: { 'content-type': 'application/json' } }))
      }
      return Promise.resolve(json({ ok: true, attachments: 0 }))
    }))
    await expect(sendManagerMessage('g', 'hi')).resolves.toMatchObject({ ok: true })
    expect(bodies.map((body) => 'idempotencyKey' in body)).toEqual([true, false])
  })
})

describe('the Manager composer after a hung send', () => {
  it('gives the text back and sends the next message once reconnected', async () => {
    const fetchMock = stubFetch(new Set([1]))
    const onSubmit = vi.fn((text: string) => sendManagerMessage('g', text))
    render(
      <QueryClientProvider client={createQueryClient()}>
        <Composer onSubmit={onSubmit} slashCommands={[]} ariaLabel="Message" />
        <Toaster />
      </QueryClientProvider>,
    )
    const box = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'are you there?' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(box.value).toBe('')
    // A second message while the first hangs queues behind it, as before.
    fireEvent.change(box, { target: { value: 'hello?' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(screen.getByText('Queued — sends when the previous message lands.')).toBeTruthy()

    await act(async () => { await vi.advanceTimersByTimeAsync(MANAGER_SEND_TIMEOUT_MS) })

    // Nothing is lost and nothing is stuck: both messages are back in the box, Send works.
    expect(box.value).toBe('are you there?\nhello?')
    expect(screen.queryByText('Queued — sends when the previous message lands.')).toBeNull()
    expect(screen.getAllByText(MANAGER_SEND_INTERRUPTED).length).toBeGreaterThan(0)
    fireEvent.keyDown(box, { key: 'Enter' })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(onSubmit).toHaveBeenLastCalledWith('are you there?\nhello?', [])
    expect(box.value).toBe('')
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/messages'))).toHaveLength(2)
  })
})
