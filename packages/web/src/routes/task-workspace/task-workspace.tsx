import {
  LayoutGridIcon,
  LoaderCircleIcon,
  Maximize2Icon,
  MessageSquareTextIcon,
  SearchXIcon,
  TerminalIcon,
} from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigationType, useParams } from 'react-router'

import { ApiError } from '@/api/client'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useHealth, useMarkRunSeen, useRun } from '@/api/queries'
import { useRunHistory } from '@/api/run-history'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import { Link } from '@/lib/project-router'
import { isUnread } from '@/lib/read-state'
import { rememberViewState } from '@/lib/view-memory'
import { isEditableTarget } from '@/lib/use-command-shortcut'

import { ChangesView } from '../task-git/task-changes'
import { CommitsView } from '../task-git/task-commits'
import { FilesView } from '../task-git/task-files'
import { GitTabLoading } from '../task-git/git-tab-loading'
import { RunHeader } from '../task-thread/run-header'
import { ThreadLoading } from '../task-thread/thread-loading'
import { ThreadView } from '../task-thread/task-thread'
import { useDesignPicks } from '../task-thread/design-picks'
import { useDiffComments } from '../task-thread/diff-comments'
import { useRunRecordReconcile } from '../task-thread/run-reconcile'
import { reduceThread } from '../task-thread/thread-state'

import { BrowserView } from './browser-view'
import { DesignQueues, hasDesignQueues } from './design-dock'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

import { LayoutCards } from './layout-cards'
import { FullViewExit, WorkspaceMaximizeContext, usePanelCover } from './maximize'
import { WorkspaceColumns, type ColumnActions } from './workspace-columns'
import { useWorkspaceLayouts } from './use-workspace-layouts'
import { readDrawerState, writeDrawerState, type DrawerState } from './drawer-state'
import { emptyBrowserState, fixedViewOf, type ViewId, type WorkspaceColumn } from './layout-state'

/** Lazy because it carries the emulator (xterm, ~80 KB gz) and its stylesheet. A task whose
 *  drawer is never opened must not pay for either — the drawer starts hidden on every visit
 *  (spec §6), so that is most visits. */
const TerminalDrawer = lazy(() =>
  import('./terminal-drawer').then((m) => ({ default: m.TerminalDrawer })),
)

/** Lazy for the same reason the drawer is: the graph carries `@xyflow/react` and its layout
 *  engine, and a workspace showing Czat beside Zmiany must not pay for either. */
const GraphColumn = lazy(() =>
  import('../workflow-graph/task-graph').then((m) => ({ default: m.GraphView })),
)

/**
 * `/tasks/:id` — the task workspace (spec `.ai/specs/2026-10-07-task-workspace.md`).
 *
 * The task detail view, not a mode beside it: the SAME `RunHeader` anchors the screen, with its
 * four route tabs replaced by the saved-layout strip, and the view area below holds one to three
 * resizable columns. Each column embeds the existing Conversation, Changes, Commits or Files
 * component — `embedded` drops that component's own header and nothing else, so none of their
 * data fetching, polling, review gates or draft handling is reimplemented here.
 *
 * The three `/changes`, `/files` and `/commits` URLs render this same route with `view` set; the
 * deep link opens its view as a new one-column card and leaves every saved layout alone (§5.3).
 */
