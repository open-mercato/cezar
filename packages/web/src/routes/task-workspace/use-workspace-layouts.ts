import { useCallback, useEffect, useRef, useState } from 'react'

import {
  addColumn as addColumnTo,
  addLayout as addLayoutTo,
  activeLayout as activeLayoutOf,
  closeColumn as closeColumnOf,
  closeLayout as closeLayoutOf,
  moveColumn as moveColumnOf,
  openDeepLink as openDeepLinkOn,
  readState,
  renameLayout as renameLayoutOf,
  resizeColumns as resizeColumnsOf,
  selectLayout as selectLayoutOf,
  setColumnBrowser as setColumnBrowserOf,
  setColumnView as setColumnViewOf,
  writeState,
  type BrowserState,
  type ViewId,
  type WorkspaceLayout,
  type WorkspaceState,
} from './layout-state'

/**
 * The React half of the saved layouts (spec `.ai/specs/2026-10-07-task-workspace.md` §5.3): the
 * pure transitions in `layout-state.ts`, bound to one task and mirrored into `localStorage`.
 *
 * Re-reading on a CHANGED task id is load-bearing rather than defensive. Navigating run A → run B
 * stays on the same route path, so React reconciles the same element and does NOT remount — the
 * same reason `RunHeader` keeps its phone-disclosure map run-keyed. Plain `useState`, even lazily
 * initialized, would carry run A's columns into run B, which is the one thing §5.3 forbids
 * outright ("Switching to another task must not carry the previous task's transient panel state
 * into it"). The read happens during render, not in an effect, so run B never paints run A's
 * layout for a frame first.
 */
export interface WorkspaceLayouts {
  state: WorkspaceState
  /** The selected card, or `undefined` while the workspace is intentionally empty. */
  layout: WorkspaceLayout | undefined
  addLayout: (view: ViewId) => void
  closeLayout: (name: string) => void
  selectLayout: (name: string) => void
  renameLayout: (name: string, requested: string) => void
  addColumn: (view: ViewId) => void
  closeColumn: (index: number) => void
  setColumnView: (index: number, view: ViewId) => void
  resizeColumns: (index: number, delta: number) => void
  moveColumn: (from: number, to: number) => void
  setColumnBrowser: (index: number, browser: BrowserState) => void
  /** Open an address in a Browser column of the active layout — the terminal's detected-URL
   *  list is the only caller (spec §7, `Otwórz w Przeglądarce`). Reuses a Browser column when the
   *  layout has one and adds one otherwise; returns false when there was no room, so the caller
   *  can say so rather than appearing to do nothing. */
  openInBrowser: (url: string) => boolean
  /** The deep-link entry (`/tasks/:id/changes` and friends) — idempotent, so a refresh does not
   *  pile up cards. Called from an effect by the route, not during render. */
  openDeepLink: (view: ViewId) => void
}

export function useWorkspaceLayouts(taskId: string): WorkspaceLayouts {
  const [state, setState] = useState<WorkspaceState>(() => readState(taskId))
  // Which task `state` belongs to, and the exact object we read for it. The first tells us when to
  // re-read; the second keeps the mount from writing back what it just read, so merely VISITING a
  // task never touches storage.
  const loaded = useRef({ taskId, state })

  if (loaded.current.taskId !== taskId) {
    const fresh = readState(taskId)
    loaded.current = { taskId, state: fresh }
    setState(fresh)
  }

  useEffect(() => {
    if (state === loaded.current.state) return
    writeState(taskId, state)
  }, [taskId, state])

  // Every action is the pure transition applied to the LATEST state (the updater form), so a
  // double-invoked render or two clicks in one tick cannot drop one of them. The active card's
  // name comes from that same snapshot rather than from the closure, for the same reason.
  const onActive = useCallback(
    (transition: (state: WorkspaceState, name: string) => WorkspaceState) => {
      setState((current) => (current.active ? transition(current, current.active) : current))
    },
    [],
  )

  return {
    state,
    layout: activeLayoutOf(state),
    addLayout: useCallback((view: ViewId) => setState((current) => addLayoutTo(current, view)), []),
    closeLayout: useCallback((name: string) => setState((current) => closeLayoutOf(current, name)), []),
    selectLayout: useCallback((name: string) => setState((current) => selectLayoutOf(current, name)), []),
    renameLayout: useCallback(
      (name: string, requested: string) => setState((current) => renameLayoutOf(current, name, requested)),
      [],
    ),
    addColumn: useCallback(
      (view: ViewId) => onActive((current, name) => addColumnTo(current, name, view)),
      [onActive],
    ),
    closeColumn: useCallback(
      (index: number) => onActive((current, name) => closeColumnOf(current, name, index)),
      [onActive],
    ),
    setColumnView: useCallback(
      (index: number, view: ViewId) => onActive((current, name) => setColumnViewOf(current, name, index, view)),
      [onActive],
    ),
    resizeColumns: useCallback(
      (index: number, delta: number) => onActive((current, name) => resizeColumnsOf(current, name, index, delta)),
      [onActive],
    ),
    moveColumn: useCallback(
      (from: number, to: number) => onActive((current, name) => moveColumnOf(current, name, from, to)),
      [onActive],
    ),
    openDeepLink: useCallback((view: ViewId) => setState((current) => openDeepLinkOn(current, view)), []),
    setColumnBrowser: useCallback(
      (index: number, browser: BrowserState) =>
        onActive((current, name) => setColumnBrowserOf(current, name, index, browser)),
      [onActive],
    ),
    openInBrowser: useCallback((url: string) => {
      let placed = false
      setState((current) => {
        const layout = activeLayoutOf(current)
        if (!layout) return current
        const index = layout.columns.findIndex((column) => column.view === 'browser')
        if (index >= 0) {
          // An existing Browser column gets the address as a new tab, activated.
          const browser = layout.columns[index]!.browser ?? { tabs: [''], active: 0 }
          // A blank tab is a slot, not a tab worth keeping beside the new one.
          const tabs = browser.tabs.filter((tab) => tab !== '')
          placed = true
          return setColumnBrowserOf(current, layout.name, index, { tabs: [...tabs, url], active: tabs.length })
        }
        const added = addColumnTo(current, layout.name, 'browser')
        // `addColumn` is a no-op at the column cap; saying so beats silently doing nothing.
        if (added === current) return current
        placed = true
        const grown = activeLayoutOf(added)!
        return setColumnBrowserOf(added, grown.name, grown.columns.length - 1, { tabs: [url], active: 0 })
      })
      return placed
    }, []),
  }
}
