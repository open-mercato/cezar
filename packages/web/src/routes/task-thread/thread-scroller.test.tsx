import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearThreadScrollCaches } from './thread-scroll'
import { ThreadRows, useThreadScroll, type ThreadRow } from './thread-scroller'

beforeEach(() => {
  // virtua measures with a ResizeObserver; jsdom has none and never lays anything out.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  clearThreadScrollCaches()
})

const rows = (count: number): ThreadRow[] =>
  Array.from({ length: count }, (_, index) => ({ key: `row-${index}`, node: <p>row {index}</p> }))

/** The mode is the caller's (threadRenderMode is pinned in thread-scroll.test.ts) — these
 *  tests pin what each mode RENDERS: the flat path keeps every row in the DOM with the
 *  content-visibility hint; the virtua path hands the same wrappers to the virtualizer. */
describe('ThreadRows — the threshold-switched renderer', () => {
  const controls = () => renderHook(() => useThreadScroll('r1')).result.current

  it('flat mode renders every row, marked and content-visibility-hinted', () => {
    render(<ThreadRows runId="r1" rows={rows(5)} mode="flat" controls={controls()} />)
    const region = document.querySelector('[data-slot="thread-rows"]')!
    expect(region.getAttribute('data-virtualized')).toBe('false')
    const rendered = document.querySelectorAll('[data-slot="thread-row"]')
    expect(rendered).toHaveLength(5)
    expect(rendered[0]!.className).toContain('[content-visibility:auto]')
    // Bubbles rely on flex alignment inside their row — every wrapper is a flex column.
    expect(rendered[0]!.className).toContain('flex-col')
    expect(rendered[0]!.className).toContain('w-full')
  })

  it('virtual mode mounts the virtua container instead', () => {
    render(<ThreadRows runId="r1" rows={rows(400)} mode="virtual" controls={controls()} />)
    const region = document.querySelector('[data-slot="thread-rows"]')!
    expect(region.getAttribute('data-virtualized')).toBe('true')
    // jsdom gives virtua a 0-height viewport, so it mounts a window, not the full list —
    // the honest jsdom-visible half of "the DOM stays bounded" (the real-browser half is
    // thread-scroll.e2e.ts's).
    const rendered = document.querySelectorAll('[data-slot="thread-row"]')
    expect(rendered.length).toBeLessThan(400)
    for (const row of rendered) expect(row.className).toContain('w-full')
  })

  it('flat rows keep their content in render order', () => {
    render(<ThreadRows runId="r1" rows={rows(3)} mode="flat" controls={controls()} />)
    const texts = [...document.querySelectorAll('[data-slot="thread-row"]')].map((el) => el.textContent)
    expect(texts).toEqual(['row 0', 'row 1', 'row 2'])
  })
})

describe('useThreadScroll — outside a shell scroller (jsdom, tests, storybook-ish hosts)', () => {
  it('attaches without a [data-slot=main] ancestor and stays inert', () => {
    const { result } = renderHook(() => useThreadScroll('r1'))
    const el = document.createElement('div')
    // No scroller to find — the controls must not throw, now or on use.
    act(() => result.current.attachContent(el))
    expect(result.current.scrollElRef.current).toBeNull()
    result.current.jumpToLatest()
    result.current.restickIfStuck()
    expect(result.current.pillVisible).toBe(false)
  })
})
