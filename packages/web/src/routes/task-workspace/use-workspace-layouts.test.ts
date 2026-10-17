import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { workspaceLayoutsSchema } from '@open-mercato/cezar-api-client'

import { useWorkspaceLayouts } from './use-workspace-layouts'
import { fixedViewOf, type WorkspaceState } from './layout-state'

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
  // Unmount, or a hook left over from one case answers the next case's `pagehide`.
  cleanup()
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

/* ── Review findings, 2026-10-12 ─────────────────────────────────────────────────────────────── */

/** Fake clock for the save/retry timers; `waitFor` is avoided because it polls on real time. */
const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })

async function mounted(id = 'r1') {
  const hook = renderHook(({ id }: { id: string }) => useWorkspaceLayouts(id), { initialProps: { id } })
  await tick(0)
  expect(hook.result.current.ready).toBe(true)
  return hook
}

const SAVED: WorkspaceState = {
  layouts: [
    { name: 'Chat', columns: [{ view: 'session', width: 100 }] },
    { name: 'Moje', columns: [{ view: 'session', width: 50 }, { view: 'files', width: 50 }] },
  ],
  active: 'Moje',
}

describe('a failed read of the saved layouts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    putRunLayouts.mockReset()
    putRunLayouts.mockResolvedValue(undefined)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is never followed by a write: the host copy survives a change made meanwhile', async () => {
    getRunLayouts.mockRejectedValueOnce(new Error('502')).mockResolvedValue({ layouts: SAVED })
    const { result } = await mounted()

    // The workspace is usable from memory…
    act(() => result.current.selectLayout('Changes'))
    expect(result.current.state.active).toBe('Changes')
    await tick(1000)
    // …but the fabricated default must not replace what the host holds.
    expect(putRunLayouts).not.toHaveBeenCalled()
    expect(result.current.loadFailed).toBe(true)

    // The read is retried, and its answer is the workspace.
    await tick(5000)
    expect(getRunLayouts).toHaveBeenCalledTimes(2)
    expect(result.current.state).toEqual(SAVED)
    await tick(1000)
    expect(putRunLayouts).not.toHaveBeenCalled()
  })

  it('does not write on the way out either', async () => {
    getRunLayouts.mockRejectedValue(new Error('offline'))
    const { result, unmount } = await mounted()
    act(() => result.current.selectLayout('Changes'))
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    unmount()
    await tick(1000)
    expect(putRunLayouts).not.toHaveBeenCalled()
  })

  it('keeps what was built meanwhile once the host says the task was never opened', async () => {
    getRunLayouts.mockRejectedValueOnce(new Error('502')).mockResolvedValue({ layouts: null })
    const { result } = await mounted()
    act(() => result.current.selectLayout('Changes'))
    await tick(3000)
    expect(result.current.loadFailed).toBe(false)
    expect(putRunLayouts).not.toHaveBeenCalled()
    // The debounce is armed by the render that learns the host answered.
    await tick(1000)
    expect(result.current.state.active).toBe('Changes')
    expect(putRunLayouts).toHaveBeenCalledTimes(1)
    expect((putRunLayouts.mock.calls[0] as unknown[])[1]).toMatchObject({ active: 'Changes' })
  })
})

describe('a late answer, against a debounce armed on the stand-in', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    putRunLayouts.mockReset()
    putRunLayouts.mockResolvedValue(undefined)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not let that timer PUT the stand-in between the answer and its commit', async () => {
    let answer!: (value: { layouts: unknown }) => void
    getRunLayouts
      .mockRejectedValueOnce(new Error('502'))
      .mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
    const { result } = await mounted()
    // The retry is out and unanswered; a change on the stand-in arms the debounce.
    await tick(2000)
    expect(getRunLayouts).toHaveBeenCalledTimes(2)
    act(() => result.current.selectLayout('Changes'))

    // The host answers. Outside `act`, so the fetch continuation runs and React has NOT committed.
    answer({ layouts: SAVED })
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve()
    expect(result.current.state.active).toBe('Changes')
    // …and the debounce comes due in exactly that gap.
    vi.advanceTimersByTime(400)
    expect(putRunLayouts).not.toHaveBeenCalled()

    await tick(1000)
    expect(result.current.state).toEqual(SAVED)
    expect(putRunLayouts).not.toHaveBeenCalled()
  })

  it('counts a replaced stand-in, and only that', async () => {
    getRunLayouts.mockRejectedValueOnce(new Error('502')).mockResolvedValue({ layouts: null })
    const kept = await mounted()
    await tick(3000)
    expect(kept.result.current.loadFailed).toBe(false)
    expect(kept.result.current.replaced).toBe(0)
    kept.unmount()

    getRunLayouts.mockReset()
    getRunLayouts.mockRejectedValueOnce(new Error('502')).mockResolvedValue({ layouts: SAVED })
    const swapped = await mounted()
    await tick(3000)
    expect(swapped.result.current.replaced).toBe(1)
  })
})