export function TaskWorkspaceRoute({ view }: { view?: ViewId }) {
  const { id } = useParams<{ id: string }>()
  const run = useRun(id)

  // The read receipt, verbatim from the Session route it replaces (#unread-done-items, #775):
  // opening a finished task marks it read, and "Mark unread" from this very header suppresses
  // that for the rest of the visit. It lives at the route, not in a column, because it is a
  // property of VISITING the task — a workspace with no Czat column still opens the mail.
  const suppressAutoRead = useRef<string | undefined>(undefined)
  const suppressAutoReadFor = useCallback((runId: string) => {
    suppressAutoRead.current = runId
  }, [])
  const { mutate: markRunSeen } = useMarkRunSeen()
  useEffect(() => {
    if (!run.data) return
    if (suppressAutoRead.current === run.data.id) return
    if (isUnread(run.data)) markRunSeen(run.data.id)
  }, [
    markRunSeen,
    run.data?.id,
    run.data?.status,
    run.data?.finishedAt,
    run.data?.seenAt,
    run.data?.archived,
  ])

  // The skeleton the URL asked for, not the workspace's own: a `/changes` deep link that says
  // "Loading changes…" is telling the truth about what it is opening, and it keeps a cold load of
  // each task URL looking exactly as it did before the workspace existed.
  if (run.isPending) return <DeepLinkLoading view={view} />

  if (run.isError) {
    const notFound = run.error instanceof ApiError && run.error.status === 404
    return (
      <div data-route="task-workspace" className="flex min-h-full flex-col">
        <CenteredState
          icon={notFound ? <SearchXIcon /> : <MessageSquareTextIcon />}
          tone={notFound ? 'neutral' : 'danger'}
          title={notFound ? 'Task not found' : 'Could not load this task'}
          subtitle={
            notFound
              ? 'No run has this id. It may have been deleted, or the link is from another machine.'
              : run.error.message
          }
          actions={
            <Button asChild variant="outline">
              <Link to="/">Back to tasks</Link>
            </Button>
          }
        />
      </div>
    )
  }

  return <WorkspaceView run={run.data} deepLinkView={view} onMarkedUnread={suppressAutoReadFor} />
}

/** The fixed cards, left to right. Chat is home; the graph is the task's shape, so it is next. */
const FIXED_VIEW_ORDER: readonly ViewId[] = ['session', 'graph', 'changes', 'commits', 'files', 'browser']

function DeepLinkLoading({ view }: { view?: ViewId }) {
  if (view === 'files') return <GitTabLoading tab="files" />
  // Commits has no skeleton of its own — it rides the Changes one, as its route always has.
  if (view === 'changes' || view === 'commits') return <GitTabLoading tab="changes" />
  return <ThreadLoading />
}

