import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CircleStopIcon,
  ExternalLinkIcon,
  MailIcon,
  MailOpenIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
} from 'lucide-react'
import * as React from 'react'
import type { RunRecord } from '@open-mercato/cezar-api-client'

import { ApiError, archiveRun, cancelRun, patchRun } from '@/api/client'
import {
  queryKeys,
  useMarkRunSeen,
  useMarkRunUnseen,
  usePinRun,
  writePatchedRunToCaches,
} from '@/api/queries'
import { TitleEditInput, useTitleEditor } from '@/components/editable-title'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { toast } from '@/components/ui/toaster'
import { Link, scopeTo } from '@/lib/project-router'
import { isUnread } from '@/lib/read-state'
import { runTitle } from '@/lib/task-groups'
import { cn } from '@/lib/utils'
import { runActionFlags } from '@/routes/task-thread/run-actions'

/**
 * The quick actions a task row offers in the Tasks sidebar — the header's own actions, reachable
 * without opening the task.
 *
 * WHICH actions a run offers is not decided here: `runActionFlags` (the run header's policy) and
 * `isUnread` answer that, so a row can never offer something the header would not. The mutations
 * are the ones those surfaces already drive — the shared read/unread/pin hooks, and the same
 * `archiveRun` / `cancelRun` / `patchRun` client calls the header and the Tasks table wrap.
 *
 * One scope owns the mutations for the whole list (the hooks take the run id as a variable), so
 * a hundred rows do not mount a hundred sets of mutation observers. A row outside a scope simply
 * has no menu — which is how every other caller of the quick-list stays exactly as it was.
 */
interface TaskRowActions {
  markRead: (run: RunRecord) => void
  markUnread: (run: RunRecord) => void
  togglePin: (run: RunRecord) => void
  toggleArchive: (run: RunRecord) => void
  rename: (run: RunRecord, title: string) => void
  /** Opens the confirm; stopping is never one click. */
  requestStop: (run: RunRecord) => void
}

const TaskRowActionsContext = React.createContext<TaskRowActions | null>(null)

/** Null outside a `TaskRowActionsScope` — the row's cue to render no menu. */
export function useTaskRowActions(): TaskRowActions | null {
  return React.useContext(TaskRowActionsContext)
}