describe('the contract bounds, client-side', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    putRunLayouts.mockReset()
    putRunLayouts.mockResolvedValue(undefined)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const twelve = Array.from({ length: 12 }, (_, index) => `http://localhost:${3000 + index}/`)

  it('Open in Browser refuses a thirteenth tab instead of minting an unsaveable document', async () => {
    getRunLayouts.mockResolvedValue({
      layouts: {
        layouts: [{ name: 'Jeden', columns: [{ view: 'browser', width: 100, browser: { tabs: twelve, active: 0 } }] }],
        active: 'Jeden',
      },
    })
    const { result } = await mounted()

    let answer: boolean | undefined
    act(() => {
      answer = result.current.openInBrowser('http://localhost:9999/')
    })
    expect(answer).toBe(false)
    expect(result.current.layout!.columns[0]!.browser!.tabs).toHaveLength(12)
    expect(workspaceLayoutsSchema.safeParse(result.current.state).success).toBe(true)
  })

  it('a long rename still produces a document the host accepts', async () => {
    getRunLayouts.mockResolvedValue({ layouts: SAVED })
    const { result } = await mounted()
    act(() => result.current.renameLayout('Moje', 'x'.repeat(200)))
    await tick(1000)
    expect(putRunLayouts).toHaveBeenCalledTimes(1)
    expect(workspaceLayoutsSchema.safeParse((putRunLayouts.mock.calls[0] as unknown[])[1]).success).toBe(true)
  })

  it('a save the host REFUSES (400) is reported at once, not sent again', async () => {
    getRunLayouts.mockResolvedValue({ layouts: SAVED })
    putRunLayouts.mockRejectedValue(Object.assign(new Error('bad body'), { status: 400 }))
    const { result } = await mounted()
    act(() => result.current.selectLayout('Chat'))
    await tick(500)
    expect(result.current.saveFailed).toBe(true)
    await tick(5000)
    expect(putRunLayouts).toHaveBeenCalledTimes(1)
  })
})

describe('Open in Browser on a fixed card', () => {
  it('opens the pair layout and leaves the fixed card the one view it stands for', async () => {
    // `null` is a task never opened: the six born cards, Chat active.
    getRunLayouts.mockResolvedValue({ layouts: null })
    const hook = renderHook(() => useWorkspaceLayouts('r1'))
    await waitFor(() => expect(hook.result.current.ready).toBe(true))
    const { result } = hook

    let answer: boolean | undefined
    act(() => {
      answer = result.current.openInBrowser('http://localhost:3000/')
    })
    expect(answer).toBe(true)
    expect(result.current.layout!.name).toBe('Chat + Preview')
    expect(result.current.layout!.columns.map((column) => column.view)).toEqual(['session', 'browser'])
    expect(result.current.layout!.columns[1]!.browser).toEqual({ tabs: ['http://localhost:3000/'], active: 0 })
    const chat = result.current.state.layouts.find((layout) => layout.name === 'Chat')!
    expect(fixedViewOf(chat)).toBe('session')

    // The fixed Chat card still leads home, and mints nothing.
    act(() => result.current.openDeepLink('session'))
    expect(result.current.state.active).toBe('Chat')
    expect(result.current.state.layouts.map((layout) => layout.name)).not.toContain('Chat 2')
  })
})

describe('leaving', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    putRunLayouts.mockReset()
    putRunLayouts.mockResolvedValue(undefined)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends the pagehide flush keepalive, so the browser may finish it after the page is gone', async () => {
    getRunLayouts.mockResolvedValue({ layouts: SAVED })
    const { result } = await mounted()
    act(() => result.current.selectLayout('Chat'))
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    expect(putRunLayouts).toHaveBeenCalledTimes(1)
    expect((putRunLayouts.mock.calls[0] as unknown[])[2]).toEqual({ keepalive: true })
  })

  it("does not raise task A's failed leave-time save on task B", async () => {
    getRunLayouts.mockResolvedValue({ layouts: SAVED })
    putRunLayouts.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === 'A') throw new Error('read-only home')
      return undefined
    })
    const hook = await mounted('A')
    act(() => hook.result.current.selectLayout('Chat'))
    hook.rerender({ id: 'B' })
    await tick(0)
    expect(putRunLayouts).toHaveBeenCalledTimes(1)
    await tick(4000)
    expect(hook.result.current.saveFailed).toBe(false)
  })
})
