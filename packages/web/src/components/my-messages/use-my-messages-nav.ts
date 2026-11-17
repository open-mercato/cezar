import { useCallback, useEffect, useRef, useState } from 'react'

import { myMessageTargets, type MyMessage, type MyMessagePlace, type MyMessageTargets } from './my-messages'

/** What a view tells the control about itself (spec 2026-11-17-my-message-navigation). */
export interface MyMessagesAdapter {
  items: readonly MyMessage[]
  /** The element that scrolls; null before mount. */
  scroller: () => HTMLElement | null
  /** The band of the scroller the reader sees, sticky header and dock excluded. */
  viewport: () => { top: number; bottom: number }
  place: (item: MyMessage) => MyMessagePlace
  /** Loads the message's range if needed, scrolls it into place and answers what to highlight. */
  reveal: (item: MyMessage) => Promise<HTMLElement | undefined>
}

export interface MyMessagesNav {
  items: readonly MyMessage[]
  targets: MyMessageTargets
  /** Re-reads the targets now (the list opens, items change). */
  refresh: () => void
  prev: () => Promise<void>
  next: () => Promise<void>
  /** `beforeHighlight` runs once the message is on screen: the list closes there, not earlier. */
  jumpTo: (id: string, beforeHighlight?: () => void) => Promise<void>
}

const EMPTY: MyMessageTargets = { onScreen: [] }

/**
 * The #2218 landing, self-contained: focus the message and ring it, briefly washed so the eye
 * finds it after a long scroll. The ring stays until focus moves on.
 */
export function highlightJumpTarget(element: HTMLElement): void {
  if (!element.hasAttribute('tabindex')) element.tabIndex = -1
  element.removeAttribute('data-jump-highlight')
  // Restart the wash when the same message is landed on twice in a row.
  void element.offsetWidth
  element.setAttribute('data-jump-highlight', '')
  element.focus({ preventScroll: true })
  element.addEventListener('blur', () => element.removeAttribute('data-jump-highlight'), { once: true })
}

/**
 * ▲ / ▼ and the list's jumps. Targets are read from the DOM only while `active` (the pill is on
 * screen), one measurement per frame of scrolling.
 */
export function useMyMessagesNav(adapter: MyMessagesAdapter, active: boolean): MyMessagesNav {
  const adapterRef = useRef(adapter)
  adapterRef.current = adapter
  const [targets, setTargets] = useState<MyMessageTargets>(EMPTY)
  const busy = useRef(false)

  const measure = useCallback((): MyMessageTargets => {
    const current = adapterRef.current
    if (!current.scroller()) return EMPTY
    return myMessageTargets(current.items, current.place, current.viewport())
  }, [])

  const refresh = useCallback(() => setTargets(measure()), [measure])

  const { items, scroller: scrollerOf } = adapter
  useEffect(() => {
    if (!active) return undefined
    refresh()
    const scroller = scrollerOf()
    if (!scroller) return undefined
    let frame = 0
    const onScroll = () => {
      if (frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        refresh()
      })
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      scroller.removeEventListener('scroll', onScroll)
    }
    // `adapter.items` re-measures: a page that loads moves every message below it.
  }, [active, scrollerOf, items, refresh])

  const go = useCallback(async (item: MyMessage | undefined, beforeHighlight?: () => void) => {
    if (!item || busy.current) return
    busy.current = true
    try {
      const target = await adapterRef.current.reveal(item)
      if (beforeHighlight) {
        beforeHighlight()
        // Let the list's close commit first: a sheet still open traps focus inside itself.
        await untilFrame(() => false, 2)
      }
      if (target) highlightJumpTarget(target)
    } finally {
      busy.current = false
      refresh()
    }
  }, [refresh])

  const prev = useCallback(() => go(measure().prev), [go, measure])
  const next = useCallback(() => go(measure().next), [go, measure])
  const jumpTo = useCallback(
    (id: string, beforeHighlight?: () => void) => go(adapterRef.current.items.find((item) => item.id === id), beforeHighlight),
    [go],
  )

  return { items, targets, refresh, prev, next, jumpTo }
}

/** Resolves once `ready()` holds, checking once per frame; false after `frames` frames. */
export async function untilFrame(ready: () => boolean, frames = 30): Promise<boolean> {
  for (let i = 0; i < frames; i += 1) {
    if (ready()) return true
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
  return ready()
}