export function TaskRowActionsScope({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient()
  const [stopping, setStopping] = React.useState<RunRecord | null>(null)

  const invalidate = React.useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
    [queryClient],
  )
  const onError = React.useCallback(
    (error: Error) => {
      // A 409 means the row was drawn from a record the server no longer has (Stop on a run that
      // just finished): refetch so the list redraws to the truth — the header's rule.
      if (error instanceof ApiError && error.status === 409) void invalidate()
      toast(error.message, { tone: 'danger' })
    },
    [invalidate],
  )

  const { mutate: markSeen } = useMarkRunSeen()
  const { mutate: markUnseen } = useMarkRunUnseen()
  const { mutate: pin } = usePinRun()
  const { mutate: archive } = useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) => archiveRun(id, archived),
    onSuccess: invalidate,
    onError,
  })
  const { mutate: cancel } = useMutation({
    mutationFn: (id: string) => cancelRun(id),
    onSuccess: invalidate,
    onError,
  })
  const { mutate: patch } = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => patchRun(id, { title }),
    onSuccess: (updated) => {
      writePatchedRunToCaches(queryClient, updated)
      void invalidate()
    },
    onError,
  })

  const actions = React.useMemo<TaskRowActions>(
    () => ({
      markRead: (run) => markSeen(run.id, { onError }),
      markUnread: (run) => markUnseen(run.id, { onError }),
      togglePin: (run) => pin({ id: run.id, pinned: !run.pinned }, { onError }),
      toggleArchive: (run) => archive({ id: run.id, archived: !run.archived }),
      rename: (run, title) => patch({ id: run.id, title }),
      requestStop: setStopping,
    }),
    [markSeen, markUnseen, pin, archive, patch, onError],
  )

  return (
    <TaskRowActionsContext.Provider value={actions}>
      {children}
      <AlertDialog open={stopping !== null} onOpenChange={(open) => !open && setStopping(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop this task?</AlertDialogTitle>
            <AlertDialogDescription>
              The agent is stopped and the run completes as cancelled. The worktree stays.
              {stopping ? (
                <span className="mt-1 block truncate font-medium text-foreground" title={runTitle(stopping)}>
                  {runTitle(stopping)}
                </span>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="bg-danger text-danger-foreground hover:brightness-[0.96]"
              onClick={() => {
                if (stopping) cancel(stopping.id)
                setStopping(null)
              }}
            >
              Stop the run
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TaskRowActionsContext.Provider>
  )
}

/**
 * The row's `…` trigger and its menu.
 *
 * A flex SIBLING of the row's link, never its child (a button inside an anchor is invalid), so a
 * click on it cannot open the task; the menu itself is portalled, and its clicks are stopped at
 * the content for any ancestor that does listen. The trigger is zero-width until the row is
 * hovered, focused or its menu is open — still in the tab order, like the pin it replaces.
 */
export function TaskRowMenu({
  run,
  scope,
  actions,
  onRename,
  className,
}: {
  run: RunRecord
  /** Explicit `/p/<id>` link scope for a non-active project's row; null = the active scope. */
  scope: string | null
  actions: TaskRowActions
  /** Flip the row's title into its inline editor. Called once the menu has closed. */
  onRename: () => void
  className?: string
}) {
  const flags = runActionFlags(run)
  const unread = isUnread(run)
  const title = runTitle(run)
  // Rename waits for the menu to finish closing: Radix hands focus back to the trigger on close,
  // which would blur — and so commit and dismiss — an editor that had already opened.
  const renameOnClose = React.useRef(false)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-slot="task-row-menu"
          aria-label={`Actions for ${title}`}
          title="Task actions"
          onClick={(event) => event.stopPropagation()}
          className={cn(
            'size-5 shrink-0 rounded-sm p-0 text-soft-foreground hover:bg-foreground/10 hover:text-foreground',
            className,
          )}
        >
          <MoreHorizontalIcon className="size-3.5" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="right"
        className="min-w-44"
        onClick={(event) => event.stopPropagation()}
        onCloseAutoFocus={(event) => {
          if (!renameOnClose.current) return
          renameOnClose.current = false
          event.preventDefault()
          onRename()
        }}
      >
        <DropdownMenuItem asChild>
          <Link to={scopeTo(scope, `/tasks/${run.id}`)} target="_blank" rel="noreferrer">
            <ExternalLinkIcon aria-hidden="true" /> Open in new tab
          </Link>
        </DropdownMenuItem>
        {unread ? (
          <DropdownMenuItem onSelect={() => actions.markRead(run)}>
            <MailOpenIcon aria-hidden="true" /> Mark read
          </DropdownMenuItem>
        ) : null}
        {flags.markUnread ? (
          <DropdownMenuItem onSelect={() => actions.markUnread(run)}>
            <MailIcon aria-hidden="true" /> Mark unread
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          onSelect={() => {
            renameOnClose.current = true
          }}
        >
          <PencilIcon aria-hidden="true" /> Rename
        </DropdownMenuItem>
        {flags.pin ? (
          <DropdownMenuItem onSelect={() => actions.togglePin(run)}>
            {run.pinned ? <PinOffIcon aria-hidden="true" /> : <PinIcon aria-hidden="true" />}
            {run.pinned ? 'Unpin' : 'Pin'}
          </DropdownMenuItem>
        ) : null}
        {flags.archive ? (
          <DropdownMenuItem onSelect={() => actions.toggleArchive(run)}>
            {run.archived ? <ArchiveRestoreIcon aria-hidden="true" /> : <ArchiveIcon aria-hidden="true" />}
            {run.archived ? 'Unarchive' : 'Archive'}
          </DropdownMenuItem>
        ) : null}
        {flags.cancel ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => actions.requestStop(run)}>
              <CircleStopIcon aria-hidden="true" /> Stop
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The row's title, flipped into the shared inline rename editor: Enter/blur commit, Escape
 *  abandons. Mounted only while renaming, so it opens itself and reports back when it closes. */
export function TaskRowRename({
  run,
  actions,
  onDone,
}: {
  run: RunRecord
  actions: TaskRowActions
  onDone: () => void
}) {
  const editor = useTitleEditor(runTitle(run), (next) => actions.rename(run, next))
  // Two effects rather than one with a ref: StrictMode re-runs effects against the first render's
  // closure, where the editor has not opened yet, and a single effect would read that as "closed".
  const [opened, setOpened] = React.useState(false)
  React.useEffect(() => {
    editor.begin()
    setOpened(true)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- open once, on mount
  React.useEffect(() => {
    if (opened && !editor.editing) onDone()
  }, [opened, editor.editing]) // eslint-disable-line react-hooks/exhaustive-deps -- the close edge only

  if (!editor.editing) return null
  return <TitleEditInput editor={editor} className="min-w-0 flex-1 text-[13px] font-medium" />
}
