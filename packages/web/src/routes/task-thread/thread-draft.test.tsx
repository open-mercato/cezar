import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { DraftEntry, RunDraftsResponse } from '@open-mercato/cezar-api-client'
import type { PendingAttachment } from '@/components/composer/composer-attachments'

import { DRAFT_WRITE_DEBOUNCE_MS, useDraft } from './thread-draft'

/**
 * `useDraft` (#939) — the four rules that decide whether a half-written message survives:
 * seed once and never fight the typist, write behind one debounce, flush on the way out, and
 * clear only when the message really went.
 */

const fetchMock = vi.fn<typeof fetch>()

interface Call {
  method: string
  url: string
  body: unknown
}

let calls: Call[]
/** What `GET /runs/:id/drafts` answers, per run. */
let stored: Record<string, RunDraftsResponse>
/** When set, the draft GET waits on it — the "slow fetch, user typed first" case. */
let holdGet: Promise<void> | null

beforeEach(() => {
  calls = []
  stored = {}
  holdGet = null
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
    calls.push({ method, url, body })
    const listing = /^\/api\/v1\/runs\/([^/]+)\/drafts$/.exec(url)
    if (listing && method === 'GET') {
      if (holdGet !== null) await holdGet
      return json(stored[listing[1]!] ?? { surfaces: {} })
    }
    if (/\/drafts\/[^/]+\/images$/.test(url) && method === 'POST') {
      return json({ id: 'img1', mediaType: 'image/png', name: 'shot.png', bytes: 12 })
    }
    if (/\/drafts\/[^/]+\/images\/[^/]+$/.test(url) && method === 'GET') {
      return json({ id: 'img1', mediaType: 'image/png', name: 'shot.png', bytes: 12, data: 'AAA' })
    }
    // Every other route is a draft write; the real one echoes the entry it stored.
    const written = (body ?? {}) as { text?: string; images?: string[] }
    return json({
      text: written.text ?? '',
      images: (written.images ?? []).map((id) => ({ id, mediaType: 'image/png', name: 'shot.png', bytes: 12 })),
      updatedAt: '2026-08-30T00:00:00.000Z',
    } satisfies DraftEntry)
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function wrapper() {
  const client = createQueryClient()
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
}

const entry = (text: string, images: DraftEntry['images'] = []): DraftEntry => ({
  text,
  images,
  updatedAt: '2026-08-30T00:00:00.000Z',
})

const writes = () => calls.filter((c) => c.method === 'PUT')

describe('useDraft', () => {
  it('seeds the input from the stored draft', async () => {
    stored.r1 = { surfaces: { composer: entry('half a sentence') } }
    const { result } = renderHook(() => useDraft('r1', 'composer'), { wrapper: wrapper() })

    await waitFor(() => expect(result.current.text).toBe('half a sentence'))
    expect(result.current.hasDraft).toBe(true)
  })

  it('starts empty when the task has no draft', async () => {
    const { result } = renderHook(() => useDraft('r1', 'composer'), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.text).toBe('')
    expect(writes()).toHaveLength(0)
  })

  it('survives a body that is not a draft listing — the input just stays empty', async () => {
    // Untrusted input: a proxy, an older server, a hand-edited file. Degrading is the rule; the
    // alternative here is a TypeError thrown inside a passive effect, which takes the thread down.
    stored.r1 = { surfaces: { composer: { nonsense: true } } } as unknown as RunDraftsResponse
    const { result } = renderHook(() => useDraft('r1', 'composer'), { wrapper: wrapper() })

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.text).toBe('')
    expect(result.current.images).toEqual([])
  })

  it('writes ONCE after the typing pause, not once per keystroke', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useDraft('r1', 'composer'), { wrapper: wrapper() })

    for (const text of ['h', 'he', 'hel', 'hell', 'hello']) {
      act(() => result.current.setText(text))
      await act(() => vi.advanceTimersByTimeAsync(DRAFT_WRITE_DEBOUNCE_MS / 5))
    }
    expect(writes()).toHaveLength(0)

    await act(() => vi.advanceTimersByTimeAsync(DRAFT_WRITE_DEBOUNCE_MS))
    expect(writes()).toHaveLength(1)
    expect(writes()[0]).toMatchObject({
      url: '/api/v1/runs/r1/drafts/composer',
      body: { text: 'hello', images: [] },
    })
  })

  it('a late GET never overwrites what the user already typed', async () => {
    stored.r1 = { surfaces: { composer: entry('what the server remembered') } }
    let release!: () => void
    holdGet = new Promise<void>((resolve) => {
      release = resolve
    })
    const { result } = renderHook(() => useDraft('r1', 'composer'), { wrapper: wrapper() })

    // The answer is still in flight; the user is already typing.
    act(() => result.current.setText('what the user is typing'))
    await act(async () => {
      release()
      await holdGet
    })

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.text).toBe('what the user is typing')
  })

  it('a GET still in flight when typing began never becomes the text a later remount restores', async () => {
    vi.useFakeTimers()
    stored.r1 = { surfaces: { composer: entry('what the server remembered') } }
    let release!: () => void
    holdGet = new Promise<void>((resolve) => {
      release = resolve
    })
    // One client across both mounts — the same cache the cockpit keeps while you visit another
    // task and come back.
    const client = createQueryClient()
    const shared = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )

    const first = renderHook(() => useDraft('r1', 'composer'), { wrapper: shared })
    act(() => first.result.current.setText('what the user typed'))
    // The stale answer lands AFTER the user started typing, and the write lands after that.
    await act(async () => {
      release()
      await holdGet
    })
    await act(() => vi.advanceTimersByTimeAsync(DRAFT_WRITE_DEBOUNCE_MS))
    first.unmount()

    holdGet = null
    const second = renderHook(() => useDraft('r1', 'composer'), { wrapper: shared })
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(second.result.current.text).toBe('what the user typed')
  })

  it('flushes the pending write on unmount — a route change must not drop the last edit', async () => {
    vi.useFakeTimers()
    const { result, unmount } = renderHook(() => useDraft('r1', 'composer'), { wrapper: wrapper() })

    act(() => result.current.setText('typed, then left'))
    expect(writes()).toHaveLength(0)

    unmount()
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(writes()).toHaveLength(1)
    expect(writes()[0]?.body).toMatchObject({ text: 'typed, then left' })
  })

  it('flushes with keepalive when the tab is hidden mid-sentence', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useDraft('r1', 'composer'), { wrapper: wrapper() })
    act(() => result.current.setText('closing the laptop'))

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    await act(() => vi.advanceTimersByTimeAsync(0))

    expect(writes()).toHaveLength(1)
    expect(fetchMock.mock.calls.at(-1)?.[1]).toMatchObject({ keepalive: true })
  })

  it('sends a long draft as an ordinary request — `keepalive` would reject it outright', async () => {
    // Fetch caps the TOTAL body of in-flight `keepalive` requests at 64 KiB and REJECTS past it,
    // so flagging a long draft `keepalive` makes the one draft most worth saving the one that is
    // guaranteed not to be. `DRAFT_TEXT_MAX` is 100 000 characters — this is reachable by typing.
    vi.useFakeTimers()
    const { result } = renderHook(() => useDraft('r1', 'composer'), { wrapper: wrapper() })
    act(() => result.current.setText('x'.repeat(70_000)))

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    await act(() => vi.advanceTimersByTimeAsync(0))

    expect(writes()).toHaveLength(1)
    expect(fetchMock.mock.calls.at(-1)?.[1]).toMatchObject({ keepalive: false })
  })

  it('switching to another task shows THAT task\'s draft, never the previous one\'s', async () => {
    stored.r1 = { surfaces: { composer: entry('task one') } }
    stored.r2 = { surfaces: { composer: entry('task two') } }
    const { result, rerender } = renderHook(({ id }: { id: string }) => useDraft(id, 'composer'), {
      wrapper: wrapper(),
      initialProps: { id: 'r1' },
    })
    await waitFor(() => expect(result.current.text).toBe('task one'))

    rerender({ id: 'r2' })
    // Never the previous task's text, not even for one frame.
    expect(result.current.text).not.toBe('task one')
    await waitFor(() => expect(result.current.text).toBe('task two'))
  })

  it('carries a pending write across a task switch instead of dropping it', async () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ id }: { id: string }) => useDraft(id, 'composer'), {
      wrapper: wrapper(),
      initialProps: { id: 'r1' },
    })
    act(() => result.current.setText('unfinished on task one'))

    rerender({ id: 'r2' })
    await act(() => vi.advanceTimersByTimeAsync(0))

    expect(writes()).toEqual([
      expect.objectContaining({
        url: '/api/v1/runs/r1/drafts/composer',
        body: { text: 'unfinished on task one', images: [] },
      }),
    ])
  })

  describe('submit', () => {
    it('clears the draft once the message has really landed', async () => {
      vi.useFakeTimers()
      const { result } = renderHook(() => useDraft('r1', 'composer'), { wrapper: wrapper() })
      act(() => result.current.setText('a reply'))

      await act(async () => {
        await result.current.submit(async () => 'sent')
      })

      expect(result.current.text).toBe('')
      // The clear is an empty PUT — the server's own "emptied means deleted" rule.
      expect(writes().at(-1)?.body).toEqual({ text: '', images: [] })
    })

    it('holds the optimistic clear back: a failed send leaves the draft written', async () => {
      vi.useFakeTimers()
      const { result } = renderHook(() => useDraft('r1', 'composer'), { wrapper: wrapper() })
      act(() => result.current.setText('a reply that will not land'))

      await act(async () => {
        // What the composer does: clear optimistically, then call the host's submit.
        result.current.setText('')
        await result.current
          .submit(async () => {
            throw new Error('session closed')
          })
          .catch(() => {})
        // …and restore, exactly as `restoreOnError` does.
        result.current.setText('a reply that will not land')
      })
      await act(() => vi.advanceTimersByTimeAsync(DRAFT_WRITE_DEBOUNCE_MS))

      expect(writes().at(-1)?.body).toMatchObject({ text: 'a reply that will not land' })
      expect(result.current.text).toBe('a reply that will not land')
    })
  })

  describe('attachments', () => {
    const pasted: PendingAttachment = {
      mediaType: 'image/png',
      data: 'AAA',
      name: 'shot.png',
      preview: 'data:image/png;base64,AAA',
      isImage: true,
    }

    it('uploads on attach and names the stored id in the next write', async () => {
      const { result } = renderHook(() => useDraft('r1', 'composer'), { wrapper: wrapper() })
      await waitFor(() => expect(result.current.ready).toBe(true))

      act(() => result.current.setImages([pasted]))

      await waitFor(() => expect(result.current.images[0]?.id).toBe('img1'))
      await waitFor(() => expect(writes().at(-1)?.body).toMatchObject({ images: ['img1'] }))
    })

    it('removing a thumbnail deletes its blob, but the clear before a send does not', async () => {
      const held: PendingAttachment = { ...pasted, id: 'img1' }
      const { result } = renderHook(() => useDraft('r1', 'composer'), { wrapper: wrapper() })
      await waitFor(() => expect(result.current.ready).toBe(true))
      act(() => result.current.setImages([held]))
      act(() => result.current.setText('with a screenshot'))

      // A thumbnail click, with text still in the box: the bytes are not coming back.
      act(() => result.current.setImages([]))
      await waitFor(() =>
        expect(
          calls.some(
            (c) => c.method === 'DELETE' && c.url === '/api/v1/runs/r1/drafts/composer/images/img1',
          ),
        ).toBe(true),
      )

      // The composer's optimistic clear says so ("submit") and must NOT delete, or a rejected
      // send would come back without its attachments.
      calls.length = 0
      act(() => result.current.setImages([held]))
      act(() => result.current.setText(''))
      act(() => result.current.setImages([], 'submit'))
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    })

    it('deletes the blob of the LAST thumbnail removed from an images-only draft', async () => {
      // The regression this pins: while the send-clear was inferred from "the array went empty and
      // the text is already empty", a draft that never had text lost the distinction — removing its
      // last thumbnail looked exactly like a send, so the blob was left to the server's orphan
      // sweep and its ten-minute grace window rather than deleted now.
      const held: PendingAttachment = { ...pasted, id: 'img1' }
      const { result } = renderHook(() => useDraft('r1', 'composer'), { wrapper: wrapper() })
      await waitFor(() => expect(result.current.ready).toBe(true))
      act(() => result.current.setImages([held]))

      act(() => result.current.setImages([]))

      await waitFor(() =>
        expect(
          calls.some(
            (c) => c.method === 'DELETE' && c.url === '/api/v1/runs/r1/drafts/composer/images/img1',
          ),
        ).toBe(true),
      )
    })

    it('rehydrates a stored attachment into a thumbnail on return', async () => {
      stored.r1 = {
        surfaces: {
          composer: entry('with a screenshot', [
            { id: 'img1', mediaType: 'image/png', name: 'shot.png', bytes: 12 },
          ]),
        },
      }
      const { result } = renderHook(() => useDraft('r1', 'composer'), { wrapper: wrapper() })

      await waitFor(() => expect(result.current.images).toHaveLength(1))
      expect(result.current.images[0]).toMatchObject({
        id: 'img1',
        name: 'shot.png',
        preview: 'data:image/png;base64,AAA',
      })
    })
  })

  describe('when it is switched off', () => {
    it('reads nothing and writes nothing', async () => {
      const { result } = renderHook(() => useDraft('r1', 'composer', { enabled: false }), {
        wrapper: wrapper(),
      })
      act(() => result.current.setText('typed into an inert surface'))
      await waitFor(() => expect(result.current.ready).toBe(true))

      expect(calls).toHaveLength(0)
      expect(result.current.text).toBe('typed into an inert surface')
    })
  })
})
