import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { useProjectOrder } from './use-project-order'

/**
 * The write half of the sidebar's project order (#952). What is worth pinning here rather than
 * in the component: that a drag sends the WHOLE `sidebar` object (the shallow server-side merge
 * makes anything less a data loss), that reset removes the key instead of writing an empty list,
 * and that a failed write does not leave the cockpit showing an order the file never took.
 */

const UI_STATE = '/api/v1/workspace/ui-state'

let file: Record<string, unknown>
let puts: Array<Record<string, unknown>>
let failWrites: string | null
let holdWrites: boolean
const fetchMock = vi.fn<typeof fetch>()

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  file = {}
  puts = []
  failWrites = null
  holdWrites = false
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url !== UI_STATE) return json({ error: 'not found' }, 404)
    if (method === 'PUT') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      puts.push(body)
      if (holdWrites) return new Promise<never>(() => {})
      if (failWrites !== null) return json({ error: failWrites }, 500)
      // The server merges shallowly, at the top level only — exactly what the controller has to
      // survive, and the reason it composes a whole `sidebar` object every time.
      file = { ...file, ...body }
      return json(file)
    }
    return json(file)
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

function mount() {
  const client = createQueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return renderHook(() => useProjectOrder(), { wrapper })
}

/** Mounted, with the authoritative GET already landed. */
async function ready() {
  const view = mount()
  await waitFor(() => expect(view.result.current.canReorder).toBe(true))
  return view
}

describe('useProjectOrder', () => {
  it('reads and normalizes the stored order', async () => {
    file = { sidebar: { projectOrder: ['shop', 'shop', '', 'cezar'] } }
    const view = await ready()
    expect(view.result.current.order).toEqual(['shop', 'cezar'])
  })

  it('is not reorderable until the authoritative GET lands', async () => {
    const view = mount()
    expect(view.result.current.canReorder).toBe(false)
    // A write composed from an empty cache could only send `{sidebar: {projectOrder}}`, dropping
    // every other key of the user's file on the shallow merge. So it must not write at all.
    act(() => view.result.current.setOrder(['a', 'b']))
    expect(puts).toEqual([])
  })

  it('writes the whole sidebar object, keeping the legacy collapse map', async () => {
    file = { sidebar: { collapsed: { cezar: true }, other: 1 }, appearance: { accent: 'violet' } }
    const view = await ready()

    act(() => view.result.current.setOrder(['shop', 'cezar']))
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0]).toEqual({
      sidebar: { collapsed: { cezar: true }, other: 1, projectOrder: ['shop', 'cezar'] },
    })
    // …and the sibling top-level keys are untouched, because they were never in the patch.
    expect(file.appearance).toEqual({ accent: 'violet' })
    await waitFor(() => expect(view.result.current.order).toEqual(['shop', 'cezar']))
  })

  it('applies the new order optimistically, before the write answers', async () => {
    const view = await ready()
    // The PUT never answers. Anything the hook reports from here is the optimistic cache, which
    // is what keeps the drawer from snapping back under the pointer at the end of a drag.
    holdWrites = true

    act(() => view.result.current.setOrder(['b', 'a']))
    await waitFor(() => expect(view.result.current.order).toEqual(['b', 'a']))
    expect(puts).toHaveLength(1)
  })

  it('drops the key on reset rather than writing an empty list', async () => {
    file = { sidebar: { collapsed: { cezar: true }, projectOrder: ['shop', 'cezar'] } }
    const view = await ready()

    act(() => view.result.current.reset())
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0]).toEqual({ sidebar: { collapsed: { cezar: true } } })
    expect(view.result.current.order).toEqual([])
  })

  it('ignores an empty order rather than clearing the user’s by accident', async () => {
    const view = await ready()
    act(() => view.result.current.setOrder([]))
    expect(puts).toEqual([])
  })

  it('normalizes what it writes, so a duplicate id never reaches the file', async () => {
    const view = await ready()
    act(() => view.result.current.setOrder(['a', 'a', 'b']))
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0]).toEqual({ sidebar: { projectOrder: ['a', 'b'] } })
  })

  it('serializes writes so a slow response cannot resurrect a stale order', async () => {
    const view = await ready()
    act(() => view.result.current.setOrder(['a', 'b']))
    act(() => view.result.current.setOrder(['b', 'a']))
    await waitFor(() => expect(puts).toHaveLength(2))
    // Second write last, and its answer is the one that reaches the cache.
    expect(puts.map((body) => (body.sidebar as { projectOrder: string[] }).projectOrder)).toEqual([
      ['a', 'b'],
      ['b', 'a'],
    ])
    await waitFor(() => expect(view.result.current.order).toEqual(['b', 'a']))
  })

  it('falls back to server truth when the write fails', async () => {
    file = { sidebar: { projectOrder: ['cezar', 'shop'] } }
    const view = await ready()
    failWrites = 'disk is read-only'

    act(() => view.result.current.setOrder(['shop', 'cezar']))
    // The refetch that follows the failure answers the file as it really is — never the order
    // the user dragged to, which would be a cockpit quietly diverged from its own state.
    await waitFor(() => expect(view.result.current.order).toEqual(['cezar', 'shop']))
  })
})
