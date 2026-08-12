import * as React from 'react'

/**
 * The one "cmd-or-ctrl + key" helper (spec, cross-cutting keyboard rule): macOS and
 * Windows/Linux modifiers are always registered together, never as two separate bindings that
 * can drift. ⌘K here, ⌘N here, and later the spec's `useSubmitShortcut` (⌘↵/Ctrl+↵) grows from
 * the same predicate.
 *
 * The predicate is exported separately from the hook so the matrix (modifiers, repeat,
 * editable-target suppression) can be table-tested without dispatching real DOM events.
 */

/** Is the user typing here? Inputs, textareas, selects, and anything contenteditable.
 *  `getAttribute` fallback because jsdom does not implement `isContentEditable`. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.isContentEditable) return true
  return target.closest('[contenteditable=""], [contenteditable="true"]') !== null
}

/** The one editable place a command shortcut still fires: the ⌘K palette's own input —
 *  otherwise ⌘K could open the palette but never close it again. cmdk stamps the attribute. */
function isCommandPaletteInput(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest('[cmdk-input]') !== null
}

/** The shape the predicate reads — a structural subset of KeyboardEvent so tests can hand in
 *  plain objects. */
export type CommandShortcutEvent = Pick<
  KeyboardEvent,
  'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat' | 'target'
>

/**
 * Does this keydown mean "cmd-or-ctrl + `key`"?
 *
 *  - Either modifier: ⌘ on macOS, Ctrl elsewhere — both always accepted, per the spec.
 *  - Alt and Shift disqualify: ⌥⌘K / ⇧⌘K are different (unbound) chords, not sloppy ⌘K.
 *  - `repeat` disqualifies: a held key must fire once, not toggle per auto-repeat frame.
 *  - A focused input/textarea/contenteditable swallows it — except the palette's own input.
 *  - `key` compares case-insensitively so Caps Lock (which reports `K`) still matches.
 */
export function shouldTriggerCommandShortcut(event: CommandShortcutEvent, key: string): boolean {
  if (typeof event.key !== 'string' || event.key.toLowerCase() !== key.toLowerCase()) return false
  if (!event.metaKey && !event.ctrlKey) return false
  if (event.altKey || event.shiftKey) return false
  if (event.repeat) return false
  if (isEditableTarget(event.target) && !isCommandPaletteInput(event.target)) return false
  return true
}

/**
 * Register a global cmd-or-ctrl + `key` shortcut for the component's lifetime.
 *
 * `preventDefault` fires before the handler: the browser owns most of these chords (Ctrl+K is
 * Firefox's search bar, ⌘N a new window) and must not act on the ones we claim. The handler
 * lives in a ref so a fresh closure per render never re-subscribes the listener.
 */
export function useCommandShortcut(key: string, handler: (event: KeyboardEvent) => void): void {
  const handlerRef = React.useRef(handler)
  React.useLayoutEffect(() => {
    handlerRef.current = handler
  })

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!shouldTriggerCommandShortcut(event, key)) return
      event.preventDefault()
      handlerRef.current(event)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [key])
}

/**
 * Does this keydown mean a bare `key` press — no modifier chord?
 *
 * The browser-safe sibling of the command chord: ⌘N/⌘T/⌘W are reserved by the browser and
 * never reach the page (a page's `preventDefault` cannot claim them), so a browser-usable
 * "new task" accelerator has to be a lone letter — the `c`-to-create convention (GitHub,
 * Linear). Any held modifier disqualifies (so it never eats ⌘N in the desktop shell), and —
 * unlike the chord — a focused editable, INCLUDING the ⌘K palette input, always swallows it:
 * a bare letter is a keystroke someone is probably typing.
 */
export function shouldTriggerKeyShortcut(event: CommandShortcutEvent, key: string): boolean {
  if (typeof event.key !== 'string' || event.key.toLowerCase() !== key.toLowerCase()) return false
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false
  if (event.repeat) return false
  if (isEditableTarget(event.target)) return false
  return true
}

/**
 * The kbd hint next to a control the command chord drives (spec: "kbd hints render the
 * platform's symbol") — `⌘K` on Apple hardware, `Ctrl+K` everywhere else. The chord itself is
 * both bindings at once (`shouldTriggerCommandShortcut` accepts either modifier); only the
 * *label* is platform-specific, and it belongs here rather than in each caller so the ⌘K family
 * cannot drift the way two hand-written strings would. The submit chord's twin is
 * `submitShortcutHint` in `use-submit-shortcut.ts`.
 *
 * The platform string is injectable for tests; the default reads the browser's.
 */
export function commandShortcutHint(
  key: string,
  platform: string = typeof navigator === 'undefined' ? '' : navigator.platform,
): string {
  const upper = key.toUpperCase()
  return /mac|iphone|ipad|ipod/i.test(platform) ? `⌘${upper}` : `Ctrl+${upper}`
}

/**
 * Register a global bare-`key` shortcut for the component's lifetime. No `preventDefault` — a
 * lone letter has no browser default to claim. Mirrors `useCommandShortcut`'s ref plumbing.
 */
export function useKeyShortcut(key: string, handler: (event: KeyboardEvent) => void): void {
  const handlerRef = React.useRef(handler)
  React.useLayoutEffect(() => {
    handlerRef.current = handler
  })

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!shouldTriggerKeyShortcut(event, key)) return
      handlerRef.current(event)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [key])
}
