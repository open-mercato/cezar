import {
  LayoutGridIcon,
  LoaderCircleIcon,
  Maximize2Icon,
  MessageSquareTextIcon,
  PanelBottomIcon,
  SearchXIcon,
  TerminalIcon,
} from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigationType, useParams } from 'react-router'

import { ApiError } from '@/api/client'
import { useHealth, useMarkRunSeen, useRun } from '@/api/queries'
import { useRunHistory } from '@/api/run-history'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
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
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import { Link, useNavigate } from '@/lib/project-router'
import { isUnread } from '@/lib/read-state'
import { recordTaskVisit } from '@/lib/recent-tasks'
import { publishTaskWorkspace, takeQueuedFileOpen, withdrawTaskWorkspace, type TaskWorkspaceBridge } from '@/lib/task-workspace-bridge'
import { isEditableTarget } from '@/lib/use-command-shortcut'
import { cn } from '@/lib/utils'
import { rememberViewState } from '@/lib/view-memory'

import { GitTabLoading } from '../task-git/git-tab-loading'
import { BrowserView } from '../task-preview/browser-view'
import { DesignNotePopup } from '../task-preview/design-note-popup'
import { useDesignNotes } from '../task-preview/design-notes'
import { ChangesView } from '../task-git/task-changes'
import { CommitsView } from '../task-git/task-commits'
import { FilesView } from '../task-git/task-files'
import { useDiffComments } from '../task-thread/diff-comments'
import { RunHeader, type RunTab } from '../task-thread/run-header'
import { useRunRecordReconcile } from '../task-thread/run-reconcile'
import { ThreadView } from '../task-thread/task-thread'
import { ThreadLoading } from '../task-thread/thread-loading'
import { reduceThread } from '../task-thread/thread-state'
import { readDrawerState, writeDrawerState, type DrawerState } from './drawer-state'
import { LayoutCards } from './layout-cards'
import {
  emptyBrowserState,
  FIXED_VIEW_ORDER,
  fixedViewOf,
  layoutDisplayName,
  MAX_COLUMNS,
  toSavedLayout,
  VIEW_IDS,
  type ViewId,
  type WorkspaceColumn,
} from './layout-state'
import { FullViewExit, usePanelCover, WorkspaceMaximizeContext } from './maximize'
import { stripEntries, stripTabs, useStripKeyHints } from './strip'
import { useSavedLayouts } from './use-saved-layouts'
import { useWorkspaceLayouts } from './use-workspace-layouts'
import { AvailableViewsContext } from './view-picker'
import { ViewDropZones } from './view-drop-zones'
import { WorkspaceColumns, type ColumnActions } from './workspace-columns'

/** Lazy: xterm is the heaviest thing on this screen, and most visits never open a shell. */
const TerminalDrawer = lazy(() =>
  import('./terminal-drawer').then((m) => ({ default: m.TerminalDrawer })),
)

/** Lazy for the same reason: the graph carries `@xyflow/react` and its layout engine. */
const GraphColumn = lazy(() =>
  import('../workflow-graph/task-graph').then((m) => ({ default: m.TaskGraphView })),
)

/**
 * `/tasks/:id` — the task workspace (spec `.ai/specs/2026-10-07-task-workspace.md`): the run
 * header, its route tabs replaced by the saved-layout strip, and one to three resizable columns
 * below. Each column embeds an existing view; `embedded` drops that view's own header and nothing
 * else. `/changes`, `/files`, `/commits`, `/graph`, `/preview` and `/terminal` render this route with `view`
 * set, which opens that view as a card and leaves every saved layout alone (§5.3).
 */
export function TaskWorkspaceRoute({ view }: { view?: ViewId }) {
  const { id } = useParams<{ id: string }>()
  const run = useRun(id)

  // The read receipt, moved here from the Session route (#unread-done-items, #775): visiting the
  // task marks it read even when no Chat column is showing.
  const suppressAutoRead = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (suppressAutoRead.current !== id) suppressAutoRead.current = undefined
  }, [id])
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
    id,
  ])

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


