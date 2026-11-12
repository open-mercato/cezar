import * as React from 'react'

import { isApplePlatform, shortcutsBlocked, tabHint } from '@/lib/keybindings'
import { useKeybindings } from '@/lib/use-keybindings'
import { useModifierHeld } from '@/lib/use-modifier-held'

import { viewLabel, type ViewId } from './layout-state'

/** A tab of the row: a view, or Notes — its own page, painted among the views. */
export type StripTab = ViewId | 'notes'

/** The row's order: the views, with Notes among the run group — after Graph when the row has one,
 *  else before Assets or Terminal, else last. */
export function stripTabs(views: readonly ViewId[]): StripTab[] {
  const graph = views.indexOf('graph')
  if (graph >= 0) return [...views.slice(0, graph + 1), 'notes', ...views.slice(graph + 1)]
  const at = views.findIndex((view) => view === 'assets' || view === 'terminal')
  return at < 0 ? [...views, 'notes'] : [...views.slice(0, at), 'notes', ...views.slice(at)]
}

/** The strip's three groups, a hairline between them: Chat | the review (what the task changed)
 *  | the run (how it ran, what it published). Tabs keep their drag and ⌥-click; only the row's
 *  reading changes. */
export type StripGroup = 'chat' | 'review' | 'run'

export const STRIP_GROUP_OF: Record<StripTab, StripGroup> = {
  session: 'chat',
  changes: 'review',
  commits: 'review',
  files: 'review',
  browser: 'review',
  graph: 'run',
  notes: 'run',
  assets: 'run',
  terminal: 'run',
}

/** `tabs` cut into its consecutive groups, empty groups dropped — what the row paints between
 *  separators. Order is the caller's; a tab never moves across a hairline. */
export function stripGroups<T extends StripTab>(tabs: readonly T[]): T[][] {
  const groups: T[][] = []
  let last: StripGroup | null = null
  for (const tab of tabs) {
    const group = STRIP_GROUP_OF[tab]
    if (group !== last || groups.length === 0) groups.push([])
    groups[groups.length - 1]!.push(tab)
    last = group
  }
  return groups
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
