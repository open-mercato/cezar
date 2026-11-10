import { useCallback, useEffect, useRef } from 'react'
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react'

/**
 * Press-and-hold on a button that ALSO has a tap action (the composer's Dispatch toggle:
 * tap = on/off, hold = its settings). One hook so the two gestures cannot disagree about
 * which of them a pointer sequence was:
 *
 *  - pointerdown starts a timer; `delayMs` later (default 450 ms) without the pointer having
 *    moved more than `moveTolerance` px, `onLongPress` fires and the trailing `click` the
 *    browser sends after pointerup is swallowed — otherwise a hold would open the settings AND
 *    flip the toggle;
 *  - a pointerup/cancel before the timer, or a move past the tolerance (the user is scrolling
 *    the pill row on a phone), cancels the hold and the click goes through as a tap;
 *  - `contextmenu` (a right-click, or Android's long-press) is the same secondary action, with
 *    the native menu suppressed — a hold on a toggle must not pop the browser's copy/inspect
 *    menu over it;
 *  - the keyboard gets an explicit route to the secondary action, since it cannot hold:
 *    ArrowDown or Shift+Enter. Plain Enter/Space stay the button's native click.
 *
 * Handlers are stable across renders (the latest callbacks are read through refs), so they can
 * be spread onto the button without re-binding Radix's own composed handlers each render.
 */
export interface LongPressOptions {
  onLongPress: () => void
  onClick?: () => void
  /** Hold time before the press counts as long, in ms. */
  delayMs?: number
  /** Pointer travel that cancels the hold, in px. */
  moveTolerance?: number
}

export interface LongPressHandlers {
  onPointerDown: (event: PointerEvent<HTMLElement>) => void
  onPointerMove: (event: PointerEvent<HTMLElement>) => void
  onPointerUp: (event: PointerEvent<HTMLElement>) => void
  onPointerCancel: (event: PointerEvent<HTMLElement>) => void
  onContextMenu: (event: MouseEvent<HTMLElement>) => void
  onClick: (event: MouseEvent<HTMLElement>) => void
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
}

export const LONG_PRESS_DELAY_MS = 450
export const LONG_PRESS_MOVE_TOLERANCE_PX = 8

export function useLongPress({
  onLongPress,
  onClick,
  delayMs = LONG_PRESS_DELAY_MS,
  moveTolerance = LONG_PRESS_MOVE_TOLERANCE_PX,
}: LongPressOptions): LongPressHandlers {
  const latest = useRef({ onLongPress, onClick })
  latest.current = { onLongPress, onClick }
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const origin = useRef({ x: 0, y: 0 })
  // Set when the secondary action fired for the CURRENT press, so the click that follows the
  // pointerup is swallowed. Reset on the next pointerdown — a right-click has no trailing click,
  // and the flag must not eat the next ordinary tap instead.
  const fired = useRef(false)

  const cancel = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  useEffect(() => cancel, [cancel])

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      fired.current = false
      cancel()
      // Only the primary button holds; a right-button press reaches us as `contextmenu`.
      if (event.button !== 0) return
      origin.current = { x: event.clientX ?? 0, y: event.clientY ?? 0 }
      timer.current = setTimeout(() => {
        timer.current = null
        fired.current = true
        latest.current.onLongPress()
      }, delayMs)
    },
    [cancel, delayMs],
  )

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (timer.current === null) return
      const dx = (event.clientX ?? 0) - origin.current.x
      const dy = (event.clientY ?? 0) - origin.current.y
      if (Math.hypot(dx, dy) > moveTolerance) cancel()
    },
    [cancel, moveTolerance],
  )

  const onContextMenu = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      event.preventDefault()
      cancel()
      // The hold timer may already have opened it (Android sends contextmenu AFTER the hold);
      // once per press is enough.
      if (fired.current) return
      fired.current = true
      latest.current.onLongPress()
    },
    [cancel],
  )

  const onClickHandler = useCallback((event: MouseEvent<HTMLElement>) => {
    if (fired.current) {
      fired.current = false
      event.preventDefault()
      return
    }
    latest.current.onClick?.()
  }, [])

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'ArrowDown' || (event.key === 'Enter' && event.shiftKey)) {
      event.preventDefault()
      latest.current.onLongPress()
    }
  }, [])

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu,
    onClick: onClickHandler,
    onKeyDown,
  }
}
