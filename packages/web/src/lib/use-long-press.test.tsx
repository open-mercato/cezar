import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import { useLongPress } from '@/lib/use-long-press'

function Probe({ onLongPress, onClick }: { onLongPress: () => void; onClick: () => void }) {
  const handlers = useLongPress({ onLongPress, onClick })
  return (
    <button type="button" {...handlers}>
      hold me
    </button>
  )
}

const button = () => screen.getByRole('button')

let onLongPress: Mock<() => void>
let onClick: Mock<() => void>

beforeEach(() => {
  vi.useFakeTimers()
  onLongPress = vi.fn<() => void>()
  onClick = vi.fn<() => void>()
  render(<Probe onLongPress={onLongPress} onClick={onClick} />)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useLongPress', () => {
  it('a hold past the delay fires the secondary action and swallows the trailing click', () => {
    fireEvent.pointerDown(button(), { button: 0, clientX: 10, clientY: 10 })
    act(() => vi.advanceTimersByTime(449))
    expect(onLongPress).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(onLongPress).toHaveBeenCalledTimes(1)

    // The browser sends pointerup then click after a hold — neither may toggle.
    fireEvent.pointerUp(button())
    fireEvent.click(button())
    expect(onClick).not.toHaveBeenCalled()

    // The NEXT tap is an ordinary tap again: the swallow is per press, not sticky.
    fireEvent.pointerDown(button(), { button: 0 })
    fireEvent.pointerUp(button())
    fireEvent.click(button())
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('a tap released before the delay is a click', () => {
    fireEvent.pointerDown(button(), { button: 0 })
    act(() => vi.advanceTimersByTime(200))
    fireEvent.pointerUp(button())
    fireEvent.click(button())
    act(() => vi.advanceTimersByTime(1_000))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it('moving past the tolerance cancels the hold (the user is scrolling the row)', () => {
    fireEvent.pointerDown(button(), { button: 0, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(button(), { clientX: 12, clientY: 0 })
    act(() => vi.advanceTimersByTime(1_000))
    expect(onLongPress).not.toHaveBeenCalled()

    // Under the tolerance the hold survives — a thumb is never perfectly still.
    fireEvent.pointerDown(button(), { button: 0, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(button(), { clientX: 3, clientY: 4 })
    act(() => vi.advanceTimersByTime(450))
    expect(onLongPress).toHaveBeenCalledTimes(1)
  })

  it('contextmenu is the same secondary action, once per press, with the native menu suppressed', () => {
    const event = fireEvent.contextMenu(button())
    expect(event).toBe(false) // preventDefault() was called
    expect(onLongPress).toHaveBeenCalledTimes(1)

    // Android: the hold fires first, then contextmenu arrives for the same press.
    fireEvent.pointerDown(button(), { button: 0 })
    act(() => vi.advanceTimersByTime(450))
    fireEvent.contextMenu(button())
    expect(onLongPress).toHaveBeenCalledTimes(2)
  })

  it('a non-primary button never starts the hold', () => {
    fireEvent.pointerDown(button(), { button: 2 })
    act(() => vi.advanceTimersByTime(1_000))
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it('ArrowDown and Shift+Enter reach the secondary action from the keyboard', () => {
    fireEvent.keyDown(button(), { key: 'ArrowDown' })
    fireEvent.keyDown(button(), { key: 'Enter', shiftKey: true })
    expect(onLongPress).toHaveBeenCalledTimes(2)
    // Plain Enter is the button's own click — not ours to intercept.
    fireEvent.keyDown(button(), { key: 'Enter' })
    expect(onLongPress).toHaveBeenCalledTimes(2)
  })

  it('unmounting mid-hold clears the timer', () => {
    fireEvent.pointerDown(button(), { button: 0 })
    cleanup()
    expect(vi.getTimerCount()).toBe(0)
    act(() => vi.advanceTimersByTime(1_000))
    expect(onLongPress).not.toHaveBeenCalled()
  })
})
