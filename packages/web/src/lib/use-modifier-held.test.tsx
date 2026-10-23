import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MODIFIER_HOLD_MS, useModifierHeld } from './use-modifier-held'

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('navigator', { ...navigator, platform: 'MacIntel' })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const key = (type: 'keydown' | 'keyup', init: KeyboardEventInit) =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent(type, init))
  })
const pointer = (type: 'pointermove' | 'pointerdown', init: PointerEventInit) =>
  act(() => {
    // jsdom has no PointerEvent constructor; a MouseEvent carries the same modifier flags.
    window.dispatchEvent(new MouseEvent(type, init))
  })
const wait = (ms = MODIFIER_HOLD_MS + 10) =>
  act(() => {
    vi.advanceTimersByTime(ms)
  })

function hold() {
  const hook = renderHook(() => useModifierHeld())
  key('keydown', { key: 'Meta', metaKey: true })
  return hook
}

describe('useModifierHeld', () => {
  it('shows after a plain ⌘ hold and hides on release', async () => {
    const { result } = hold()
    expect(result.current).toBe(false)
    await wait()
    expect(result.current).toBe(true)
    key('keyup', { key: 'Meta' })
    expect(result.current).toBe(false)
  })

  it('never shows for a chord — ⌘⇧4 (the macOS screenshot) or ⌘C', async () => {
    const shift = hold()
    key('keydown', { key: 'Shift', metaKey: true, shiftKey: true })
    await wait()
    expect(shift.result.current).toBe(false)
    shift.unmount()

    const copy = hold()
    key('keydown', { key: 'c', metaKey: true })
    await wait()
    expect(copy.result.current).toBe(false)
  })

  it('hides when a modifier joins an already-shown hold', async () => {
    const { result } = hold()
    await wait()
    key('keydown', { key: 'Shift', metaKey: true, shiftKey: true })
    expect(result.current).toBe(false)
  })

  it('keeps showing through the digits it advertises', async () => {
    const { result } = hold()
    await wait()
    key('keydown', { key: '2', code: 'Digit2', metaKey: true })
    await wait(1)
    expect(result.current).toBe(true)
  })

  it('a swallowed release cannot strand it: the next pointer move or key without ⌘ hides it', async () => {
    const moved = hold()
    await wait()
    pointer('pointermove', { metaKey: false })
    expect(moved.result.current).toBe(false)
    moved.unmount()

    const typed = hold()
    await wait()
    key('keydown', { key: 'a', metaKey: false })
    expect(typed.result.current).toBe(false)
    typed.unmount()

    const blurred = hold()
    await wait()
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    expect(blurred.result.current).toBe(false)
  })

  it('a pointer move while ⌘ is still down changes nothing', async () => {
    const { result } = hold()
    await wait()
    pointer('pointermove', { metaKey: true })
    expect(result.current).toBe(true)
  })
})
