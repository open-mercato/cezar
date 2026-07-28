/**
 * The composer submit rule (spec, cross-cutting keyboard rule): **Enter sends, Shift+Enter
 * inserts a newline, and ⌘↵ / Ctrl+↵ also send — in every prompting surface.** One predicate,
 * shared by the thread composer and (R4) the new-task composer, in the same family as
 * `use-command-shortcut.ts`: macOS and Windows/Linux modifiers are decided together, never as
 * two bindings that can drift.
 *
 * Unlike the ⌘K family this is not a global listener — it reads the keydown of the composer's
 * own textarea — so the module exports the predicate only; the composer wires it into its
 * existing onKeyDown. Exported as a structural-event function so the matrix (plain / Shift /
 * ⌘ / Ctrl / Alt / IME composition / auto-repeat) is table-testable without DOM events.
 */

/** The structural subset of a (React or native) keyboard event the rule reads. `isComposing`
 *  is optional because React's synthetic events surface it via `nativeEvent` — callers pass
 *  whichever object carries it. */
export type SubmitShortcutEvent = {
  key: string
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  repeat?: boolean
  isComposing?: boolean
}

/**
 * Does this keydown mean "send the message"?
 *
 *  - Plain Enter sends (the legacy message bar's rule — muscle memory to keep).
 *  - ⌘↵ and Ctrl+↵ ALSO send — the spec's cross-surface chord, both platforms together.
 *  - Shift+Enter never sends: it is the newline. Shift wins even combined with ⌘/Ctrl.
 *  - Alt+Enter is left alone (unbound — on some layouts it types, and we must not eat it).
 *  - A held key (`repeat`) must not machine-gun messages.
 *  - Mid-IME-composition Enter commits the composition, not the message — never send.
 */
export function isSubmitShortcut(event: SubmitShortcutEvent): boolean {
  if (event.key !== 'Enter') return false
  if (event.shiftKey || event.altKey) return false
  if (event.repeat) return false
  if (event.isComposing) return false
  return true
}

/** The kbd hint next to a submit button, in the platform's own symbols (spec: "kbd hints
 *  render the platform's symbol"): ⌘↵ on Apple hardware, Ctrl+↵ everywhere else. The platform
 *  string is injectable for tests; the default reads the browser's. */
export function submitShortcutHint(
  platform: string = typeof navigator === 'undefined' ? '' : navigator.platform,
): string {
  return /mac|iphone|ipad|ipod/i.test(platform) ? '⌘↵' : 'Ctrl+↵'
}
