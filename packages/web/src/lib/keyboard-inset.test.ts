import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  keyboardAwareCollisionPadding,
  keyboardInset,
  useKeyboardOpen,
  useViewportInsets,
  viewportInsets,
  watchKeyboardInset,
  watchKeyboardOpen,
  watchViewportInsets,
  type KeyboardOpenWindow,
  type KeyboardViewport,
  type KeyboardWindow,
  type ViewportInsets,
} from './keyboard-inset'

/** A drivable visualViewport: tests resize it and fire the listeners, like Safari does. */
class StubViewport implements KeyboardViewport {
  listeners = new Map<'resize' | 'scroll', Set<() => void>>()
  constructor(
    public height: number,
    public offsetTop = 0,
  ) {}
  addEventListener(type: 'resize' | 'scroll', listener: () => void) {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }
  removeEventListener(type: 'resize' | 'scroll', listener: () => void) {
    this.listeners.get(type)?.delete(listener)
  }
  fire(type: 'resize' | 'scroll') {
    for (const listener of this.listeners.get(type) ?? []) listener()
  }
}

const win = (viewport: KeyboardViewport | null, innerHeight = 800): KeyboardWindow => ({
  innerHeight,
  visualViewport: viewport,
})

describe('keyboardInset — the --kb math', () => {
  it.each([
    // [innerHeight, vv.height, vv.offsetTop, expected]
    [800, 800, 0, 0], // keyboard closed
    [800, 460, 0, 340], // iOS keyboard open, viewport not panned
    [800, 460, 100, 240], // panned down: the pan eats into the overlap
    [800, 810, 0, 0], // URL-bar collapse makes vv taller — NOT a keyboard, clamped
    [800, 799.4, 0, 1], // fractional Safari values round, not truncate
  ])('inner %d, vv %d @ %d → %d', (innerHeight, height, offsetTop, expected) => {
    expect(keyboardInset(win(new StubViewport(height, offsetTop), innerHeight))).toBe(expected)
  })

  it('is 0 without a visualViewport (older engines)', () => {
    expect(keyboardInset(win(null))).toBe(0)
  })
})

describe('viewportInsets — the collision-padding math', () => {
  it.each([
    // [innerHeight, vv.height, vv.offsetTop, expected top, expected bottom]
    [800, 800, 0, 0, 0], // keyboard closed
    [800, 460, 0, 0, 340], // keyboard open, not panned
    [800, 460, 100, 100, 240], // panned down: top hidden behind the pan, bottom behind the keys
    [800, 810, 0, 0, 0], // URL-bar collapse — nothing hidden, both clamp at 0
  ])('inner %d, vv %d @ %d → top %d / bottom %d', (innerHeight, height, offsetTop, top, bottom) => {
    expect(viewportInsets(win(new StubViewport(height, offsetTop), innerHeight))).toEqual({ top, bottom })
  })

  it('is {0,0} without a visualViewport (older engines, jsdom)', () => {
    expect(viewportInsets(win(null))).toEqual({ top: 0, bottom: 0 })
  })
})

describe('keyboardAwareCollisionPadding', () => {
  const insets: ViewportInsets = { top: 100, bottom: 340 }

  it('defaults to the insets alone (Radix default padding is 0)', () => {
    expect(keyboardAwareCollisionPadding(insets)).toEqual({ top: 100, right: 0, bottom: 340, left: 0 })
  })

  it('adds a uniform number padding to every side, insets on top/bottom only', () => {
    expect(keyboardAwareCollisionPadding(insets, 8)).toEqual({ top: 108, right: 8, bottom: 348, left: 8 })
  })

  it('merges a partial per-side object', () => {
    expect(keyboardAwareCollisionPadding({ top: 0, bottom: 0 }, { left: 12 })).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 12,
    })
  })
})