function WorkspaceView({
  run,
  deepLinkView,
  onMarkedUnread,
}: {
  run: ApiRun
  deepLinkView?: ViewId
  onMarkedUnread: (runId: string) => void
}) {
  const layouts = useWorkspaceLayouts(run.id)
  const { openDeepLink, addLayout, closeLayout, selectLayout, renameLayout, setColumnBrowser, openInBrowser } =
    layouts

  // The deep-link hop. Keyed on the run id as well as the view: task A `/changes` → task B
  // `/changes` changes neither the path nor `openDeepLink`, and without the id in the deps task B
  // would open its default Czat card instead of the Changes the URL asked for.
  //
  // Gated on `ready`, because the layouts now come from the host: applied to the placeholder
  // state the hook starts with, the new card would be built on top of a workspace this task does
  // not have, and the host's answer would then replace it wholesale a tick later.
  //
  // BACK UNDOES IT. §5.3 asks the URL to "preserve its intent and browser Back behavior", and a
  // deep link that activates a card has to give that card up when the user presses Back to
  // `/tasks/:id` — otherwise the canonical URL silently shows the surface the previous entry
  // asked for. The card itself stays (the spec saves it); only the SELECTION is restored, to
  // whatever was active before the hop.
  const navigationType = useNavigationType()
  const beforeDeepLink = useRef<{ runId: string; name: string } | null>(null)
  /**
   * The card each deep-linked view minted during THIS visit to this task.
   *
   * Without it, Back-then-Forward across a deep link minted a card every time — Back cleared the
   * hop and restored `Czat`, so the Forward looked like a brand-new arrival, and `openDeepLink`'s
   * idempotence guard (which only holds while that card is still active) no longer applied. Six
   * presses left `Układ 2, 3, 4` behind, saved on the host. Reusing the card this visit already
   * made is not the same as adopting a layout the USER built, which §5.3 forbids and which this
   * deliberately cannot do: only names minted here are ever in the map.
   */
  const hops = useRef<Map<ViewId, string>>(new Map())
  const hopsRun = useRef(run.id)
  if (hopsRun.current !== run.id) {
    hopsRun.current = run.id
    hops.current = new Map()
    beforeDeepLink.current = null
  }

  useEffect(() => {
    if (!layouts.ready) return
    if (deepLinkView) {
      // Remember once per hop: a re-render inside the same deep link must not overwrite the
      // layout we are meant to come back to with the one the link itself activated.
      if (beforeDeepLink.current?.runId !== run.id) {
        beforeDeepLink.current = { runId: run.id, name: layouts.state.active }
      }
      const minted = hops.current.get(deepLinkView)
      if (minted !== undefined && layouts.state.layouts.some((layout) => layout.name === minted)) {
        selectLayout(minted)
      } else {
        openDeepLink(deepLinkView)
      }
      return
    }
    const previous = beforeDeepLink.current
    beforeDeepLink.current = null
    // Only a POP — Back or Forward. §5.3 asks the deep link to preserve "browser Back behavior",
    // and nothing more: following an in-app link to `/tasks/:id` after deliberately choosing
    // another card should leave that choice alone, not yank the user back to the pre-link one.
    if (navigationType !== 'POP') return
    if (previous && previous.runId === run.id && previous.name !== layouts.state.active) {
      selectLayout(previous.name)
    }
    // `layouts.state.active` is deliberately NOT a dependency: this runs on a navigation, and
    // re-running it whenever the user picks another card would drag them back to the old one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkView, layouts.ready, navigationType, openDeepLink, run.id, selectLayout])

  // Record the card the hop produced, once the transition has landed. Recognised by shape — a
  // one-column layout of exactly this view — so the OLD active can never be mistaken for it in
  // the render before `openDeepLink` applies.
  useEffect(() => {
    if (!layouts.ready || !deepLinkView || hops.current.has(deepLinkView)) return
    const active = layouts.layout
    if (active && active.columns.length === 1 && active.columns[0]?.view === deepLinkView) {
      hops.current.set(deepLinkView, active.name)
    }
  }, [deepLinkView, layouts.layout, layouts.ready])

  const markedUnread = useCallback(() => onMarkedUnread(run.id), [onMarkedUnread, run.id])

  /**
   * The fixed cards: one per view — Chat, Graph (when the task has a workflow), Changes, Commits,
   * Files, Browser — always on the strip, in that order, with no close and no rename. Chat
   * is the task's home (its bar, then the conversation) and is where a task opens.
   *
   * Each stands in for the plain saved layout of its view (`fixedViewOf`): picking one selects
   * that layout, creating it the first time, so what a fixed card shows is remembered like any
   * other layout — but the plain layout itself is never drawn as a second, closable card.
   */
  const fixedViews = useMemo<readonly ViewId[]>(
    () => FIXED_VIEW_ORDER.filter((view) => view !== 'graph' || Boolean(run.workflowDef)),
    [run.workflowDef],
  )
  const fixedActive: ViewId | null = !layouts.ready
    ? null
    : layouts.layout
      ? fixedViewOf(layouts.layout)
      // Every layout closed: the task's home is what is left.
      : 'session'
  const overview = fixedActive === 'session'
  const cardLayouts = useMemo(
    () => layouts.state.layouts.filter((layout) => fixedViewOf(layout) === null),
    [layouts.state.layouts],
  )
  const pickLayout = selectLayout
  const createLayout = useCallback(() => addLayout(), [addLayout])

  /**
   * Whether the drawer is showing, and how tall (spec §6).
   *
   * Read during render on a CHANGED task id for the same reason the layouts are: run A → run B
   * keeps the same route element, so React does not remount, and plain state would carry run A's
   * drawer into run B. `readDrawerState` is also what enforces the spec's two different restores
   * — a refresh reopens the drawer, a navigation does not — so this is a plain read either way.
   */
  const [drawer, setDrawer] = useState<DrawerState>(() => readDrawerState(run.id))
  const drawerFor = useRef(run.id)
  if (drawerFor.current !== run.id) {
    drawerFor.current = run.id
    setDrawer(readDrawerState(run.id))
  }
  const updateDrawer = useCallback(
    (patch: Partial<DrawerState>) => {
      setDrawer((current) => {
        const next = { ...current, ...patch }
        writeDrawerState(run.id, next)
        return next
      })
    },
    [run.id],
  )
  /**
   * Full view of the active layout (see `maximize.tsx`). A way of looking, not a setting: reset
   * per task like the drawer above, and left by picking another layout.
   */
  const [maximized, setMaximized] = useState(false)
  const maximizedFor = useRef(run.id)
  if (maximizedFor.current !== run.id) {
    maximizedFor.current = run.id
    setMaximized(false)
  }
  const exitMaximized = useCallback(() => setMaximized(false), [])
  const toggleMaximized = useCallback(() => setMaximized((current) => !current), [])
  const cover = usePanelCover<HTMLDivElement>(maximized, exitMaximized)
  const maximize = useMemo(() => ({ maximized, toggle: toggleMaximized }), [maximized, toggleMaximized])
  // One element for the life of the view: `RunHeader` is memo'd on prop identity.
  const fullViewExit = useMemo(() => <FullViewExit />, [])

  // Policy, read from the one place that knows it. A cockpit where a shell is not allowed shows
  // no button at all rather than one that explains itself after the click.
  const terminalAllowed = useHealth().data?.capabilities?.terminal === true

  // Memoized because `RunHeader` is `memo`'d on prop identity: a fresh element every render would
  // make that comparator always false and re-render the whole header on every thread frame.
  const tabs = useMemo(
    () => (
      <LayoutCards
        layouts={cardLayouts}
        active={layouts.state.active}
        fixedViews={fixedViews}
        fixedActive={fixedActive}
        onSelectFixed={openDeepLink}
        onSelect={pickLayout}
        onRename={renameLayout}
        onClose={closeLayout}
        onCreate={createLayout}
      />
    ),
    [cardLayouts, layouts.state.active, fixedViews, fixedActive, openDeepLink, pickLayout, renameLayout, closeLayout, createLayout],
  )

  // The drawer's toggle, handed to the header's tab row. Memoized for the same reason `tabs` is.
  const drawerOpen = drawer.open
  const terminalToggle = useMemo(
    () =>
      terminalAllowed ? (
        <Button
          variant="ghost"
          size="icon-sm"
          data-action="toggle-terminal"
          aria-label={drawerOpen ? 'Hide terminal' : 'Show terminal'}
          aria-pressed={drawerOpen}
          title={drawerOpen ? 'Hide terminal — processes keep running (`)' : 'Terminal (`)'}
          className={drawerOpen ? 'bg-muted text-foreground' : 'text-muted-foreground'}
          onClick={() => updateDrawer({ open: !drawerOpen })}
        >
          <TerminalIcon aria-hidden="true" />
        </Button>
      ) : null,
    [terminalAllowed, drawerOpen, updateDrawer],
  )
  /**
   * The workspace's keys. BARE keys, the `c`-to-create convention the cockpit already follows
   * (`useKeyShortcut`), and for the same reason: the chords one would reach for are the browser's.
   * ⌘1…⌘9 switch BROWSER tabs, ⌘[ / ⌘] are back and forward, ⌘F is find, ⌘\ and ⌘/ belong to
   * extensions — and a page cannot reliably claim any of them. A bare key collides with nothing,
   * as long as it never fires while someone is typing: a focused input, the composer, the
   * terminal (xterm types into a textarea) all swallow it, and so does any open dialog or menu.
   *
   *   1…9   the nth card on the strip        [ / ]   previous / next card
   *   f     full view on and off              \       split the last window (a layout you built)
   *   /     focus the composer                `       show or hide the terminal
   *
   * Taken elsewhere and left alone: `c` and ⌘N (new task), ⌘K (palette), ⌘B (sidebar),
   * ⌥+letter (quick replies), ⌃⇧` (new terminal tab), Escape (leave full view).
   */
  const stripOrder = useMemo(
    () => [
      ...fixedViews.map((view) => ({ select: () => openDeepLink(view), active: fixedActive === view })),
      ...cardLayouts.map((layout) => ({
        select: () => pickLayout(layout.name),
        active: fixedActive === null && layout.name === layouts.state.active,
      })),
    ],
    [fixedViews, cardLayouts, fixedActive, layouts.state.active, openDeepLink, pickLayout],
  )
  const keys = useRef({ stripOrder, toggleMaximized, terminalAllowed, drawerOpen, updateDrawer })
  keys.current = { stripOrder, toggleMaximized, terminalAllowed, drawerOpen, updateDrawer }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat || event.defaultPrevented) return
      if (isEditableTarget(event.target)) return
      // Something modal is up: its keys are its own.
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) return
      const now = keys.current
      const stage = document.querySelector<HTMLElement>('[data-slot="workspace-stage"]')
      const at = now.stripOrder.findIndex((entry) => entry.active)
      const step = (delta: number) => {
        if (now.stripOrder.length === 0) return
        const next = (Math.max(at, 0) + delta + now.stripOrder.length) % now.stripOrder.length
        now.stripOrder[next]!.select()
      }
      if (/^[1-9]$/.test(event.key)) {
        const entry = now.stripOrder[Number(event.key) - 1]
        if (!entry) return
        entry.select()
      } else if (event.key === '[') step(-1)
      else if (event.key === ']') step(1)
      else if (event.key === 'f' || event.key === 'F') now.toggleMaximized()
      else if (event.key === '\\') {
        const buttons = stage?.querySelectorAll<HTMLButtonElement>('[data-action="split-view"]:not(:disabled)')
        const last = buttons?.[buttons.length - 1]
        if (!last) return
        last.click()
      } else if (event.key === '/') {
        const input = stage?.querySelector<HTMLElement>('[data-slot="composer"] textarea, [data-slot="composer-input"]')
        if (!input) return
        input.focus()
      } else if (event.key === '`') {
        if (!now.terminalAllowed) return
        now.updateDrawer({ open: !now.drawerOpen })
      } else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Full view closes the strip: the last control, set apart by a rule and drawn as a real button
  // so it is found without hunting among the ghost icons beside it.
  const maximizeButton = useMemo(
    () => (
      <>
        <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-5" />
        <Button
          variant="outline"
          size="sm"
          data-action="maximize-layout"
          aria-label="Full view"
          title="Full view — hide everything but this layout (F)"
          className="shrink-0 text-foreground"
          onClick={toggleMaximized}
        >
          <Maximize2Icon aria-hidden="true" />
          <span className="@max-6xl/strip:hidden">Full view</span>
        </Button>
      </>
    ),
    [toggleMaximized],
  )

  /**
   * Changing a column's view away from Zmiany while it holds an unsent comment asks first (spec
   * §5.2: warn, with `Zamknij mimo to` to discard and change, or `Wróć` to keep it and stay).
   * Czat's composer text is discarded without a warning, which the same paragraph says.
   */
  // Run-level, because that is what the comments ARE: `useDiffComments` is keyed by run and the
  // draft behind it is one server surface per run, so every Zmiany column anywhere in the task
  // shows the same set.
  //
  // The count that decides the warning is over the ACTIVE layout, though, because that is what
  // "out of sight" means here: switching layouts unmounts the columns of the one you left
  // (§5.4), so a Zmiany column in another saved layout is not displaying anything to be warned
  // about. Asking once there is no VISIBLE column left is therefore the right line — and asking
  // once per column would ask while an identical column next door still displays them.
  const diffComments = useDiffComments(run.id)
  // Design Mode: an element picked in ANY Browser column joins the run's one list, which the
  // Chat column's composer shows as chips — whether or not that column is on screen right now.
  const designPicks = useDesignPicks(run.id)
  const { add: addDesignPick, remove: removeDesignPick, picks: pickedElements } = designPicks
  const unpickElement = useCallback(
    (mark: string) => {
      const pick = pickedElements.find((entry) => entry.mark === mark)
      if (pick) removeDesignPick(pick.id)
    },
    [pickedElements, removeDesignPick],
  )
  /** Tasks the notes of this visit turned into — the task-queue strip's contents. */
  const [designTasks, setDesignTasks] = useState<string[]>([])
  const addDesignTasks = useCallback((ids: string[]) => setDesignTasks((known) => [...known, ...ids]), [])
  // What the page can still frame: a pick made in the document that is showing. Its number is its
  // place in the WHOLE note, so the page and the panel under it always agree.
  const designMarks = useMemo(
    () => pickedElements.flatMap((pick, index) => (pick.mark ? [{ key: pick.mark, n: index + 1 }] : [])),
    [pickedElements],
  )
  const [pendingView, setPendingView] = useState<{ index: number; view: ViewId } | null>(null)
  const columns = layouts.layout?.columns
  const requestColumnView = useCallback(
    (index: number, view: ViewId) => {
      const leavingChanges = columns?.[index]?.view === 'changes'
      const lastChangesColumn = columns?.filter((column) => column.view === 'changes').length === 1
      if (leavingChanges && lastChangesColumn && diffComments.comments.length > 0) {
        setPendingView({ index, view })
        return
      }
      layouts.setColumnView(index, view)
    },
    [columns, diffComments.comments.length, layouts.setColumnView],
  )

  const actions: ColumnActions = useMemo(
    () => ({
      addColumn: layouts.addColumn,
      closeColumn: layouts.closeColumn,
      setColumnView: requestColumnView,
      resizeColumns: layouts.resizeColumns,
      moveColumn: layouts.moveColumn,
    }),
    [layouts.addColumn, layouts.closeColumn, requestColumnView, layouts.resizeColumns, layouts.moveColumn],
  )

  // A file or commit named in the chat: put its view beside the chat, then tell THAT window —
  // by the same key it remembers its selection under — what to show.
  const openBeside = layouts.openBeside
  const openReference = useCallback(
    (reference: ThreadReference) => {
      const placed = openBeside(reference.view)
      if (!placed) return
      rememberViewState(`${run.id}:${placed.name}:${placed.index}:${reference.view}`, reference.value)
    },
    [openBeside, run.id],
  )

  /**
   * The LAYOUT is part of each column's memory key, not just its index.
   *
   * Spec §5.4 asks that switching saved layouts preserve "each layout's view state… scroll
   * position, file selection". Keyed by index alone, two layouts whose Files column happens to
   * sit in the same position shared one remembered selection — so switching between them moved
   * the other one's file under the user. The name changes on rename, which costs that column its
   * remembered position for the rest of the session; that is the right trade for state the
   * module already documents as session-lifetime.
   */
  const activeName = layouts.state.active

  // One run, one worktree: every column is handed the SAME record (spec §3.3), so no column can
  // drift onto another task's state or the boot repo.
  const renderView = useCallback(
    (view: ViewId, index: number, column: WorkspaceColumn) => {
      switch (view) {
        case 'session':
          return <ConversationColumn run={run} onMarkedUnread={onMarkedUnread} onOpenReference={openReference} />
        case 'changes':
          return <ChangesView run={run} embedded stateKey={`${run.id}:${activeName}:${index}:changes`} />
        case 'commits':
          return <CommitsView run={run} embedded stateKey={`${run.id}:${activeName}:${index}:commits`} />
        case 'files':
          return <FilesView run={run} embedded stateKey={`${run.id}:${activeName}:${index}:files`} />
        case 'browser':
          return (
            <BrowserView
              state={column.browser ?? emptyBrowserState()}
              onChange={(browser) => setColumnBrowser(index, browser)}
              onPickElement={addDesignPick}
              designMarks={designMarks}
              onUnpickElement={unpickElement}
              // STAGE 1 of the review flow (spec 2026-10-09-design-mode §7): a click selects — the
              // frame stays and turns lime — and nothing else happens in the page. The note popup
              // (`DesignNote`, `renderDesignNote`) is built and parked until its own stage:
              //   designPickCount={pickedElements.length}
              //   renderDesignNote={({ close }) => (
              //     <DesignNote run={run} picks={designPicks} onClose={close} onTasksCreated={addDesignTasks} />
              //   )}
              // The queues get a strip of their own only while there is something in them.
              designDock={
                hasDesignQueues(run, designTasks) ? <DesignQueues run={run} createdTasks={designTasks} /> : undefined
              }
            />
          )
        case 'graph':
          return (
            // The chunk is fetched on first use; a bare centred spinner is the whole fallback,
            // because the column's chrome is already painted around it.
            <Suspense
              fallback={
                <CenteredState
                  icon={<LoaderCircleIcon className="motion-safe:animate-spin" />}
                  tone="neutral"
                  heading="h2"
                  title="Loading graph…"
                />
              }
            >
              <GraphColumn run={run} embedded />
            </Suspense>
          )
      }
    },
    [activeName, addDesignPick, designMarks, designTasks, onMarkedUnread, run, setColumnBrowser, openReference, unpickElement],
  )

  return (
    <div data-route="task-workspace" data-run-id={run.id} className="flex h-full min-h-0 flex-col">
      <RunHeader
        run={run}
        onMarkedUnread={markedUnread}
        tabs={tabs}
        trailing={terminalToggle}
        trailingEnd={maximizeButton}
        mode="strip"
        bareStrip={overview}
      />
      {layouts.saveFailed ? (
        // Spec §2: a capability that cannot work degrades to a CLEAR state. The workspace still
        // works from memory for the rest of the visit — what is lost is only the remembering —
        // so this says exactly that rather than blocking anything.
        <div
          data-slot="layouts-unsaved"
          role="status"
          className="shrink-0 border-b border-border bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground sm:px-6"
        >
          This layout could not be saved on this host — it keeps working in this tab, but will not
          come back after a refresh.
        </div>
      ) : null}
      <WorkspaceMaximizeContext.Provider value={maximize}>
        <div
          ref={cover.ref}
          data-slot="workspace-stage"
          data-maximized={cover.covering ? '' : undefined}
          style={cover.style}
          className={cn(
            'relative flex min-h-0 flex-1 flex-col',
            // Wears the panel's own corners and edge, so it reads as the panel showing one thing.
            cover.covering && 'fixed z-40 overflow-hidden bg-background md:rounded-xl md:border md:border-border/70',
          )}
        >
          {overview ? (
            // The task's bar, then the conversation in the scroller slot every thread resolves.
            <>
              <RunHeader run={run} onMarkedUnread={markedUnread} mode="overview" trailingEnd={fullViewExit} />
              <div data-slot="main" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                <ConversationColumn run={run} onMarkedUnread={onMarkedUnread} onOpenReference={openReference} />
              </div>
            </>
          ) : !layouts.ready ? (
            // The host still owes us this task's layouts (spec §5.3). Painting the default card first
            // and swapping it a tick later would flash a workspace the user never built, so the view
            // area holds the same skeleton a cold load of this URL already shows.
            <DeepLinkLoading view={deepLinkView} />
          ) : layouts.layout ? (
            <WorkspaceColumns
              key={activeName}
              columns={layouts.layout.columns}
              actions={actions}
              renderView={renderView}
              editable={fixedActive === null}
            />
          ) : (
            // The workspace the user emptied by closing its last card. It stays empty for this visit
            // and comes back as a fresh `Czat` on the next one (§5.3) — the state module's recovery
            // rule, not a second code path here.
            <CenteredState
              icon={<LayoutGridIcon />}
              tone="neutral"
              heading="h2"
              title="No layouts"
              subtitle="You closed every layout of this task. Create a new one, or come back later — the task will open with a Chat layout."
              actions={
                <Button variant="outline" onClick={createLayout}>
                  New layout
                </Button>
              }
            />
          )}
        </div>
      </WorkspaceMaximizeContext.Provider>
      <AlertDialog open={pendingView !== null} onOpenChange={(open) => !open && setPendingView(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>You have an unsent comment</AlertDialogTitle>
            <AlertDialogDescription>
              {diffComments.comments.length === 1
                ? 'One comment on the changes has not been sent yet.'
                : `${diffComments.comments.length} comments on the changes have not been sent yet.`}{' '}
              This is the last column showing them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {/* `Wróć` keeps the comment and stays in Zmiany; `Zamknij mimo to` changes the view
                anyway — the two answers spec §5.2 names, in that order. */}
            <AlertDialogCancel>Go back</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingView) layouts.setColumnView(pendingView.index, pendingView.view)
                setPendingView(null)
              }}
            >
              Change anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {terminalAllowed && drawer.open ? (
        <Suspense fallback={null}>
          <TerminalDrawer
            runId={run.id}
            height={drawer.height}
            onHeightChange={(height) => updateDrawer({ height })}
            onClose={() => updateDrawer({ open: false })}
            onOpenInBrowser={openInBrowser}
          />
        </Suspense>
      ) : null}
    </div>
  )
}

