import { useCallback, useEffect, useRef, useState } from 'react'

import { getRunLayouts, putRunLayouts } from '@/api/client'

import {
  addColumn as addColumnTo,
  addLayout as addLayoutTo,
  activeLayout as activeLayoutOf,
  closeColumn as closeColumnOf,
  closeLayout as closeLayoutOf,
  moveColumn as moveColumnOf,
  openDeepLink as openDeepLinkOn,
  defaultState,
  renameLayout as renameLayoutOf,
  resizeColumns as resizeColumnsOf,
  reviveState,
  selectLayout as selectLayoutOf,
  setColumnBrowser as setColumnBrowserOf,
  setColumnView as setColumnViewOf,
  type BrowserState,
  type ViewId,
  type WorkspaceLayout,
  type WorkspaceState,
} from './layout-state'

/**
 * The React half of the saved layouts (spec `.ai/specs/2026-10-07-task-workspace.md` §5.3): the
 * pure transitions in `layout-state.ts`, bound to one task and mirrored to THE CEZAR THAT OWNS
 * THE TASK — §5.3: "Persist named layouts per task on the Cezar host that owns the task."
 *
 * Host-side, not browser-side, and the difference is observable: the same task opened from a
 * second browser, a second profile or another machine against the same cezar is the same task and
 * shows the same layouts, and "Layouts are removed only when the task itself is permanently
 * deleted" becomes a promise something can actually keep. A local cezar and a VPS remain separate
 * stores because they are separate hosts, which is the rest of what §5.3 asks for.
 *
 * Switching tasks must never carry run A's columns into run B (§5.3). The read is asynchronous
 * now, so that guarantee is carried by `ready`: on a changed task id the state is replaced with
 * that task's default IMMEDIATELY, during render, and the route holds its loading skeleton until
 * the host answers. Run B therefore never paints run A's layout, not even for a frame.
 *
 * A host that cannot save (a read-only home, a full disk) does not break the workspace: the write
 * fails quietly and the layout the user is looking at keeps working for the rest of the visit.
 */
export interface WorkspaceLayouts {
  state: WorkspaceState
  /** False until this task's layouts have come back from the host. The route shows its loading
   *  skeleton meanwhile, so no card is painted before it is known to be this task's. */
  ready: boolean
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
  const [state, setState] = useState<WorkspaceState>(defaultState)
  const [ready, setReady] = useState(false)
  // Which task `state` belongs to, and the exact object the host gave us for it. The first tells
  // us when to re-read; the second keeps the arrival from being written straight back, so merely
  // VISITING a task never writes to the host.
  const loaded = useRef<{ taskId: string; state: WorkspaceState | null }>({ taskId, state: null })

  // During render, not in an effect: run B must not paint run A's columns for a frame first.
  if (loaded.current.taskId !== taskId) {
    loaded.current = { taskId, state: null }
    setState(defaultState())
    setReady(false)
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      let next: WorkspaceState
      try {
        const answer = await getRunLayouts(taskId)
        // `null` means the task has never been opened — a fresh `Czat`. An empty list is a
        // workspace the user emptied on purpose and stays empty (§5.3); `reviveState` keeps that
        // distinction, and repairs anything malformed rather than failing.
        next = answer.layouts === null ? defaultState() : reviveState(answer.layouts)
      } catch {
        // An unreachable host is not a reason to refuse the task its workspace.
        next = defaultState()
      }
      if (cancelled) return
      loaded.current = { taskId, state: next }
      setState(next)
      setReady(true)
    })()
    return () => {
      cancelled = true
    }
  }, [taskId])

  useEffect(() => {
    // Nothing to save until the host has answered, and never an echo of what it just sent.
    if (!ready || loaded.current.taskId !== taskId || state === loaded.current.state) return
    void putRunLayouts(taskId, state).catch(() => {})
  }, [ready, taskId, state])

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
    ready,
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