describe('watchViewportInsets — the stubbed adapter', () => {
  it('applies on install and tracks resize and pan events', () => {
    const viewport = new StubViewport(800)
    const applied: ViewportInsets[] = []
    watchViewportInsets(win(viewport), (insets) => applied.push(insets))
    expect(applied).toEqual([{ top: 0, bottom: 0 }])

    viewport.height = 460
    viewport.fire('resize')
    viewport.offsetTop = 120
    viewport.fire('scroll')
    expect(applied).toEqual([
      { top: 0, bottom: 0 },
      { top: 0, bottom: 340 },
      { top: 120, bottom: 220 },
    ])
  })

  it('cleanup detaches the listeners', () => {
    const viewport = new StubViewport(800)
    const applied: ViewportInsets[] = []
    const stop = watchViewportInsets(win(viewport), (insets) => applied.push(insets))
    stop()
    viewport.height = 460
    viewport.fire('resize')
    expect(applied).toEqual([{ top: 0, bottom: 0 }])
  })

  it('degrades to a one-shot {0,0} without a visualViewport', () => {
    const applied: ViewportInsets[] = []
    const stop = watchViewportInsets(win(null), (insets) => applied.push(insets))
    expect(applied).toEqual([{ top: 0, bottom: 0 }])
    stop() // must not throw
  })
})

describe('useViewportInsets — the React binding', () => {
  const setViewport = (viewport: KeyboardViewport | null) =>
    Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true })

  afterEach(() => setViewport(null))

  it('tracks the real window.visualViewport while mounted', () => {
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })
    const viewport = new StubViewport(800)
    setViewport(viewport)
    const { result, unmount } = renderHook(() => useViewportInsets())
    expect(result.current).toEqual({ top: 0, bottom: 0 })

    act(() => {
      viewport.height = 460
      viewport.offsetTop = 100
      viewport.fire('resize')
    })
    expect(result.current).toEqual({ top: 100, bottom: 240 })

    unmount()
    act(() => {
      viewport.height = 800
      viewport.fire('resize')
    })
    expect(viewport.listeners.get('resize')?.size ?? 0).toBe(0) // unsubscribed
  })

  it('stays {0,0} without a visualViewport (jsdom, desktop engines)', () => {
    const { result } = renderHook(() => useViewportInsets())
    expect(result.current).toEqual({ top: 0, bottom: 0 })
  })
})

describe('watchKeyboardInset — the stubbed adapter', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('applies on install, tracks every viewport event, settles once after the burst', () => {
    const viewport = new StubViewport(800)
    const applied: number[] = []
    const settled: number[] = []
    watchKeyboardInset(win(viewport), (px) => applied.push(px), (px) => settled.push(px), 250)

    expect(applied).toEqual([0]) // the install-time apply

    // Safari streams resize events through the keyboard animation.
    viewport.height = 700
    viewport.fire('resize')
    viewport.height = 540
    viewport.fire('resize')
    viewport.height = 460
    viewport.fire('resize')
    expect(applied).toEqual([0, 100, 260, 340]) // the composer tracked the animation…

    expect(settled).toEqual([]) // …but nothing settled yet
    vi.advanceTimersByTime(249)
    expect(settled).toEqual([])
    vi.advanceTimersByTime(1)
    expect(settled).toEqual([340]) // one settle, at the final inset, after the debounce
  })

  it('viewport pans (scroll events) re-derive the inset too', () => {
    const viewport = new StubViewport(460)
    const applied: number[] = []
    watchKeyboardInset(win(viewport), (px) => applied.push(px))
    viewport.offsetTop = 120
    viewport.fire('scroll')
    expect(applied).toEqual([340, 220])
  })

  it('cleanup removes the listeners, cancels the pending settle, and resets to 0', () => {
    const viewport = new StubViewport(800)
    const applied: number[] = []
    const settled: number[] = []
    const stop = watchKeyboardInset(win(viewport), (px) => applied.push(px), (px) => settled.push(px))

    viewport.height = 460
    viewport.fire('resize')
    stop()

    expect(applied).toEqual([0, 340, 0]) // the reset — a stale --kb must not outlive the view
    vi.runAllTimers()
    expect(settled).toEqual([]) // the in-flight settle died with the watcher
    viewport.fire('resize')
    expect(applied).toEqual([0, 340, 0]) // detached
  })

  it('degrades to a no-op apply(0) without a visualViewport', () => {
    const applied: number[] = []
    const stop = watchKeyboardInset(win(null), (px) => applied.push(px))
    expect(applied).toEqual([0])
    stop() // must not throw
  })
})