/**
 * The Czat column: `TaskThreadRoute`'s own data doctrine, in a component that mounts only when a
 * layout actually shows the conversation.
 *
 * Its own component rather than hooks in `WorkspaceView` so a workspace of Changes and Files pays
 * for no transcript subscription at all — `useRunHistory` is the heaviest hook on this screen.
 * Two Czat columns each get their own history state, which is what makes their scroll positions
 * and "load older" pages independent, as two windows onto one transcript should be.
 */
function ConversationColumn({
  run,
  onMarkedUnread,
  onOpenReference,
}: {
  run: ApiRun
  onMarkedUnread: (runId: string) => void
  onOpenReference?: (reference: ThreadReference) => void
}) {
  const history = useRunHistory(run.id)
  const thread = useMemo(
    () => reduceThread(history.visibleEvents, { activeTurn: run.status === 'running' }),
    [history.visibleEvents, run.status],
  )
  const currentThread = useMemo(
    () => reduceThread(history.currentEvents, { activeTurn: run.status === 'running' }),
    [history.currentEvents, run.status],
  )
  // The two feeds can drift: a record update lost on the workspace stream leaves the thread
  // showing Working… over a "run finished" transcript. The transcript is live here, so it
  // arbitrates — same reason the Session route runs this.
  useRunRecordReconcile(run, history.visibleEvents)

  if (history.isPending) return <ThreadLoading />

  /*
   * A file path or a commit the agent names in its answer opens in a window beside the chat.
   *
   * By delegation, on the inline code the markdown already renders, rather than by a component of
   * our own inside it: Streamdown's `code` renders fences and spans alike, and replacing it to
   * reach the spans would put this in charge of every code block in the thread. A span is
   * classified the first time the pointer reaches it and marked `data-open`, which is what the
   * stylesheet draws as a link — so only the spans that DO open something ever look like it.
   */
  const target = (event: { target: EventTarget | null }) => {
    const node = event.target instanceof Element ? event.target.closest('[data-streamdown="inline-code"]') : null
    if (!(node instanceof HTMLElement) || node.closest('[data-slot="user-message"]')) return null
    const reference = classifyReference(node.textContent ?? '', run.worktreePath ?? undefined)
    return reference ? { node, reference } : null
  }

  return (
    <div
      className="contents"
      onPointerOver={(event) => {
        const hit = target(event)
        if (hit && !hit.node.dataset.open) {
          hit.node.dataset.open = hit.reference.view
          hit.node.title = hit.reference.view === 'files' ? 'Open in Files' : 'Open in Commits'
        }
      }}
      onClick={(event) => {
        if (!onOpenReference || window.getSelection()?.toString()) return
        const hit = target(event)
        if (hit) onOpenReference(hit.reference)
      }}
    >
      <ThreadView
        run={run}
        thread={thread}
        currentThread={currentThread}
        history={history}
        onMarkedUnread={onMarkedUnread}
        embedded
      />
    </div>
  )
}

