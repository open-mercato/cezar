import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useWorkspaceLayouts } from './use-workspace-layouts'
import type { WorkspaceState } from './layout-state'

/**
 * `openInBrowser`'s ANSWER (spec §7: the detected-URL strip's `Otwórz w Przeglądarce`).
 *
 * The regression this pins: the hook assigned its outcome inside a `setState` updater and
 * returned it on the next line. That only ever worked through React's eager-state fast path — as
 * soon as another update was already queued on this hook in the same batch, and a debounced
 * layout save is never far away, the updater ran AFTER the return. The caller then announced
 * "Układ ma już trzy kolumny" about a tab that had just opened. The decision is now taken from
 * the committed state before anything is dispatched, so the answer does not depend on React's
 * batching at all.
 */

const getRunLayouts = vi.fn<(id: string) => Promise<{ layouts: unknown }>>()
const putRunLayouts = vi.fn(async () => undefined)

vi.mock('@/api/client', () => ({
  getRunLayouts: (id: string) => getRunLayouts(id),
  putRunLayouts: (...args: unknown[]) => putRunLayouts(...(args as [])),
}))

function seeded(state: WorkspaceState) {
  getRunLayouts.mockResolvedValue({ layouts: state })
}

async function layouts(state: WorkspaceState) {
  seeded(state)
  const hook = renderHook(() => useWorkspaceLayouts('r1'))
  await waitFor(() => expect(hook.result.current.ready).toBe(true))
  return hook
}

const full = (view: 'session' | 'changes' | 'files'): WorkspaceState => ({
  layouts: [{ name: 'Jeden', columns: [{ view, width: 100 }] }],
  active: 'Jeden',
})

beforeEach(() => {
  getRunLayouts.mockReset()
  putRunLayouts.mockClear()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('openInBrowser', () => {
  it('says it placed the address, and puts it in a new Browser column', async () => {
    const { result } = await layouts(full('session'))

    let answer: boolean | undefined
    act(() => {
      answer = result.current.openInBrowser('http://localhost:3000/')
    })

    expect(answer).toBe(true)
    const columns = result.current.layout!.columns
    expect(columns.map((column) => column.view)).toEqual(['session', 'browser'])
    expect(columns[1]!.browser).toEqual({ tabs: ['http://localhost:3000/'], active: 0 })
  })

  it('adds a tab to the Browser column the layout already has', async () => {
    const { result } = await layouts({
      layouts: [
        {
          name: 'Jeden',
          columns: [
            { view: 'session', width: 50 },
            { view: 'browser', width: 50, browser: { tabs: ['https://github.com/'], active: 0 } },
          ],
        },
      ],
      active: 'Jeden',
    })

    let answer: boolean | undefined
    act(() => {
      answer = result.current.openInBrowser('http://localhost:3000/')
    })

    expect(answer).toBe(true)
    // No second Browser column, and the new tab is the active one.
    expect(result.current.layout!.columns.map((column) => column.view)).toEqual(['session', 'browser'])
    expect(result.current.layout!.columns[1]!.browser).toEqual({
      tabs: ['https://github.com/', 'http://localhost:3000/'],
      active: 1,
    })
  })

  it('refuses, and SAYS so, when the layout is already at the column cap', async () => {
    const { result } = await layouts({
      layouts: [
        {
          name: 'Trzy',
          columns: [
            { view: 'session', width: 34 },
            { view: 'changes', width: 33 },
            { view: 'files', width: 33 },
          ],
        },
      ],
      active: 'Trzy',
    })

    let answer: boolean | undefined
    act(() => {
      answer = result.current.openInBrowser('http://localhost:3000/')
    })

    expect(answer).toBe(false)
    expect(result.current.layout!.columns).toHaveLength(3)
  })

  it('still answers truthfully with a save already pending', async () => {
    // The batching case the old code got wrong: a change has been made, so the debounced save is
    // queued on this hook when `openInBrowser` runs.
    const { result } = await layouts(full('session'))
    act(() => {
      // A real state change, so the debounce is armed. `resizeColumns` would NOT do here: on a
      // single-column layout it returns the same state, and the test would prove nothing.
      result.current.renameLayout('Jeden', 'Przed')
    })
    expect(result.current.state.active).toBe('Przed')

    let answer: boolean | undefined
    act(() => {
      answer = result.current.openInBrowser('http://localhost:3000/')
    })

    expect(answer).toBe(true)
    expect(result.current.layout!.columns.map((column) => column.view)).toEqual(['session', 'browser'])
  })
})
