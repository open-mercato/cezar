import { useCallback, useEffect, useRef, useState } from 'react'

import { getRunLayouts, putRunLayouts } from '@/api/client'

import {
  addColumn as addColumnTo,
  addLayout as addLayoutTo,
  openBeside as openBesideOf,
  activeLayout as activeLayoutOf,
  closeColumn as closeColumnOf,
  closeLayout as closeLayoutOf,
  dropView as dropViewOn,
  moveColumn as moveColumnOf,
  openDeepLink as openDeepLinkOn,
  openInBrowser as openInBrowserOn,
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
  /** The host has not ANSWERED for this task's layouts yet (the read failed and is being retried).
   *  The workspace runs on a stand-in default meanwhile and nothing is saved over the host's copy. */
  loadFailed: boolean
  /** How many times a late answer from the host REPLACED the stand-in for this task. A late
   *  "never opened" keeps what the user built and does not count. */
  replaced: number
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
   *  list is the only caller (spec §7, `Otwórz w Przeglądarce`). Placement is `openInBrowser` in
   *  `layout-state.ts`; returns false when there was no room, so the caller can say so rather
   *  than appearing to do nothing. */
  openInBrowser: (url: string) => boolean
  /** Show `view` beside what is on screen (see `openBeside`), and say where it landed so the
   *  caller can tell that window what to show. `null` before the layouts have loaded. */
  openBeside: (view: ViewId) => { name: string; index: number } | null
  /** The deep-link entry (`/tasks/:id/changes` and friends) — idempotent, so a refresh does not
   *  pile up cards. Called from an effect by the route, not during render. */
  openDeepLink: (view: ViewId) => void
  /** A view tab dropped on the workspace (see `dropView`). */
  dropView: (view: ViewId, at: number, mode: 'insert' | 'replace') => void
}

/** How long a burst of changes is collected before one save goes out. Long enough that a whole
 *  divider drag is one write, short enough that closing the tab right after a change still saves
 *  it in practice. */
const SAVE_DEBOUNCE_MS = 400

/** How long after a refused save the one retry goes out. */
const SAVE_RETRY_MS = 1500

/** How long after a failed READ the next one goes out, doubling up to the cap. */
const LOAD_RETRY_MS = 2000
const LOAD_RETRY_MAX_MS = 30_000

