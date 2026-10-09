import { useCallback, useEffect, useRef, useState } from 'react'

import { getRunLayouts, putRunLayouts } from '@/api/client'

import {
  addColumn as addColumnTo,
  addLayout as addLayoutTo,
  openBeside as openBesideOf,
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
  /** The owning host could not store the last change. The workspace keeps working from memory;
   *  the route says so rather than letting the user find out on the next reload. */
  saveFailed: boolean
  /** The selected card, or `undefined` while the workspace is intentionally empty. */
  layout: WorkspaceLayout | undefined
  addLayout: (view?: ViewId) => void
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
  /** Show `view` beside what is on screen (see `openBeside`), and say where it landed so the
   *  caller can tell that window what to show. `null` before the layouts have loaded. */
  openBeside: (view: ViewId) => { name: string; index: number } | null
  /** The deep-link entry (`/tasks/:id/changes` and friends) — idempotent, so a refresh does not
   *  pile up cards. Called from an effect by the route, not during render. */
  openDeepLink: (view: ViewId) => void
}

/** How long a burst of changes is collected before one save goes out. Long enough that a whole
 *  divider drag is one write, short enough that closing the tab right after a change still saves
 *  it in practice. */
const SAVE_DEBOUNCE_MS = 400

/** How long after a refused save the one retry goes out. */
const SAVE_RETRY_MS = 1500

