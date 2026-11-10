import { shortcutsBlocked } from '@/lib/keybindings'
import { shouldTriggerCommandShortcut, type CommandShortcutEvent } from '@/lib/use-command-shortcut'

/** The review gate's publish chord (#1760). ⌘↵ is reserved as "submit", so it is not rebindable. */
export const REVIEW_PUBLISH_CHORD = 'Mod+Enter'

/**
 * Does this keydown open the review gate's publish dialog? ⌘↵ / Ctrl+↵ only, never from a text
 * field — there it stays *submit* (the notes box's Send back, the composer) — and never while a
 * dialog, palette or menu owns the keyboard.
 */
export function opensReviewPublish(event: CommandShortcutEvent, root: ParentNode = document): boolean {
  return shouldTriggerCommandShortcut(event, 'Enter') && !shortcutsBlocked(root)
}

/** Inside the open dialog: the second ⌘↵ confirms. */
export function confirmsReviewPublish(event: Omit<CommandShortcutEvent, 'target'>): boolean {
  return (
    event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && !event.repeat
  )
}
