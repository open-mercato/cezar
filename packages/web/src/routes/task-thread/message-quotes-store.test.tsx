import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { toast } from '@/components/ui/toaster'
import type { MessageQuote } from '@/lib/message-quotes'

import { useDraftList } from './diff-comments'
import { parseStoredQuotes, useMessageQuotes } from './message-quotes-store'

vi.mock('@/components/ui/toaster', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/toaster')>()),
  toast: vi.fn(),
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.mocked(toast).mockClear()
})

const Q1: MessageQuote = { id: 'q1', ref: 1, role: 'assistant', excerpt: 'first', code: false, body: 'one' }
const Q2: MessageQuote = { id: 'q2', ref: 2, role: 'assistant', excerpt: 'second', code: false, body: 'two' }
const capture = (excerpt: string) => ({ ref: 5, role: 'assistant' as const, excerpt, code: false })

/** A server that keeps what it is sent — two windows of one cockpit talk to the same one. */
function statefulServer(initial: MessageQuote[]) {
  let stored = initial.length ? JSON.stringify(initial) : ''
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
      if ((init.method ?? 'GET') === 'PUT') {
        stored = (JSON.parse(String(init.body)) as { text: string }).text
        return json({ text: stored, images: [], updatedAt: '2026-11-20T00:00:00.000Z' })
      }
      if (String(input) === '/api/v1/runs/r1/drafts') {
        return json({ surfaces: stored === '' ? {} : { 'message-quotes': { text: stored, images: [], updatedAt: '2026-11-20T00:00:00.000Z' } } })
      }
      return json({})
    }),
  )
  return { stored: () => (stored === '' ? [] : (JSON.parse(stored) as MessageQuote[])) }
}

function openWindow() {
  const client = createQueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  return renderHook(() => useMessageQuotes('r1'), { wrapper })
}

describe('message quote drafts', () => {
  it("merges across windows: one window's save keeps the other's quotes", async () => {
    const server = statefulServer([])
    const a = openWindow()
    const b = openWindow()
    await waitFor(() => expect(a.result.current.ready && b.result.current.ready).toBe(true))

    act(() => void a.result.current.add(capture('from A')))
    await waitFor(() => expect(server.stored()).toHaveLength(1))
    // B was seeded with the empty list before A wrote anything.
    act(() => void b.result.current.add(capture('from B')))
    await waitFor(() => expect(server.stored().map((q) => q.excerpt).sort()).toEqual(['from A', 'from B']))
    await waitFor(() => expect(b.result.current.quotes).toHaveLength(2))
  })

  it('a send carries only what the host allows and drops only that (cross-window merges can exceed 12)', async () => {
    // Stored lists are capped on read, so the over-cap list a merge can build is seeded through
    // the generic store with a tighter sendable rule.
    statefulServer([Q1, Q2])
    const client = createQueryClient()
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    const view = renderHook(() => useDraftList('r1', 'message-quotes', parseStoredQuotes, 'too many', (items) => items.slice(0, 1)), { wrapper })
    await waitFor(() => expect(view.result.current.items).toHaveLength(2))
    let carried: string[] = []
    await act(async () => {
      await view.result.current.submit(async (held) => { carried = held.map((q) => q.id) })
    })
    expect(carried).toEqual(['q1'])
    await waitFor(() => expect(view.result.current.items.map((q) => q.id)).toEqual(['q2']))
  })

  it('a failed send keeps every quote', async () => {
    const server = statefulServer([Q1, Q2])
    const view = openWindow()
    await waitFor(() => expect(view.result.current.quotes).toHaveLength(2))

    await act(async () => {
      await view.result.current.submit(() => Promise.reject(new Error('no'))).catch(() => {})
    })
    expect(view.result.current.quotes.map((q) => q.id)).toEqual(['q1', 'q2'])
    expect(server.stored().map((q) => q.id)).toEqual(['q1', 'q2'])
  })

  it('keeps a quote added, or a note edited, while the send was in flight', async () => {
    const server = statefulServer([Q1, Q2])
    const view = openWindow()
    await waitFor(() => expect(view.result.current.quotes).toHaveLength(2))

    let land: (value: string) => void = () => {}
    let sending!: Promise<string>
    act(() => {
      sending = view.result.current.submit(() => new Promise<string>((resolve) => (land = resolve)))
    })
    act(() => {
      view.result.current.add(capture('added meanwhile'))
      view.result.current.update({ ...Q2, body: 'two, edited after it went' })
    })
    await act(async () => {
      land('delivered')
      await sending
    })
    // q1 went as it was sent; q2 changed after it was captured; the new one was never sent.
    expect(view.result.current.quotes.map((q) => q.excerpt)).toEqual(['second', 'added meanwhile'])
    await waitFor(() => expect(server.stored().map((q) => q.excerpt)).toEqual(['second', 'added meanwhile']))
  })

  it('refuses a 13th quote with a toast, and ignores a duplicate silently', async () => {
    const twelve = Array.from({ length: 12 }, (_, i): MessageQuote => ({ id: `q${i}`, ref: i, role: 'assistant', excerpt: `quote ${i}`, code: false, body: '' }))
    const server = statefulServer(twelve)
    const view = openWindow()
    await waitFor(() => expect(view.result.current.quotes).toHaveLength(12))

    let added: boolean | undefined
    act(() => { added = view.result.current.add({ ref: 3, role: 'assistant', excerpt: 'quote 3', code: false }) })
    expect(added).toBe(true)
    expect(toast).not.toHaveBeenCalled()

    act(() => { added = view.result.current.add(capture('one too many')) })
    expect(added).toBe(false)
    expect(toast).toHaveBeenCalledWith('Up to 12 quotes per message — send these first.', { tone: 'danger' })
    expect(view.result.current.quotes).toHaveLength(12)
    expect(server.stored()).toHaveLength(12)
  })

  it('keeps every quote of a cross-window merge past 12: reading and editing never trim, the send does', async () => {
    const thirteen = Array.from({ length: 13 }, (_, i): MessageQuote => ({ id: `q${i}`, ref: i, role: 'assistant', excerpt: `quote ${i}`, code: false, body: '' }))
    expect(parseStoredQuotes(JSON.stringify(thirteen))).toHaveLength(13)
    const server = statefulServer(thirteen)
    const view = openWindow()
    await waitFor(() => expect(view.result.current.quotes).toHaveLength(13))

    act(() => { view.result.current.update({ ...thirteen[0]!, body: 'a note' }) })
    expect(view.result.current.quotes).toHaveLength(13)
    await waitFor(() => expect(server.stored()).toHaveLength(13))

    let carried: readonly MessageQuote[] = []
    await act(async () => { await view.result.current.submit(async (quotes) => { carried = quotes }) })
    expect(carried).toHaveLength(12)
    expect(view.result.current.quotes.map((q) => q.id)).toEqual(['q12'])
  })
})

