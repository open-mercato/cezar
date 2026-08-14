import * as React from 'react'
import type { ReactNode } from 'react'

import type { ListView } from '@/lib/task-groups'

/**
 * The Active/Archived filter, shared by the sidebar quick-list and (Step 3.4) the Tasks table.
 *
 * The spec requires the table's tabs to "share state with the sidebar quick-list tabs", and the
 * legacy UI got that for free by keeping a single `state.listView` global. Two surfaces in two
 * subtrees need one value, so it is context rather than a `useState` in either of them — a
 * quick-list that switched to Archived while the table still showed Active would be two answers
 * to one question.
 *
 * In-memory, not persisted: the legacy filter reset to Active on every reload, and a filter that
 * silently survives a restart hides runs the user does not know are hidden.
 */
const ListViewContext = React.createContext<[ListView, (view: ListView) => void] | null>(null)

export function ListViewProvider({ children }: { children: ReactNode }) {
  const [view, setView] = React.useState<ListView>('active')
  // The tuple is memoized so a re-render of the provider (which sits high in the tree) does not
  // invalidate the context for every consumer below it.
  const value = React.useMemo(() => [view, setView] as [ListView, (view: ListView) => void], [view])
  return <ListViewContext.Provider value={value}>{children}</ListViewContext.Provider>
}

/** Throws without a provider, on purpose: a default would let a consumer mount outside the shell
 *  and quietly keep its own private filter — the exact desync this context exists to prevent. */
export function useListView(): [ListView, (view: ListView) => void] {
  const value = React.useContext(ListViewContext)
  if (!value) throw new Error('useListView must be used inside a <ListViewProvider>')
  return value
}
