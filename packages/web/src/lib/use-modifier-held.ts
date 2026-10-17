import * as React from 'react'

import { isApplePlatform } from './keybindings'

/** Long enough that ⌘C, ⌘V and friends never flash the hints; short enough to feel immediate. */
export const MODIFIER_HOLD_MS = 350

/**
 * Is the platform's command modifier (⌘ on Apple, Ctrl elsewhere) being held? True only after
 * `MODIFIER_HOLD_MS` of holding — the "show me the shortcuts" gesture (spec
 * 2026-10-17-task-palette). Stays true while further keys are pressed with it, so ⌘2 then ⌘3
 * keeps the hints up; drops on release, on leaving the window, or when the tab is hidden (⌘Tab
 * away never delivers the keyup).
 */
export function useModifierHeld(enabled = true): boolean {
  const [held, setHeld] = React.useState(false)
  React.useEffect(() => {
    if (!enabled) return
    const modifier = isApplePlatform() ? 'Meta' : 'Control'
    let timer: ReturnType<typeof setTimeout> | undefined
    const release = () => {
      clearTimeout(timer)
      timer = undefined
      setHeld(false)
    }
    const onDown = (event: KeyboardEvent) => {
      if (event.key === modifier && !event.repeat && timer === undefined) {
        timer = setTimeout(() => setHeld(true), MODIFIER_HOLD_MS)
      }
    }
    const onUp = (event: KeyboardEvent) => {
      if (event.key === modifier) release()
    }
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') release()
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', release)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      release()
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', release)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [enabled])
  return held
}
