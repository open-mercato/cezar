import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'

import { useDiffComments, type DiffComment } from './diff-comments'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const C1: DiffComment = { id: 'c1', path: 'src/a.ts', side: 'new', line: 3, body: 'one', excerpt: '' }
const C2: DiffComment = { id: 'c2', path: 'src/a.ts', side: 'new', line: 9, body: 'two', excerpt: '' }

/** A server that ALWAYS answers the listing with the original comments — as a refetch answered
 *  before the clearing write would. Records every PUT. */
function stubServer(stored: DiffComment[]) {
  const puts: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
      if ((init.method ?? 'GET') === 'PUT') {
        puts.push((JSON.parse(String(init.body)) as { text: string }).text)
        return json({ text: '', images: [], updatedAt: '2026-10-05T00:00:00.000Z' })
      }
      if (path === '/api/v1/runs/r1/drafts') {
        return json({
          surfaces: { 'diff-comments': { text: JSON.stringify(stored), images: [], updatedAt: '2026-10-05T00:00:00.000Z' } },
        })
      }
      return json({})
    }),
  )
  return puts
}

function mountChangesHost() {
  const client = createQueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const changes = renderHook(() => useDiffComments('r1'), { wrapper })
  return { client, wrapper, changes }
}

describe('diff comments shared across hosts', () => {
  /** The tab switched to mid-send must see the send's outcome — not the list as it was when it
   *  mounted, and not a refetch's pre-clear copy. */
  it('a host mounted while a send is in flight sees the sent comments go', async () => {
    stubServer([C1, C2])
    const { wrapper, changes } = mountChangesHost()
    await waitFor(() => expect(changes.result.current.comments).toHaveLength(2))

    let land: (value: string) => void = () => {}
    let sending!: Promise<string>
    act(() => {
      sending = changes.result.current.submit(() => new Promise<string>((resolve) => (land = resolve)))
    })
    // The user jumps to the Session tab: a second host mounts while the send is in flight.
    changes.unmount()
    const session = renderHook(() => useDiffComments('r1'), { wrapper })
    expect(session.result.current.comments).toHaveLength(2)

    await act(async () => {
      land('delivered')
      await sending
    })
    expect(session.result.current.comments).toEqual([])
  })

  it('keeps a comment added, or edited, while the send was in flight', async () => {
    // A server that keeps what it is sent: one that ignored writes would look, to the three-way
    // merge, exactly like another window removing those comments.
    const server = statefulServer([C1, C2])
    const { changes } = mountChangesHost()
    await waitFor(() => expect(changes.result.current.comments).toHaveLength(2))

    let land: (value: string) => void = () => {}
    let sending!: Promise<string>
    act(() => {
      sending = changes.result.current.submit(() => new Promise<string>((resolve) => (land = resolve)))
    })
    act(() => {
      changes.result.current.add({ path: 'src/b.ts', side: 'new', line: 1, excerpt: 'x', body: 'added meanwhile' })
      changes.result.current.update('c2', 'two, edited after it went')
    })

    await act(async () => {
      land('delivered')
      await sending
    })
    // c1 went as it was sent; c2 changed after it was captured; the new one was never sent.
    expect(changes.result.current.comments.map((c) => c.body)).toEqual(['two, edited after it went', 'added meanwhile'])
    await waitFor(() => expect(server.stored().map((c) => c.body)).toEqual(['two, edited after it went', 'added meanwhile']))
  })

  it('a failed send keeps every comment', async () => {
    stubServer([C1, C2])
    const { changes } = mountChangesHost()
    await waitFor(() => expect(changes.result.current.comments).toHaveLength(2))

    await act(async () => {
      await changes.result.current.submit(() => Promise.reject(new Error('no'))).catch(() => {})
    })
    expect(changes.result.current.comments.map((c) => c.id)).toEqual(['c1', 'c2'])
  })
})

/** A server that keeps what it is sent — two windows of one cockpit talk to the same one. */
function statefulServer(initial: DiffComment[]) {
  let stored = JSON.stringify(initial)
  let failReads = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      if ((init.method ?? 'GET') === 'PUT') {
        stored = (JSON.parse(String(init.body)) as { text: string }).text
        return json({ text: stored, images: [], updatedAt: '2026-10-05T00:00:00.000Z' })
      }
      if (path === '/api/v1/runs/r1/drafts') {
        if (failReads) return json({ error: 'restarting' }, 503)
        return json({
          surfaces: stored === '' ? {} : { 'diff-comments': { text: stored, images: [], updatedAt: '2026-10-05T00:00:00.000Z' } },
        })
      }
      return json({})
    }),
  )
  return {
    stored: () => (stored === '' ? [] : (JSON.parse(stored) as DiffComment[])),
    failReads: (fail: boolean) => (failReads = fail),
  }
}

/** One browser window: its own query client, so its own in-memory list. */
function openWindow() {
  const client = createQueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  return { client, view: renderHook(() => useDiffComments('r1'), { wrapper }) }
}

const NEW = { path: 'src/a.ts', side: 'new' as const, excerpt: '' }

