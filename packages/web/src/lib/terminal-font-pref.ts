import { useSyncExternalStore } from 'react'

/** Task-workspace terminal font size (#2435). Per browser, like the theme: it depends on the
 *  screen and the reader's eyes. Default stays 12.5; every read is clamped. */
export const TERMINAL_FONT_STORAGE_KEY = 'cez-terminal-font-size'
export const TERMINAL_FONT_DEFAULT = 12.5
export const TERMINAL_FONT_MIN = 8
export const TERMINAL_FONT_MAX = 32
const CHANGE_EVENT = 'cez-terminal-font-change'

export function clampTerminalFont(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(n)) return TERMINAL_FONT_DEFAULT
  return Math.min(TERMINAL_FONT_MAX, Math.max(TERMINAL_FONT_MIN, n))
}

export function readTerminalFont(): number {
  try {
    const raw = localStorage.getItem(TERMINAL_FONT_STORAGE_KEY)
    return raw === null ? TERMINAL_FONT_DEFAULT : clampTerminalFont(Number(raw))
  } catch {
    return TERMINAL_FONT_DEFAULT
  }
}

export function writeTerminalFont(size: number): void {
  try {
    localStorage.setItem(TERMINAL_FONT_STORAGE_KEY, String(clampTerminalFont(size)))
  } catch {
    // Private mode / storage full: the size still applies to this page through the event.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

/** Step by one point; `0` resets to the default. */
export function stepTerminalFont(delta: number): void {
  writeTerminalFont(delta === 0 ? TERMINAL_FONT_DEFAULT : readTerminalFont() + delta)
}

export function subscribeTerminalFont(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange)
  window.addEventListener('storage', onChange)
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange)
    window.removeEventListener('storage', onChange)
  }
}

export function useTerminalFont(): number {
  return useSyncExternalStore(subscribeTerminalFont, readTerminalFont, () => TERMINAL_FONT_DEFAULT)
}