describe('watchKeyboardOpen', () => {
  /** A drivable phone: `resize` moves the layout viewport and fires what the engine would. */
  function phone({ coarse = true, height = 800, width = 390 } = {}) {
    const viewport = new StubViewport(height)
    const listeners = new Set<() => void>()
    const stub: KeyboardOpenWindow = {
      innerHeight: height,
      innerWidth: width,
      visualViewport: viewport,
      addEventListener: (_type, listener) => void listeners.add(listener),
      removeEventListener: (_type, listener) => void listeners.delete(listener),
      matchMedia: () => ({ matches: coarse }),
    }
    const field = document.createElement('textarea')
    document.body.append(field)
    const states: boolean[] = []
    const stop = watchKeyboardOpen(stub, document, (open) => states.push(open))
    const fire = () => {
      for (const listener of listeners) listener()
      viewport.fire('resize')
    }
    return { stub, viewport, field, states, stop, fire, listeners }
  }
  const last = (states: boolean[]) => states[states.length - 1]

  afterEach(() => {
    document.body.replaceChildren()
  })

  it('opens on iOS: innerHeight stays, the visual viewport shrinks', () => {
    const { viewport, field, states, fire } = phone()
    expect(last(states)).toBe(false)
    field.focus()
    viewport.height = 460
    fire()
    expect(last(states)).toBe(true)
    field.blur()
    expect(last(states)).toBe(false)
  })

  it('opens under resizes-content: the inset stays 0, innerHeight shrinks', () => {
    const { stub, viewport, field, states, fire } = phone()
    field.focus()
    stub.innerHeight = 500
    viewport.height = 500
    fire()
    expect(keyboardInset(stub)).toBe(0)
    expect(last(states)).toBe(true)
  })

  it('closes when Android back drops the keyboard and focus stays in the field', () => {
    const { stub, viewport, field, states, fire } = phone()
    field.focus()
    stub.innerHeight = 500
    viewport.height = 500
    fire()
    stub.innerHeight = 800
    viewport.height = 800
    fire()
    expect(document.activeElement).toBe(field)
    expect(last(states)).toBe(false)
  })

  it('keeps each orientation its own tallest height, so a rotation is not a keyboard', () => {
    const { stub, viewport, field, states, fire } = phone()
    field.focus()
    Object.assign(stub, { innerWidth: 800, innerHeight: 390 })
    viewport.height = 390
    fire()
    expect(last(states)).toBe(false)
    stub.innerHeight = 200
    viewport.height = 200
    fire()
    expect(last(states)).toBe(true)
  })

  it.each([
    ['a URL bar coming back', { covered: 60, focused: true, coarse: true }],
    ['pinch zoom with nothing focused', { covered: 300, focused: false, coarse: true }],
    ['a desktop window dragged shorter', { covered: 300, focused: true, coarse: false }],
  ])('stays closed for %s', (_name, { covered, focused, coarse }) => {
    const { stub, viewport, field, states, fire } = phone({ coarse })
    if (focused) field.focus()
    stub.innerHeight = 800 - covered
    viewport.height = 800 - covered
    fire()
    expect(states.every((open) => !open)).toBe(true)
  })

  it('cleanup detaches every listener', () => {
    const { viewport, field, states, stop, listeners } = phone()
    stop()
    expect(listeners.size).toBe(0)
    expect(viewport.listeners.get('resize')?.size).toBe(0)
    field.focus()
    expect(states).toHaveLength(1)
  })
})

describe('useKeyboardOpen', () => {
  it('stays false without matchMedia or a visualViewport (jsdom, older engines)', () => {
    const { result } = renderHook(() => useKeyboardOpen())
    expect(result.current).toBe(false)
  })
})
