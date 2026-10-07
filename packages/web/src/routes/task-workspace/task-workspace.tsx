import { LayoutGridIcon, MessageSquareTextIcon, SearchXIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useParams } from 'react-router'

import { ApiError } from '@/api/client'
import { useMarkRunSeen, useRun } from '@/api/queries'
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
import { useRunRecordReconcile } from '../task-thread/run-reconcile'
import { reduceThread } from '../task-thread/thread-state'

import { LayoutCards } from './layout-cards'
import { ViewPickerMenu } from './view-picker'
import { WorkspaceColumns, type ColumnActions } from './workspace-columns'
import { useWorkspaceLayouts } from './use-workspace-layouts'
import type { ViewId } from './layout-state'

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
  const { openDeepLink, addLayout, closeLayout, selectLayout, renameLayout } = layouts

  // The deep-link hop. Keyed on the run id as well as the view: task A `/changes` → task B
  // `/changes` changes neither the path nor `openDeepLink`, and without the id in the deps task B
  // would open its default Czat card instead of the Changes the URL asked for.
  useEffect(() => {
    if (deepLinkView) openDeepLink(deepLinkView)
  }, [deepLinkView, openDeepLink, run.id])

  const markedUnread = useCallback(() => onMarkedUnread(run.id), [onMarkedUnread, run.id])

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

  const actions: ColumnActions = useMemo(
    () => ({
      addColumn: layouts.addColumn,
      closeColumn: layouts.closeColumn,
      setColumnView: layouts.setColumnView,
      resizeColumns: layouts.resizeColumns,
      moveColumn: layouts.moveColumn,
    }),
    [layouts.addColumn, layouts.closeColumn, layouts.setColumnView, layouts.resizeColumns, layouts.moveColumn],
  )

  // One run, one worktree: every column is handed the SAME record (spec §3.3), so no column can
  // drift onto another task's state or the boot repo.
  const renderView = useCallback(
    (view: ViewId) => {
      switch (view) {
        case 'session':
          return <ConversationColumn run={run} onMarkedUnread={onMarkedUnread} />
        case 'changes':
          return <ChangesView run={run} embedded />
        case 'commits':
          return <CommitsView run={run} embedded />
        case 'files':
          return <FilesView run={run} embedded />
      }
    },
    [run, onMarkedUnread],
  )

  return (
    <div data-route="task-workspace" data-run-id={run.id} className="flex h-full min-h-0 flex-col">
      <RunHeader run={run} onMarkedUnread={markedUnread} tabs={tabs} />
      {layouts.layout ? (
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
