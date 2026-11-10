import { useSyncExternalStore } from 'react'

import { isSubmitShortcut, type SubmitShortcutEvent } from './use-submit-shortcut'

/**
 * What Enter means in a chat composer. On a phone the soft keyboard's return key is the only
 * way to start a new line, so there Enter inserts one and only Send (or ⌘/Ctrl+↵ from a hardware
 * keyboard) sends; everywhere else Enter sends and Shift+Enter is the newline.
 *
 * "Phone" is the PRIMARY input: a coarse pointer that cannot hover. A touch laptop's primary
 * pointer is its trackpad, so it keeps desktop Enter; a phone or tablet with a hardware keyboard
 * stays touch-first and sends with the chord instead.
 */
export const TOUCH_PRIMARY_QUERY = '(pointer: coarse) and (hover: none)'

type MediaWindow = Pick<Window, 'matchMedia'> | undefined

const currentWindow = (): MediaWindow => (typeof window === 'undefined' ? undefined : window)

export function enterInsertsNewline(win: MediaWindow = currentWindow()): boolean {
  return typeof win?.matchMedia === 'function' && win.matchMedia(TOUCH_PRIMARY_QUERY).matches
}

/** `keyCode` 229 is Safari's Enter that commits an IME candidate with `isComposing` already false. */
export type ComposerEnterEvent = SubmitShortcutEvent & { keyCode?: number }

/** Does this keydown send the message, given what Enter means on this device? */
export function composerEnterSends(event: ComposerEnterEvent, newlineOnEnter: boolean): boolean {
  if (event.keyCode === 229) return false
  if (!isSubmitShortcut(event)) return false
  return !newlineOnEnter || event.metaKey || event.ctrlKey
}

function subscribe(onChange: () => void): () => void {
  const win = currentWindow()
  if (typeof win?.matchMedia !== 'function') return () => {}
  const query = win.matchMedia(TOUCH_PRIMARY_QUERY)
  query.addEventListener?.('change', onChange)
  return () => query.removeEventListener?.('change', onChange)
}

/** Live: attaching a mouse to a tablet flips it. */
export function useEnterInsertsNewline(): boolean {
  return useSyncExternalStore(subscribe, () => enterInsertsNewline(), () => false)
}
