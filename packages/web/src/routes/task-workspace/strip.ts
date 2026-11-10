import * as React from 'react'

import { isApplePlatform, shortcutsBlocked, tabHint } from '@/lib/keybindings'
import { useKeybindings } from '@/lib/use-keybindings'
import { useModifierHeld } from '@/lib/use-modifier-held'

import { viewLabel, type ViewId } from './layout-state'

/** A tab of the row: a view, or Notes — its own page, painted among the views. */
export type StripTab = ViewId | 'notes'

/** The row's order: the views, with Notes placed before Preview (or Terminal, or at the end). */
export function stripTabs(views: readonly ViewId[]): StripTab[] {
  const at = views.findIndex((view) => view === 'browser' || view === 'terminal')
  return at < 0 ? [...views, 'notes'] : [...views.slice(0, at), 'notes', ...views.slice(at)]
}

/**
 * The numbered tabs of a task's row, in the order they are painted (`stripTabs`). ONE order for the ⌘1–⌘9 shortcuts (`tab:N`), the bare 1–9 keys,
 * and the numbers shown while ⌘ is held — so the number on a tab is the key that opens it. Saved
 * layouts are deliberately not numbered (yet): their count and order change as they are made.
 * Ids are the palette's command ids (spec 2026-10-17-task-palette).
 */
export interface StripEntry {
  id: string
  label: string
}

export function stripEntries(views: readonly ViewId[]): StripEntry[] {
  return stripTabs(views).map((tab) =>
    tab === 'notes' ? { id: 'view:notes', label: 'Notes' } : { id: `view:${tab}`, label: viewLabel(tab) },
  )
}

/** Each tab's shortcut badge (its positional ⌘N, else a chord bound to it by id), and whether to
 *  show them — a plain ⌘ hold, while nothing else has the keyboard and the chords can fire. */
export function useStripKeyHints(entries: readonly StripEntry[]): { hints: ReadonlyMap<string, string>; show: boolean } {
  const { bindings } = useKeybindings()
  const show = useModifierHeld(true, notBlocked)
  const signature = entries.map((entry) => entry.id).join('|')
  const hints = React.useMemo(() => {
    const map = new Map<string, string>()
    entries.forEach((entry, index) => {
      const hint = tabHint(bindings.get(`tab:${index + 1}`) ?? bindings.get(entry.id))
      if (hint) map.set(entry.id, hint)
    })
    return map
    // `signature` is `entries`' content; the array itself is rebuilt by every caller's render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bindings, signature])
  return { hints, show }
}

// Off a Mac every Ctrl chord in the terminal is the shell's, so the badges would promise nothing.
const notBlocked = () =>
  !shortcutsBlocked() && (isApplePlatform() || !(document.activeElement instanceof HTMLElement && document.activeElement.closest('.xterm')))
