import { LayoutGridIcon, LoaderCircleIcon, MessageSquareTextIcon, SearchXIcon, TerminalIcon } from 'lucide-react'
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

import { ChangesView } from '../task-git/task-changes'
import { CommitsView } from '../task-git/task-commits'
import { FilesView } from '../task-git/task-files'
import { GitTabLoading } from '../task-git/git-tab-loading'
import { RunHeader } from '../task-thread/run-header'
import { ThreadLoading } from '../task-thread/thread-loading'
import { ThreadView } from '../task-thread/task-thread'
import { useDiffComments } from '../task-thread/diff-comments'
import { useRunRecordReconcile } from '../task-thread/run-reconcile'
import { reduceThread } from '../task-thread/thread-state'

import { BrowserView } from './browser-view'
import { LayoutCards } from './layout-cards'
import { ViewPickerMenu } from './view-picker'
import { WorkspaceColumns, type ColumnActions } from './workspace-columns'
import { useWorkspaceLayouts } from './use-workspace-layouts'
import { readDrawerState, writeDrawerState, type DrawerState } from './drawer-state'
import { emptyBrowserState, type ViewId, type WorkspaceColumn } from './layout-state'

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
  // Policy, read from the one place that knows it. A cockpit where a shell is not allowed shows
  // no button at all rather than one that explains itself after the click.
  const terminalAllowed = useHealth().data?.capabilities?.terminal === true

  // Memoized because `RunHeader` is `memo`'d on prop identity: a fresh element every render would
  // make that comparator always false and re-render the whole header on every thread frame.
  const tabs = useMemo(
    () => (
      <LayoutCards
        layouts={layouts.state.layouts}
        active={layouts.state.active}
        onSelect={selectLayout}
        onRename={renameLayout}
        onClose={closeLayout}
        onCreate={addLayout}
      />
    ),
    [layouts.state.layouts, layouts.state.active, selectLayout, renameLayout, closeLayout, addLayout],
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
          return <ConversationColumn run={run} onMarkedUnread={onMarkedUnread} />
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
                  title="Wczytywanie grafu…"
                />
              }
            >
              <GraphColumn run={run} embedded />
            </Suspense>
          )
      }
    },
    [activeName, onMarkedUnread, run, setColumnBrowser],
  )

  return (
    <div data-route="task-workspace" data-run-id={run.id} className="flex h-full min-h-0 flex-col">
      <RunHeader run={run} onMarkedUnread={markedUnread} tabs={tabs} />
      {terminalAllowed && !drawer.open ? (
        <div className="flex shrink-0 justify-end border-b border-border px-2 py-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-muted-foreground"
            onClick={() => updateDrawer({ open: true })}
          >
            <TerminalIcon aria-hidden="true" className="size-3.5" />
            Terminal
          </Button>
        </div>
      ) : null}
      {layouts.saveFailed ? (
        // Spec §2: a capability that cannot work degrades to a CLEAR state. The workspace still
        // works from memory for the rest of the visit — what is lost is only the remembering —
        // so this says exactly that rather than blocking anything.
        <div
          data-slot="layouts-unsaved"
          role="status"
          className="shrink-0 border-b border-border bg-muted/40 px-3 py-1 text-xs text-muted-foreground"
        >
          Nie udało się zapisać układu na tym hoście — działa dalej w tej karcie, ale nie wróci po
          odświeżeniu.
        </div>
      ) : null}
      {!layouts.ready ? (
        // The host still owes us this task's layouts (spec §5.3). Painting the default card first
        // and swapping it a tick later would flash a workspace the user never built, so the view
        // area holds the same skeleton a cold load of this URL already shows.
        <DeepLinkLoading view={deepLinkView} />
      ) : layouts.layout ? (
        <WorkspaceColumns columns={layouts.layout.columns} actions={actions} renderView={renderView} />
      ) : (
        // The workspace the user emptied by closing its last card. It stays empty for this visit
        // and comes back as a fresh `Czat` on the next one (§5.3) — the state module's recovery
        // rule, not a second code path here.
        <CenteredState
          icon={<LayoutGridIcon />}
          tone="neutral"
          heading="h2"
          title="Brak układów"
          subtitle="Zamknąłeś wszystkie układy tego zadania. Utwórz nowy albo wróć tu później — zadanie otworzy się wtedy z układem Czat."
          actions={
            <ViewPickerMenu
              heading="Nowy układ"
              onPick={addLayout}
              trigger={<Button variant="outline">Nowy układ</Button>}
            />
          }
        />
      )}
      <AlertDialog open={pendingView !== null} onOpenChange={(open) => !open && setPendingView(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Masz niewysłany komentarz</AlertDialogTitle>
            <AlertDialogDescription>
              {diffComments.comments.length === 1
                ? 'Jeden komentarz do zmian nie został jeszcze wysłany.'
                : `${diffComments.comments.length} komentarzy do zmian nie zostało jeszcze wysłanych.`}{' '}
              To ostatnia kolumna, która je pokazuje.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {/* `Wróć` keeps the comment and stays in Zmiany; `Zamknij mimo to` changes the view
                anyway — the two answers spec §5.2 names, in that order. */}
            <AlertDialogCancel>Wróć</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingView) layouts.setColumnView(pendingView.index, pendingView.view)
                setPendingView(null)
              }}
            >
              Zamknij mimo to
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
}: {
  run: ApiRun
  onMarkedUnread: (runId: string) => void
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

  return (
    <ThreadView
      run={run}
      thread={thread}
      currentThread={currentThread}
      history={history}
      onMarkedUnread={onMarkedUnread}
      embedded
    />
  )
}
