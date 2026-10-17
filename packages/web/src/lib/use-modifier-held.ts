import * as React from 'react'

import { isApplePlatform } from './keybindings'

/** Long enough that ⌘C, ⌘V and friends never flash the hints; short enough to feel immediate. */
export const MODIFIER_HOLD_MS = 350

/**
 * Is the platform's command modifier (⌘ on Apple, Ctrl elsewhere) being held ON ITS OWN? True only
 * after `MODIFIER_HOLD_MS` of a plain hold, and only while `allowed()` — the "show me the
 * shortcuts" gesture (spec 2026-10-17-task-palette).
 *
 *  - A plain hold only: Shift, ⌥ or ⌃ joining in, or a key pressed before the hints show (⌘C,
 *    ⌘⇧4), means a chord, not a question — nothing shows, and what shows goes.
 *  - Once shown, digits keep them up (⌘2 then ⌘3 — the keys they advertise).
 *  - A missed release cannot strand them: the OS screenshot overlay (⌘⇧4/5) and ⌘Tab swallow the
 *    keyup, so every later key, pointer move or click is checked for the modifier still being
 *    down, besides blur and a hidden tab.
 */
export function useModifierHeld(enabled = true, allowed: () => boolean = () => true): boolean {
  const [held, setHeld] = React.useState(false)
  const allowedRef = React.useRef(allowed)
  allowedRef.current = allowed
  React.useEffect(() => {
    if (!enabled) return
    const apple = isApplePlatform()
    const modifier = apple ? 'Meta' : 'Control'
    const otherModifiers = new Set(['Shift', 'Alt', 'AltGraph', apple ? 'Control' : 'Meta'])
    const modifierDown = (event: KeyboardEvent | PointerEvent) => (apple ? event.metaKey : event.ctrlKey)
    const plain = (event: KeyboardEvent) =>
      !event.shiftKey && !event.altKey && !(apple ? event.ctrlKey : event.metaKey)
    let timer: ReturnType<typeof setTimeout> | undefined
    let shown = false
    // Re-asked after every key while shown: ⌘ then K opens a palette, which takes the keys away.
    let recheck: ReturnType<typeof setTimeout> | undefined
    const release = () => {
      clearTimeout(recheck)
      clearTimeout(timer)
      timer = undefined
      if (shown) setHeld(false)
      shown = false
    }
    const show = () => {
      timer = undefined
      if (!allowedRef.current()) return
      shown = true
      setHeld(true)
    }
    const onDown = (event: KeyboardEvent) => {
      if (event.key === modifier) {
        if (!event.repeat && timer === undefined && !shown && plain(event)) {
          timer = setTimeout(show, MODIFIER_HOLD_MS)
        }
        return
      }
      if (timer === undefined && !shown) return
      // The modifier is no longer down (its keyup went elsewhere), or a chord is forming.
      if (!modifierDown(event) || otherModifiers.has(event.key) || !plain(event)) return release()
      if (!shown) {
        // ⌘C and friends: a shortcut, not a request to see the hints.
        clearTimeout(timer)
        timer = undefined
        return
      }
      clearTimeout(recheck)
      recheck = setTimeout(() => {
        if (!allowedRef.current()) release()
      }, 0)
    }
    const onUp = (event: KeyboardEvent) => {
      if (event.key === modifier || ((timer !== undefined || shown) && !modifierDown(event))) release()
    }
    const onPointer = (event: PointerEvent) => {
      if ((timer !== undefined || shown) && !modifierDown(event)) release()
    }
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') release()
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('pointermove', onPointer)
    window.addEventListener('pointerdown', onPointer)
    window.addEventListener('blur', release)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      release()
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('pointermove', onPointer)
      window.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('blur', release)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [enabled])
  return held
}