export function useWorkspaceLayouts(taskId: string): WorkspaceLayouts {
  const [state, setState] = useState<WorkspaceState>(defaultState)
  const [ready, setReady] = useState(false)
  /** The host refused the last save (a read-only home, a full disk). Surfaced, never swallowed:
   *  §2 asks that a degraded capability produce a CLEAR state, not an invisible one. */
  const [saveFailed, setSaveFailed] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [replaced, setReplaced] = useState(0)
  /** The task whose layouts the host has actually ANSWERED for. Saving is allowed for that task
   *  only: a write after a failed read would put a fabricated default over the saved layouts. A
   *  task id rather than a flag, so task A's leave-time flush still goes out after the id changed. */
  const answered = useRef<string | null>(null)
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
    setLoadFailed(false)
    setReplaced(0)
  }

  useEffect(() => {
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | null = null
    // An answer from an earlier visit says nothing about the host's copy now. Safe here: the
    // previous task's leave-time flush ran in the cleanup phase, before any setup.
    answered.current = null
    const adopt = (next: WorkspaceState) => {
      loaded.current = { taskId, state: next }
      // What the host just gave us needs no saving back.
      sent.current = next
      latest.current = { taskId, state: next }
      setState(next)
      setReady(true)
    }
    const read = async (failures: number): Promise<void> => {
      let answer: Awaited<ReturnType<typeof getRunLayouts>>
      try {
        answer = await getRunLayouts(taskId)
      } catch {
        if (cancelled) return
        // An unreachable host is not a reason to refuse the task its workspace — but a FAILED read
        // is not "nothing saved" either. The default below is a stand-in that is never written
        // (`answered` stays unset), and the read is retried until the host answers.
        if (failures === 0) adopt(defaultState())
        setLoadFailed(true)
        retry = setTimeout(
          () => void read(failures + 1),
          Math.min(LOAD_RETRY_MAX_MS, LOAD_RETRY_MS * 2 ** failures),
        )
        return
      }
      if (cancelled) return
      answered.current = taskId
      // A debounce armed on the stand-in must not outlive the answer: it could fire before React
      // commits it and PUT the stand-in over the saved layouts. The save effect re-arms if needed.
      if (pending.current) clearTimeout(pending.current)
      pending.current = null
      setLoadFailed(false)
      // Never opened, answered late: what was built on the stand-in meanwhile is this task's first
      // workspace. `loaded` keeps the stand-in, so the save effect sees the difference and sends it.
      if (failures > 0 && answer.layouts === null) return
      // Both `null` and an empty list open a fresh `Czat`, which is what §5.3 asks for: "If the
      // user deleted all layouts … reopening that task creates a fresh default `Czat` layout."
      // The emptiness that DOES survive is a card with no columns (§10), which is a layout and
      // revives as one. `reviveState` repairs anything malformed rather than failing.
      adopt(answer.layouts === null ? defaultState() : reviveState(answer.layouts))
      if (failures > 0) setReplaced((count) => count + 1)
    }
    void read(0)
    return () => {
      cancelled = true
      if (retry) clearTimeout(retry)
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

  const save = useCallback((forTask: string, value: WorkspaceState, keepalive = false) => {
    // No write without a read: see `answered`.
    if (answered.current !== forTask) return
    sent.current = value
    const ticket = (seq.current += 1)
    // The outcome is a fact about `forTask`; said only while that task is the one on screen, or
    // task A's failed leave-time save raises the banner over task B.
    const report = (failed: boolean) => {
      if (ticket === seq.current && loaded.current.taskId === forTask) setSaveFailed(failed)
    }
    const attempt = (retriesLeft: number): void => {
      void (keepalive ? putRunLayouts(forTask, value, { keepalive }) : putRunLayouts(forTask, value))
        .then(() => report(false))
        .catch((error: unknown) => {
          // Only the newest save speaks: an older one failing says nothing about what is stored,
          // and a newer one is already carrying everything this one held.
          if (ticket !== seq.current) return
          // A 400 is the host refusing THIS document; sending it again cannot go differently.
          if ((error as { status?: number } | null)?.status === 400) return report(true)
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
          report(true)
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
  const flush = useCallback((keepalive = false) => {
    const due = latest.current
    if (!due || due.state === sent.current) return
    if (pending.current) clearTimeout(pending.current)
    pending.current = null
    save(due.taskId, due.state, keepalive)
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
    // `loadFailed` is a dependency for its falling edge: a change made before the host answered
    // is sent once it has.
  }, [ready, save, taskId, state, loadFailed])

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
    // `keepalive`: a fetch first issued while the document is being torn down is otherwise
    // aborted with it.
    const onHide = () => flush(true)
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
    loadFailed,
    replaced,
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
    dropView: useCallback(
      (view: ViewId, at: number, mode: 'insert' | 'replace') =>
        setState((current) => dropViewOn(current, view, at, mode)),
      [],
    ),
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
       * was looking at when they clicked. Both halves ask the one pure transition, so the answer
       * and the change cannot drift.
       */
      const committed = latest.current?.state
      if (!committed || openInBrowserOn(committed, url) === null) return false
      setState((current) => openInBrowserOn(current, url) ?? current)
      return true
    }, []),
    openBeside: useCallback((view: ViewId) => {
      // Answered from the COMMITTED state, for the reason `openInBrowser` gives above.
      const committed = latest.current?.state ?? loaded.current.state
      if (!committed) return null
      const placed = openBesideOf(committed, view)
      if (!placed) return null
      setState((current) => openBesideOf(current, view)?.state ?? current)
      return { name: placed.name, index: placed.index }
    }, []),
  }
}