describe('diff comments across windows', () => {
  it("a window's save never wipes what another window added", async () => {
    const server = statefulServer([])
    const a = openWindow()
    const b = openWindow()
    await waitFor(() => expect(a.view.result.current.ready && b.view.result.current.ready).toBe(true))

    act(() => {
      a.view.result.current.add({ ...NEW, line: 1, body: 'from A, one' })
      a.view.result.current.add({ ...NEW, line: 2, body: 'from A, two' })
      a.view.result.current.add({ ...NEW, line: 3, body: 'from A, three' })
    })
    await waitFor(() => expect(server.stored()).toHaveLength(3))

    // B was seeded with the empty list before A wrote anything.
    act(() => {
      b.view.result.current.add({ ...NEW, line: 9, body: 'from B' })
    })
    await waitFor(() => expect(server.stored().map((c) => c.body).sort()).toEqual(['from A, one', 'from A, three', 'from A, two', 'from B']))
    // …and B now shows A's comments too.
    await waitFor(() => expect(b.view.result.current.comments).toHaveLength(4))
  })

  it('a comment removed here is not merged back from the server', async () => {
    const seeded: DiffComment[] = [
      { id: 'k1', path: 'src/a.ts', side: 'new', line: 1, body: 'keep', excerpt: '' },
      { id: 'g1', path: 'src/a.ts', side: 'new', line: 2, body: 'gone', excerpt: '' },
    ]
    const server = statefulServer(seeded)
    const a = openWindow()
    await waitFor(() => expect(a.view.result.current.comments).toHaveLength(2))

    act(() => a.view.result.current.remove('g1'))
    await waitFor(() => expect(server.stored().map((c) => c.id)).toEqual(['k1']))
    expect(a.view.result.current.comments.map((c) => c.id)).toEqual(['k1'])
  })

  it('keeps offering "+" when a later refetch of the drafts fails', async () => {
    const server = statefulServer([])
    const a = openWindow()
    await waitFor(() => expect(a.view.result.current.ready).toBe(true))

    server.failReads(true)
    await act(async () => {
      await a.client.invalidateQueries()
    })
    // The refetch really did fail — the case this pins.
    const draftsQuery = a.client.getQueryCache().getAll().find((q) => q.queryKey.includes('drafts'))
    expect(draftsQuery?.state.status).toBe('error')
    // Let the hook re-render with the failed state before judging it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(a.view.result.current.ready).toBe(true)
  })

  // The review's reproduction (#1283): a comment sent or removed in one window must not come back
  // through another window's next save.
  const OLD: DiffComment = { id: 'old', path: 'src/a.ts', side: 'new', line: 1, body: 'old', excerpt: '' }

  it('a comment SENT in one window is not written back by another window’s next save', async () => {
    const server = statefulServer([OLD])
    const a = openWindow()
    const b = openWindow()
    await waitFor(() => expect(a.view.result.current.comments).toHaveLength(1))
    await waitFor(() => expect(b.view.result.current.comments).toHaveLength(1))

    await act(async () => {
      await a.view.result.current.submit(async () => 'delivered')
    })
    await waitFor(() => expect(server.stored()).toEqual([]))

    act(() => {
      b.view.result.current.add({ ...NEW, line: 5, body: 'new in B' })
    })
    await waitFor(() => expect(server.stored().map((c) => c.body)).toEqual(['new in B']))
    expect(b.view.result.current.comments.map((c) => c.body)).toEqual(['new in B'])
  })

  it('a comment REMOVED in one window is not restored by another window’s next save', async () => {
    const server = statefulServer([OLD])
    const a = openWindow()
    const b = openWindow()
    await waitFor(() => expect(b.view.result.current.comments).toHaveLength(1))
    await waitFor(() => expect(a.view.result.current.comments).toHaveLength(1))

    act(() => a.view.result.current.remove('old'))
    await waitFor(() => expect(server.stored()).toEqual([]))

    act(() => {
      b.view.result.current.add({ ...NEW, line: 5, body: 'new in B' })
    })
    await waitFor(() => expect(server.stored().map((c) => c.body)).toEqual(['new in B']))
  })

  it('coming back to a window drops a chip another window already sent', async () => {
    statefulServer([OLD])
    const a = openWindow()
    const b = openWindow()
    await waitFor(() => expect(b.view.result.current.comments).toHaveLength(1))
    await waitFor(() => expect(a.view.result.current.comments).toHaveLength(1))

    await act(async () => {
      await a.view.result.current.submit(async () => 'delivered')
    })
    // B has no unsaved change; focusing it re-reads the listing and merges the send in.
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(b.view.result.current.comments).toEqual([]))
  })

  it('takes another window’s edit of a comment this window did not touch', async () => {
    const server = statefulServer([OLD])
    const a = openWindow()
    const b = openWindow()
    await waitFor(() => expect(b.view.result.current.comments).toHaveLength(1))
    await waitFor(() => expect(a.view.result.current.comments).toHaveLength(1))

    act(() => a.view.result.current.update('old', 'edited in A'))
    await waitFor(() => expect(server.stored()[0]?.body).toBe('edited in A'))
    act(() => {
      b.view.result.current.add({ ...NEW, line: 5, body: 'new in B' })
    })
    await waitFor(() => expect(server.stored().map((c) => c.body)).toEqual(['edited in A', 'new in B']))
  })
})