function DeepLinkLoading({ view }: { view?: ViewId }) {
  if (view === 'files') return <GitTabLoading tab="files" />
  if (view === 'terminal') return <GitTabLoading tab="terminal" />
  if (view === 'browser') return <GitTabLoading tab="preview" />
  if (view === 'changes' || view === 'commits' || view === 'graph') return <GitTabLoading tab="changes" />
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
  const { openDeepLink, addLayout, closeLayout, selectLayout, setColumnBrowser, openInBrowser, applySaved, keepAs } = layouts
  // Layouts saved for every task: nothing is saved until the user names one (Layout menu).
  const savedLayouts = useSavedLayouts()
  const { save: saveLayout, remove: deleteSavedLayout } = savedLayouts
  const layoutState = layouts.state
  const canSaveLayout = (layouts.layout?.columns.length ?? 0) > 0
  const saveCurrentLayout = useCallback(
    (name: string) => {
      const layout = toSavedLayout(layoutState, name)
      if (!layout) return
      saveLayout(layout)
      keepAs(layout.name)
    },
    [keepAs, layoutState, saveLayout],
  )

  // Policy, read from the one place that knows it: no shell here means no Terminal anywhere.
  const terminalAllowed = useHealth().data?.capabilities?.terminal === true
  const availableViews = useMemo(
    () => VIEW_IDS.filter((view) => view !== 'terminal' || terminalAllowed),
    [terminalAllowed],
  )

  // The deep-link hop, and Back undoing it (§5.3) — as on brutus, gated on `ready` so a card is
  // never built on the stand-in state before the host has answered.
  const navigationType = useNavigationType()
  const beforeDeepLink = useRef<{ runId: string; name: string } | null>(null)
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
    if (navigationType !== 'POP') return
    if (previous && previous.runId === run.id && previous.name !== layouts.state.active) {
      selectLayout(previous.name)
    }
    // `layouts.state.active` is deliberately not a dependency: this runs on a navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkView, layouts.ready, layouts.replaced, navigationType, openDeepLink, run.id, selectLayout])

  useEffect(() => {
    if (!layouts.ready || !deepLinkView || hops.current.has(deepLinkView)) return
    const active = layouts.layout
    if (active && active.columns.length === 1 && active.columns[0]?.view === deepLinkView) {
      hops.current.set(deepLinkView, active.name)
    }
  }, [deepLinkView, layouts.layout, layouts.ready])

  const markedUnread = useCallback(() => onMarkedUnread(run.id), [onMarkedUnread, run.id])

  const fixedViews = useMemo<readonly ViewId[]>(
    () =>
      FIXED_VIEW_ORDER.filter(
        (view) => availableViews.includes(view) && (view !== 'graph' || Boolean(run.workflowDef)),
      ),
    [availableViews, run.workflowDef],
  )
  const fixedActive: ViewId | null = !layouts.ready
    ? null
    : layouts.layout
      ? fixedViewOf(layouts.layout)
      : 'session'
  const cardLayouts = useMemo(
    () => layouts.state.layouts.filter((layout) => fixedViewOf(layout) === null),
    [layouts.state.layouts],
  )
  const createLayout = useCallback(() => addLayout(), [addLayout])

  // The numbered tabs — views with Notes among them (`strip.ts`) — and, while ⌘ is held on its own, each
  // tab's number (spec 2026-10-17-task-palette). Saved layouts are not numbered.
  const strip = useMemo(() => stripEntries(fixedViews), [fixedViews])
  const { hints: keyHints, show: keysHeld } = useStripKeyHints(strip)
  const navigate = useNavigate()

  // A view tab being dragged: the stage shows its drop zones until the drag ends. Set a tick late,
  // because changing the page under a drag that has only just started can cancel it.
  const [draggingView, setDraggingView] = useState<ViewId | null>(null)
  const startViewDrag = useCallback((view: ViewId) => {
    setTimeout(() => setDraggingView(view), 0)
  }, [])
  const endViewDrag = useCallback(() => setDraggingView(null), [])
  const dropView = layouts.dropView
  // The layout shown before this one. A view's tab dropped beside its OWN card (the Terminal tab
  // dragged while the Terminal shows) means "beside what I was on", which is only known here.
  const shownLayout = useRef({ runId: run.id, current: layouts.state.active, previous: null as string | null })
  if (shownLayout.current.runId !== run.id) shownLayout.current = { runId: run.id, current: layouts.state.active, previous: null }
  else if (shownLayout.current.current !== layouts.state.active) {
    shownLayout.current = { runId: run.id, current: layouts.state.active, previous: shownLayout.current.current }
  }
  const besideItself = useCallback(
    (view: ViewId): number | null => {
      if (fixedActive !== view) return null
      const previous = shownLayout.current.previous
      const back = previous === null ? undefined : layouts.state.layouts.find((layout) => layout.name === previous)
      if (back && !(back.columns.length === 1 && back.columns[0]?.view === view)) {
        selectLayout(back.name)
        return back.columns.length
      }
      openDeepLink(view === 'session' ? 'changes' : 'session')
      return 1
    },
    [fixedActive, layouts.state.layouts, openDeepLink, selectLayout],
  )
  const dropViewHere = useCallback(
    (view: ViewId, at: number, mode: 'insert' | 'replace') => {
      setDraggingView(null)
      if (mode === 'insert' && besideItself(view) !== null) {
        // Its own card offered a left and a right edge: keep the side, beside the view it returns to.
        dropView(view, at === 0 ? 0 : MAX_COLUMNS, mode)
        return
      }
      dropView(view, at, mode)
    },
    [besideItself, dropView],
  )
  const openViewBeside = useCallback(
    (view: ViewId) => {
      const count = besideItself(view) ?? layouts.layout?.columns.length ?? 0
      dropView(view, count, 'insert')
    },
    [besideItself, dropView, layouts.layout?.columns.length],
  )
  const columnCount = layouts.layout?.columns.length ?? 0
  const closeColumnByDrop = fixedActive === null && columnCount > 1 ? layouts.closeColumn : undefined

  // The drawer: browser-local open + height, per task (spec §6). Read during render on a changed
  // task id, so run A's drawer never carries into run B.
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
  // A Terminal column already shows this task's shells; a drawer under it would be a second view
  // of the same sessions, fighting over the PTY's size.
  const terminalColumnShown = layouts.layout?.columns.some((column) => column.view === 'terminal') ?? false
  const drawerShown = terminalAllowed && drawer.open && !terminalColumnShown

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

  // The Terminal tab opens the shells as a view, like Preview; a drag or ⌥-click puts them beside
  // the view instead. The bottom drawer is the ` key's, and a column's "Move to bottom".
  const drawerOpen = drawer.open
  const toggleDrawer = useCallback(() => {
    if (!terminalColumnShown) updateDrawer({ open: !drawerOpen })
  }, [drawerOpen, terminalColumnShown, updateDrawer])
  const { closeColumn } = layouts
  const terminalColumns = layouts.layout?.columns
  const moveTerminalToDrawer = useCallback(() => {
    updateDrawer({ open: true })
    const index = terminalColumns?.findIndex((column) => column.view === 'terminal') ?? -1
    if (index < 0) return
    // A layout of the shells alone has nothing to fall back to but Chat.
    if (fixedActive !== null || terminalColumns!.length === 1) openDeepLink('session')
    else closeColumn(index)
  }, [closeColumn, fixedActive, openDeepLink, terminalColumns, updateDrawer])
  const onViews = useMemo<readonly ViewId[]>(
    () => (drawerShown || terminalColumnShown ? ['terminal'] : []),
    [drawerShown, terminalColumnShown],
  )

  // Memoized: `RunHeader` is memo'd on prop identity.
  const tabs = useMemo(
    () => (
      <LayoutCards
        layouts={cardLayouts}
        active={layouts.state.active}
        fixedViews={fixedViews}
        fixedActive={fixedActive}
        onViews={onViews}
        onSelectFixed={openDeepLink}
        onSelect={selectLayout}
        onClose={closeLayout}
        saved={savedLayouts.saved}
        onApplySaved={applySaved}
        onSaveCurrent={canSaveLayout ? saveCurrentLayout : undefined}
        onDeleteSaved={deleteSavedLayout}
        notesHref={`/tasks/${run.id}/notes`}
        onViewDragStart={startViewDrag}
        onViewDragEnd={endViewDrag}
        onOpenBeside={openViewBeside}
        onColumnDropClose={closeColumnByDrop}
        keyHints={keyHints}
        showKeyHints={keysHeld}
      />
    ),
    [
      cardLayouts,
      layouts.state.active,
      fixedViews,
      fixedActive,
      onViews,
      openDeepLink,
      selectLayout,
      closeLayout,
      savedLayouts.saved,
      applySaved,
      canSaveLayout,
      saveCurrentLayout,
      deleteSavedLayout,
      run.id,
      startViewDrag,
      endViewDrag,
      openViewBeside,
      closeColumnByDrop,
      keyHints,
      keysHeld,
    ],
  )

  // Icon only, beside the header's collapse button: both change how much of the screen the work gets.
  const headerActions = useMemo(
    () => (
      <Button
        variant="ghost"
        size="icon-sm"
        data-action="maximize-layout"
        aria-label="Full view"
        title="Full view — hide everything but this layout (F)"
        className="text-muted-foreground"
        onClick={toggleMaximized}
      >
        <Maximize2Icon aria-hidden="true" />
      </Button>
    ),
    [toggleMaximized],
  )

  /**
   * The workspace's keys — bare keys, never while typing or with a dialog/menu open (brutus §5.2):
   *   1…9 nth numbered tab (`stripTabs`) · [ ] previous/next card · f full view · \ split the last window ·
   *   / focus the composer · ` show or hide the terminal drawer
   */
  const stripOrder = useMemo(
    () => [
      ...fixedViews.map((view) => ({ select: () => openDeepLink(view), active: fixedActive === view })),
      ...cardLayouts.map((layout) => ({
        select: () => selectLayout(layout.name),
        active: fixedActive === null && layout.name === layouts.state.active,
      })),
    ],
    [fixedViews, cardLayouts, fixedActive, layouts.state.active, openDeepLink, selectLayout],
  )
  // The 1–9 keys: the numbered tabs only (`strip.ts` — views and Notes; no layouts), so the key
  // is the number the tab wears. `[` `]` still step through every card, layouts included.
  const numbered = useMemo(
    () => [
      ...stripTabs(fixedViews).map((tab) =>
        tab === 'notes' ? () => navigate(`/tasks/${run.id}/notes`) : () => openDeepLink(tab),
      ),
    ],
    [fixedViews, openDeepLink, navigate, run.id],
  )
  const keys = useRef({ stripOrder, numbered, toggleMaximized, terminalAllowed, toggleDrawer })
  keys.current = { stripOrder, numbered, toggleMaximized, terminalAllowed, toggleDrawer }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat || event.defaultPrevented) return
      if (isEditableTarget(event.target)) return
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
        const open = now.numbered[Number(event.key) - 1]
        if (!open) return
        open()
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
        now.toggleDrawer()
      } else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Changing the last visible Changes column away while it holds unsent comments asks first (§5.2).
  const diffComments = useDiffComments(run.id)
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
      // A view tab stays the one view it stands for: splitting it builds the working arrangement.
      addColumn:
        fixedActive === null ? layouts.addColumn : (view: ViewId) => dropView(view, columnCount, 'insert'),
      closeColumn: layouts.closeColumn,
      setColumnView: requestColumnView,
      resizeColumns: layouts.resizeColumns,
      moveColumn: layouts.moveColumn,
    }),
    [
      fixedActive,
      dropView,
      columnCount,
      layouts.addColumn,
      layouts.closeColumn,
      requestColumnView,
      layouts.resizeColumns,
      layouts.moveColumn,
    ],
  )

  // A file or commit named in the chat opens beside it, in the window that remembers it by key.
  const openBeside = layouts.openBeside
  const openReference = useCallback(
    (reference: ThreadReference) => {
      const placed = openBeside(reference.view)
      if (!placed) return
      rememberViewState(`${run.id}:${placed.name}:${placed.index}:${reference.view}`, reference.value)
    },
    [openBeside, run.id],
  )

  // The ⌘P palette's handle on this workspace (spec 2026-10-17-task-palette), refreshed every commit.
  useEffect(() => recordTaskVisit(run.id), [run.id])
  useEffect(() => {
    if (!layouts.ready) return
    const path = takeQueuedFileOpen(run.id)
    if (path) openReference({ view: 'files', value: path })
  }, [layouts.ready, openReference, run.id])
  useEffect(() => {
    const stage = () => document.querySelector<HTMLElement>('[data-slot="workspace-stage"]')
    const splitButton = () => {
      const buttons = stage()?.querySelectorAll<HTMLButtonElement>('[data-action="split-view"]:not(:disabled)')
      return buttons?.[buttons.length - 1] ?? null
    }
    const composer = () =>
      stage()?.querySelector<HTMLElement>('[data-slot="composer"] textarea, [data-slot="composer-input"]') ?? null
    const bridge: TaskWorkspaceBridge = {
      runId: run.id,
      views: fixedViews,
      activeView: fixedActive,
      openView: openDeepLink,
      openViewBeside,
      layouts: cardLayouts.map((layout) => ({
        name: layout.name,
        label: layoutDisplayName(layout.name),
        active: fixedActive === null && layout.name === layouts.state.active,
      })),
      selectLayout,
      maximized,
      toggleMaximized,
      // Getters: the composer and split buttons mount after this commit (history loads), so they
      // are looked up when the palette reads them, not when this was published.
      get splitView() {
        return splitButton() ? () => splitButton()?.click() : null
      },
      terminal: {
        allowed: terminalAllowed,
        open: drawerOpen,
        inColumn: terminalColumnShown,
        toggle: toggleDrawer,
        openInColumn: () => {
          updateDrawer({ open: false })
          openBeside('terminal')
        },
      },
      get focusComposer() {
        return composer() ? () => composer()?.focus() : null
      },
      openFile: (path: string) => openReference({ view: 'files', value: path }),
      markedUnread,
    }
    publishTaskWorkspace(bridge)
    return () => withdrawTaskWorkspace(bridge)
  })

  // The layout name is part of each column's memory key, so two layouts never share a selection.
  const activeName = layouts.state.active
  // The header's run controls (Continue, ■ Stop) live in the composer when a Chat column shows it.
  const headerTab: RunTab = columns?.some((column) => column.view === 'session') ? 'session' : 'changes'

  // Design Mode notes (spec 2026-10-09-design-mode) are the task's, shared by every Preview column.
  const designNotes = useDesignNotes(run)
  const { addDraft, discard: discardNote, note: noteFor, marks: designMarks } = designNotes
  const escapeNote = useCallback(
    (mark: string) => {
      if (noteFor(mark)?.phase === 'draft') discardNote(mark)
    },
    [discardNote, noteFor],
  )

  // A terminal column's bar docks the same shells at the bottom instead.
  const headerExtras = useCallback(
    (view: ViewId) =>
      view === 'terminal' && terminalAllowed ? (
        <IconTooltip label="Move to bottom — under every view">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            data-action="terminal-to-drawer"
            aria-label="Move to bottom"
            onClick={moveTerminalToDrawer}
            className="text-soft-foreground hover:text-foreground"
          >
            <PanelBottomIcon aria-hidden="true" className="size-3.5" />
          </Button>
        </IconTooltip>
      ) : null,
    [moveTerminalToDrawer, terminalAllowed],
  )

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
        case 'graph':
          return (
            <Suspense fallback={<ColumnLoading title="Loading graph…" />}>
              <GraphColumn run={run} embedded />
            </Suspense>
          )
        case 'terminal':
          return terminalAllowed ? (
            <Suspense fallback={<ColumnLoading title="Loading terminal…" />}>
              <TerminalDrawer runId={run.id} height={0} onHeightChange={noop} onOpenInBrowser={openInBrowser} fill />
            </Suspense>
          ) : (
            <CenteredState
              icon={<TerminalIcon />}
              tone="neutral"
              heading="h2"
              title="Terminal disabled"
              subtitle="The terminal is off on this cockpit — it is off in hosted mode unless CEZ_TERMINAL=1."
            />
          )
        case 'browser':
          return (
            <BrowserView
              state={column.browser ?? emptyBrowserState()}
              onChange={(browser) => setColumnBrowser(index, browser)}
              onPickElement={addDraft}
              designMarks={designMarks}
              onDesignEscape={escapeNote}
              renderDesignNote={({ mark, close }) => {
                const note = noteFor(mark)
                return note ? <DesignNotePopup note={note} run={run} notes={designNotes} onClose={close} /> : null
              }}
            />
          )
      }
    },
    [
      activeName,
      addDraft,
      designMarks,
      designNotes,
      escapeNote,
      noteFor,
      onMarkedUnread,
      openInBrowser,
      openReference,
      run,
      setColumnBrowser,
      terminalAllowed,
    ],
  )

  return (
    <div data-route="task-workspace" data-run-id={run.id} className="flex h-full min-h-0 flex-col">
      <RunHeader run={run} tab={headerTab} onMarkedUnread={markedUnread} tabs={tabs} headerActions={headerActions} wide />
      {layouts.loadFailed ? (
        <div
          data-slot="layouts-unloaded"
          role="status"
          className="shrink-0 border-b border-border bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground sm:px-6"
        >
          This task's saved layouts could not be loaded yet — retrying. Changes made meanwhile are not saved.
        </div>
      ) : null}
      {layouts.saveFailed ? (
        <div
          data-slot="layouts-unsaved"
          role="status"
          className="shrink-0 border-b border-border bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground sm:px-6"
        >
          This layout could not be saved on this host — it keeps working in this tab, but will not come back after a
          refresh.
        </div>
      ) : null}
      <AvailableViewsContext.Provider value={availableViews}>
        <WorkspaceMaximizeContext.Provider value={maximize}>
          <div
            ref={cover.ref}
            data-slot="workspace-stage"
            data-maximized={cover.covering ? '' : undefined}
            style={cover.style}
            className={cn(
              'relative flex min-h-0 flex-1 flex-col',
              cover.covering && 'fixed z-40 overflow-hidden bg-background md:rounded-xl md:border md:border-border/70',
            )}
          >
            {!layouts.ready ? (
              <DeepLinkLoading view={deepLinkView} />
            ) : layouts.layout ? (
              <WorkspaceColumns
                key={activeName}
                columns={layouts.layout.columns}
                actions={actions}
                renderView={renderView}
                headerExtras={headerExtras}
              />
            ) : (
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
            {draggingView ? (
              <ViewDropZones view={draggingView} columns={layouts.layout?.columns ?? []} onDrop={dropViewHere} />
            ) : null}
            {cover.covering && fixedActive !== null ? (
              <FullViewExit className="absolute top-2 right-3 z-20 bg-card shadow-sm" />
            ) : null}
          </div>
        </WorkspaceMaximizeContext.Provider>
      </AvailableViewsContext.Provider>
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
      {drawerShown ? (
        <Suspense fallback={null}>
          <TerminalDrawer
            runId={run.id}
            height={drawer.height}
            onHeightChange={(height) => updateDrawer({ height })}
            onClose={() => updateDrawer({ open: false })}
            onMoveToColumn={() => {
              updateDrawer({ open: false })
              openBeside('terminal')
            }}
            onOpenInBrowser={openInBrowser}
          />
        </Suspense>
      ) : null}
    </div>
  )
}

const noop = () => {}

function ColumnLoading({ title }: { title: string }) {
  return (
    <CenteredState
      icon={<LoaderCircleIcon className="motion-safe:animate-spin" />}
      tone="neutral"
      heading="h2"
      title={title}
    />
  )
}

/**
 * The Chat column: the Session route's data doctrine in a component that mounts only when a
 * layout shows the conversation, so a workspace of Changes and Files pays for no transcript.
 */
export function ConversationColumn({
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
    () => reduceThread(history.visibleEvents, { activeTurn: run.status === 'running', runner: run.runner }),
    [history.visibleEvents, run.status, run.runner],
  )
  const currentThread = useMemo(
    () => reduceThread(history.currentEvents, { activeTurn: run.status === 'running', runner: run.runner }),
    [history.currentEvents, run.status, run.runner],
  )
  useRunRecordReconcile(run, history.visibleEvents)

  if (history.isPending) return <ThreadLoading />

  // Inline code naming a task file or commit opens beside the chat; classified on first hover and
  // marked `data-open`, so only spans that do open something look like a link.
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

/** Is this inline code a file of the task or one of its commits? Deliberately narrow — a miss costs
 *  nothing, a false hit makes plain code look like a link. */
export function classifyReference(raw: string, worktree?: string): ThreadReference | null {
  const text = raw.trim()
  if (text.length < 3 || text.length > 260 || /\s/.test(text)) return null
  if (/^[0-9a-f]{7,40}$/.test(text) && /[a-f]/.test(text) && /[0-9]/.test(text)) return { view: 'commits', value: text }
  let path = text.replace(/:\d+(?::\d+)?$/, '')
  if (worktree && path.startsWith(`${worktree}/`)) path = path.slice(worktree.length + 1)
  if (path.startsWith('/') || path.startsWith('~') || /^[a-z]+:\/\//i.test(path)) return null
  path = path.replace(/^\.\//, '')
  if (path.startsWith('..')) return null
  if (!/^[\w@.+\-()[\]]+(?:\/[\w@.+\-()[\]]+)*\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(path)) return null
  if (!path.includes('/') && !/\.(?:tsx?|jsx?|mjs|cjs|json|md|mdx|css|scss|html|ya?ml|toml|py|rs|go|rb|java|kt|swift|sh|sql|lock|txt|env|svg|png|jpe?g)$/i.test(path)) return null
  return { view: 'files', value: path }
}