export function useWorkspaceLayouts(taskId: string): WorkspaceLayouts {
  const [state, setState] = useState<WorkspaceState>(defaultState)
  const [ready, setReady] = useState(false)
  /** The host refused the last save (a read-only home, a full disk). Surfaced, never swallowed:
   *  §2 asks that a degraded capability produce a CLEAR state, not an invisible one. */
  const [saveFailed, setSaveFailed] = useState(false)
  // Which task `state` belongs to, and the exact object the host gave us for it. The first tells
  // us when to re-read; the second keeps the arrival from being written straight back, so merely
  // VISITING a task never writes to the host.
  const loaded = useRef<{ taskId: string; state: WorkspaceState | null }>({ taskId, state: null })

  // During render, not in an effect: run B must not paint run A's columns for a frame first.
  if (loaded.current.taskId !== taskId) {
    loaded.current = { taskId, state: null }
    setState(defaultState())
    setReady(false)
    // Task A's "could not save" is not a fact about task B — the banner goes with the task.
    setSaveFailed(false)
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      let next: WorkspaceState
      try {
        const answer = await getRunLayouts(taskId)
        // Both `null` and an empty list open a fresh `Czat`, which is what §5.3 asks for: "If the
        // user deleted all layouts … reopening that task creates a fresh default `Czat` layout."
        // The emptiness that DOES survive is a card with no columns (§10), which is a layout and
        // revives as one. `reviveState` repairs anything malformed rather than failing.
        next = answer.layouts === null ? defaultState() : reviveState(answer.layouts)
      } catch {
        // An unreachable host is not a reason to refuse the task its workspace.
        next = defaultState()
      }
      if (cancelled) return
      loaded.current = { taskId, state: next }
      // What the host just gave us needs no saving back.
      sent.current = next
      latest.current = { taskId, state: next }
      setState(next)
      setReady(true)
    })()
    return () => {
      cancelled = true
    }
  }, [taskId])

  /**
   * Save, but COALESCED — spec §5.3 singles out high-frequency divider movement as the thing not
   * to persist per event.
   *
   * A drag calls `resizeColumns` on every `pointermove`, so a naive write-on-change turns one
   * drag into dozens of PUTs, each a synchronous atomic file write on the host. The trailing
   * debounce collapses a drag into one save; structural changes (a card added, a column closed)
   * are debounced by the same timer and land a moment later, which is invisible and keeps one
   * rule instead of two.
   *
   * `seq` guards ORDER rather than rate: responses can arrive out of order, so a save that was
   * superseded while in flight must not be the last writer. Only the newest issued save is
   * allowed to report an outcome.
   */
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seq = useRef(0)
  /** The newest (task, state) a save would be for. Read by the flush paths, which run outside the
   *  render that produced them. */
  const latest = useRef<{ taskId: string; state: WorkspaceState } | null>(null)

  /** The last state a PUT was issued for. What makes a flush idempotent and a drop impossible. */
  const sent = useRef<WorkspaceState | null>(null)

  const save = useCallback((forTask: string, value: WorkspaceState) => {
    sent.current = value
    const ticket = (seq.current += 1)
    const attempt = (retriesLeft: number): void => {
      void putRunLayouts(forTask, value)
        .then(() => {
          if (ticket === seq.current) setSaveFailed(false)
        })
        .catch(() => {
          // Only the newest save speaks: an older one failing says nothing about what is stored,
          // and a newer one is already carrying everything this one held.
          if (ticket !== seq.current) return
          // One refusal is not yet a fact about the host: a save that lands while the server is
          // restarting, or loses a rename to another cezar on the same repo, succeeds a moment
          // later. Without the second try that blip left "could not be saved" on screen — and the
          // layout really unsaved — until the user happened to change something else.
          if (retriesLeft > 0) {
            setTimeout(() => {
              if (ticket === seq.current) attempt(retriesLeft - 1)
            }, SAVE_RETRY_MS)
            return
          }
          setSaveFailed(true)
        })
    }
    attempt(1)
  }, [])

  /**
   * Send the newest change now, if it has not been sent.
   *
   * Keyed on WHAT WAS SENT, never on the timer handle. React runs effect cleanups in declaration
   * order, so the debounce effect's cleanup — declared first — nulls `pending` before this one
   * runs; a flush that asked "is a timer pending?" therefore always answered no on the way out,
   * and silently dropped the user's last change. `sent` is the only thing that knows.
   */
  const flush = useCallback(() => {
    const due = latest.current
    if (!due || due.state === sent.current) return
    if (pending.current) clearTimeout(pending.current)
    pending.current = null
    save(due.taskId, due.state)
  }, [save])

  useEffect(() => {
    // Nothing to save until the host has answered, and never an echo of what it just sent.
    if (!ready || loaded.current.taskId !== taskId || state === loaded.current.state) return
    latest.current = { taskId, state }
    if (pending.current) clearTimeout(pending.current)
    pending.current = setTimeout(() => {
      pending.current = null
      save(taskId, state)
    }, SAVE_DEBOUNCE_MS)
    // Only the timer is cleared here: this cleanup runs on EVERY change, and flushing from it
    // would send one write per pointermove — the thing the debounce exists to prevent. The two
    // cases that must not lose the change are handled below.
    return () => {
      if (pending.current) clearTimeout(pending.current)
      pending.current = null
    }
  }, [ready, save, taskId, state])

  /**
   * Leaving must not drop the last change.
   *
   * This cleanup runs only when the TASK changes or the workspace unmounts — never on an ordinary
   * state change — so it is the one place a pending write is the user's final word rather than
   * something a newer render is about to supersede. Without it the debounce had a way to lose
   * work outright: build a split, leave the task, come back to the layout you had before it.
   *
   * `pagehide` covers the other exit, closing the tab or reloading, which React never sees.
   */
  useEffect(() => {
    const onHide = () => flush()
    window.addEventListener('pagehide', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
      flush()
    }
  }, [flush, taskId])

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
    saveFailed,
    layout: activeLayoutOf(state),
    addLayout: useCallback((view?: ViewId) => setState((current) => addLayoutTo(current, view)), []),
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
      /*
       * DECIDED off the committed state, then applied through the updater.
       *
       * The answer used to be assigned inside the updater and returned on the line after
       * `setState`, which only ever worked because of React's eager-state fast path: the moment
       * another update was already queued on this hook in the same batch — and a debounced
       * layout save is never more than `SAVE_DEBOUNCE_MS` away — the updater ran AFTER the
       * return, so `placed` was still false and the caller announced "no room" about a tab that
       * had just opened.
       *
       * `latest.current` is the state React has committed, which is also the workspace the user
       * was looking at when they clicked. The cap is read by asking `addColumn` rather than by
       * restating the rule here, so the two cannot drift.
       */
      const committed = latest.current?.state
      const layout = committed ? activeLayoutOf(committed) : undefined
      if (!committed || !layout) return false
      const index = layout.columns.findIndex((column) => column.view === 'browser')
      if (index < 0 && addColumnTo(committed, layout.name, 'browser') === committed) return false

      setState((current) => {
        const active = activeLayoutOf(current)
        if (!active) return current
        const position = active.columns.findIndex((column) => column.view === 'browser')
        if (position >= 0) {
          // An existing Browser column gets the address as a new tab, activated.
          const browser = active.columns[position]!.browser ?? { tabs: [''], active: 0 }
          // A blank tab is a slot, not a tab worth keeping beside the new one.
          const tabs = browser.tabs.filter((tab) => tab !== '')
          return setColumnBrowserOf(current, active.name, position, { tabs: [...tabs, url], active: tabs.length })
        }
        const added = addColumnTo(current, active.name, 'browser')
        if (added === current) return current
        const grown = activeLayoutOf(added)!
        return setColumnBrowserOf(added, grown.name, grown.columns.length - 1, { tabs: [url], active: 0 })
      })
      return true
    }, []),
    openBeside: useCallback((view: ViewId) => {
      // Answered from the COMMITTED state, for the reason `openInBrowser` gives above.
      const committed = latest.current?.state ?? loaded.current.state
      if (!committed) return null
      const placed = openBesideOf(committed, view)
      setState((current) => openBesideOf(current, view).state)
      return { name: placed.name, index: placed.index }
    }, []),
  }
}
