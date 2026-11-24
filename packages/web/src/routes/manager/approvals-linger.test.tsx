import { act, cleanup, render } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FADE_MS, LINGER_MS, useLinger, type LingerRow } from './approvals-linger'
import { LingerCollapse } from './linger-collapse'

const HEIGHT = 100
let scrollY = 0
let progress = 0

/** Cards 100 px tall, stacked from 0 and scrolled by `scrollY`; a collapsing one is `progress` of the way down. */
function layout(element: Element): DOMRect {
  const box = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON() {} }) as DOMRect
  if (element.closest('[hidden]')) return box(0, 0)
  const card = element.closest('[data-linger-key]')
  if (!card) return box(-scrollY, 0)
  let top = -scrollY
  for (const wrapper of document.querySelectorAll('[data-linger-key]')) {
    const height = wrapper.getAttribute('data-leaving') === 'collapse' ? HEIGHT * (1 - progress) : HEIGHT
    if (wrapper === card) return box(top, height)
    top += height
  }
  return box(top, 0)
}

function Harness({ rows }: { rows: LingerRow[] }) {
  const list = useRef<HTMLDivElement>(null)
  const [items, setItems] = useState(rows)
  const leaving = useLinger(items, (keys) => setItems((current) => current.filter((row) => !keys.has(row.key))), list)
  return (
    <div ref={list}>
      {items.map((row) => (
        <LingerCollapse key={row.key} lingerKey={row.key} leaving={leaving.get(row.key)}>
          <div data-slot="card">
            {row.key}
            {/* An approval card's outcome, hidden until it is decided. */}
            <p hidden data-slot="outcome">outcome</p>
          </div>
        </LingerCollapse>
      ))}
    </div>
  )
}

const top = (key: string) => layout(document.querySelector(`[data-linger-key="${key}"]`)!).top
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const reduce = (on: boolean) => vi.stubGlobal('matchMedia', (query: string) => ({
  matches: on && query.includes('reduce'), media: query, onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
}))

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  scrollY = 0
  progress = 0
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) { return layout(this) })
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
    return (this.closest('[hidden]') ? [] : [layout(this)]) as unknown as DOMRectList
  })
  // A page scrolls no higher than its top.
  vi.spyOn(window, 'scrollBy').mockImplementation(((_x: number, y: number) => { scrollY = Math.max(0, scrollY + y) }) as typeof window.scrollBy)
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY })
  reduce(false)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useLinger keeps what the reader is looking at still', () => {
  it('skips hidden elements when it picks what to hold (they report top 0)', async () => {
    const finishedAt = Date.now()
    render(<Harness rows={[{ key: 'a', finishedAt }, { key: 'b' }, { key: 'c' }, { key: 'd' }]} />)
    // a is above the view, b half above it; the reader is on c. b's hidden outcome claims top 0.
    scrollY = 150
    expect(top('c')).toBe(50)
    await advance(LINGER_MS)
    expect(document.querySelector('[data-linger-key="a"]')).toBeNull()
    expect(top('c')).toBe(50)
  })

  it.each([false, true])('a visible card above the reader fades in place; what follows never moves (reduced motion: %s)', async (reduced) => {
    reduce(reduced)
    const finishedAt = Date.now()
    render(<Harness rows={[{ key: 'z' }, { key: 'a', finishedAt }, { key: 'b' }, { key: 'c' }]} />)
    // z is above the view, a fully visible at the top, the reader below it on b.
    scrollY = 100
    expect(top('b')).toBe(100)
    await advance(LINGER_MS - FADE_MS)
    if (!reduced) {
      expect(document.querySelector('[data-linger-key="a"]')?.getAttribute('data-leaving')).toBe('fade')
      for (let frame = 0; frame < 3; frame++) {
        await advance(80)
        expect(top('b')).toBe(100)
      }
    }
    await advance(FADE_MS)
    expect(document.querySelector('[data-linger-key="a"]')).toBeNull()
    expect(top('b')).toBe(100)
    expect(scrollY).toBe(0)
  })

  it('collapses when the page cannot scroll back by its height: what follows slides, never snaps', async () => {
    const finishedAt = Date.now()
    render(<Harness rows={[{ key: 'a', finishedAt }, { key: 'b' }, { key: 'c' }]} />)
    // At the top of the page: a fade would end with b jumping up a whole card at once.
    await advance(LINGER_MS - FADE_MS)
    expect(document.querySelector('[data-linger-key="a"]')?.getAttribute('data-leaving')).toBe('collapse')
    await advance(FADE_MS)
    expect(document.querySelector('[data-linger-key="a"]')).toBeNull()
  })

  it('the last visible card collapses: nothing the reader sees follows it', async () => {
    const finishedAt = Date.now()
    render(<Harness rows={[{ key: 'z' }, { key: 'a', finishedAt }]} />)
    scrollY = 100
    await advance(LINGER_MS - FADE_MS)
    expect(document.querySelector('[data-linger-key="a"]')?.getAttribute('data-leaving')).toBe('collapse')
    await advance(FADE_MS)
    expect(document.querySelector('[data-linger-key="a"]')).toBeNull()
  })
})

describe('LingerCollapse never widens past its list (#2407)', () => {
  it('pins one shrinkable column and a shrinkable card: an implicit auto track grows to the longest unbroken token', () => {
    render(<LingerCollapse lingerKey="a" leaving={undefined}><div data-slot="card">cezar/5aeb1ea22d514e8fa5584d0e90c1b7a4</div></LingerCollapse>)
    const wrapper = document.querySelector('[data-linger-key="a"]')!
    expect(wrapper.className).toContain('grid-cols-[minmax(0,1fr)]')
    expect(wrapper.firstElementChild!.className).toContain('min-w-0')
  })
})