interface ThreadReference {
  view: 'files' | 'commits'
  /** A worktree-relative path, or a commit sha as written. */
  value: string
}

/**
 * Is this inline code a file of the task or one of its commits?
 *
 * Deliberately narrow — a miss costs nothing, a false hit makes plain code look like a link:
 *  - a commit is 7–40 hex digits and nothing else, with at least one letter and one digit in it
 *    (so `1234567` and `deadbeef`-style words are not claimed on a guess of either kind alone);
 *  - a file is one whitespace-free path ending in an extension, optionally `:line[:col]`. A path
 *    under this task's worktree is made relative to it; any other absolute path is somewhere this
 *    cockpit cannot show, and is left alone.
 */
function classifyReference(raw: string, worktree?: string): ThreadReference | null {
  const text = raw.trim()
  if (text.length < 3 || text.length > 260 || /\s/.test(text)) return null
  if (/^[0-9a-f]{7,40}$/.test(text) && /[a-f]/.test(text) && /[0-9]/.test(text)) return { view: 'commits', value: text }
  let path = text.replace(/:\d+(?::\d+)?$/, '')
  if (worktree && path.startsWith(`${worktree}/`)) path = path.slice(worktree.length + 1)
  if (path.startsWith('/') || path.startsWith('~') || /^[a-z]+:\/\//i.test(path)) return null
  path = path.replace(/^\.\//, '')
  if (path.startsWith('..')) return null
  if (!/^[\w@.+\-()[\]]+(?:\/[\w@.+\-()[\]]+)*\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(path)) return null
  // `v1.2`, `e.g`, `foo.bar` in prose: without a directory, only believe a real-looking filename.
  if (!path.includes('/') && !/\.(?:tsx?|jsx?|mjs|cjs|json|md|mdx|css|scss|html|ya?ml|toml|py|rs|go|rb|java|kt|swift|sh|sql|lock|txt|env|svg|png|jpe?g)$/i.test(path)) return null
  return { view: 'files', value: path }
}
