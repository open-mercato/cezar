import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CircleStopIcon,
  MailIcon,
  MailOpenIcon,
  PencilIcon,
  Trash2Icon,
} from 'lucide-react'
import { Fragment, useRef, useState, type ReactNode } from 'react'

import {
  archiveProjectRun,
  cancelProjectRun,
  deleteProjectRun,
  patchProjectRun,
  setProjectRunRead,
} from '@/api/client'
import { invalidateRunCaches } from '@/api/queries'
import { queryScope, type RunRecord } from '@open-mercato/cezar-api-client'
import { useTitleEditor, type TitleEditor } from '@/components/editable-title'
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
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { toast } from '@/components/ui/toaster'
import { useNavigate } from '@/lib/project-router'
import { runTitle } from '@/lib/task-groups'
import { taskRowMenuItems, type TaskRowAction } from '@/lib/task-row-menu'

/**
 * The sidebar task row's right-click menu — rename the task, file it away, or stop/remove it,
 * without first opening its thread.
 *
 * It WRAPS a row rather than replacing one: the child is the row exactly as the quick-list paints
 * it, handed to Radix's context-menu trigger with `asChild`, so left-click still navigates and
 * middle-click still opens a new tab. Only the browser's own context menu is taken over.
 *
 * Which items appear is `lib/task-row-menu.ts` — `runActionFlags` plus labelling, table-tested
 * there. This component is the wiring: one endpoint per verb, a confirm dialog in front of the
 * two destructive ones, and the server's own words in a danger toast when something is refused.
 *
 * The child is a FUNCTION of the rename editor, because renaming is the one action whose surface
 * is the row itself: the title flips in place into the shared `TitleEditInput`. The menu owns the
 * state machine (it is what begins an edit) and the row owns the markup (an h1, a table cell and
 * a sidebar row do not look alike) — the same split `components/editable-title.tsx` already makes
 * for the run header and the Tasks table.
 */
export function TaskRowMenu({
  run,
  scope = null,
  active = false,
  children,
}: {
  run: RunRecord
  /** The row's EXPLICIT project (`/p/<id>` scope), or null for the mounted one. Every request
   *  below is addressed with it — see `useTaskRowActions`. */
  scope?: string | null
  /** Is this the run the user is currently looking at? Only then does deleting it navigate. */
  active?: boolean
  children: (editor: TitleEditor) => ReactNode
}) {
  const actions = useTaskRowActions(run, scope, active)
  const items = taskRowMenuItems(run)

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children(actions.editor)}</ContextMenuTrigger>
        <ContextMenuContent
          data-slot="task-row-menu"
          className="min-w-[10rem]"
          onCloseAutoFocus={actions.onMenuCloseAutoFocus}
        >
          {items.map((item) => (
            <Fragment key={item.action}>
              {item.startsGroup ? <ContextMenuSeparator /> : null}
              <ContextMenuItem
                data-action={item.action}
                variant={item.destructive ? 'destructive' : 'default'}
                onSelect={() => actions.select(item.action)}
              >
                <ActionIcon action={item.action} />
                {item.label}
              </ContextMenuItem>
            </Fragment>
          ))}
        </ContextMenuContent>
      </ContextMenu>
      {/* Outside the menu on purpose: Radix unmounts the menu's content as it closes, and a
          dialog mounted inside it would go with it before it could ever be seen. */}
      <ConfirmDialog run={run} actions={actions} />
    </>
  )
}

function ActionIcon({ action }: { action: TaskRowAction }) {
  switch (action) {
    case 'rename':
      return <PencilIcon aria-hidden="true" />
    case 'archive':
      return <ArchiveIcon aria-hidden="true" />
    case 'unarchive':
      return <ArchiveRestoreIcon aria-hidden="true" />
    case 'mark-read':
      return <MailOpenIcon aria-hidden="true" />
    case 'mark-unread':
      return <MailIcon aria-hidden="true" />
    case 'cancel':
      return <CircleStopIcon aria-hidden="true" />
    case 'delete':
      return <Trash2Icon aria-hidden="true" />
  }
}

type TaskRowActions = ReturnType<typeof useTaskRowActions>

/**
 * One mutation per verb, all addressed to the row's OWN project.
 *
 * `scope ?? queryScope()` is the load-bearing line. The sidebar paints rows from two places: the
 * mounted scope's list (scope null) and, in a multi-project workspace, one list per other
 * registered project (scope = that project's id). The unscoped client helpers all send
 * `queryScope()` — the ACTIVE project — so a right-click on another project's row would rename,
 * archive or delete whatever task happens to share that id in the project the user is standing
 * in. The global Tasks page's row actions are explicit for exactly this reason.
 */
function useTaskRowActions(run: RunRecord, scope: string | null, active: boolean) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState<'cancel' | 'delete' | null>(null)
  // A ref, not state: nothing renders differently for it, and it has to be readable from the
  // menu's close handler in the SAME commit that set it. See `onMenuCloseAutoFocus` below.
  const renaming = useRef(false)
  const projectId = scope ?? queryScope()

  const onError = (error: Error) => toast(error.message, { tone: 'danger' })
  const onSuccess = () => invalidateRunCaches(queryClient)

  const rename = useMutation({
    mutationFn: (title: string) => patchProjectRun(projectId, run.id, { title }),
    onSuccess,
    onError,
  })
  const archive = useMutation({
    mutationFn: (archived: boolean) => archiveProjectRun(projectId, run.id, archived),
    onSuccess,
    onError,
  })
  const read = useMutation({
    mutationFn: (isRead: boolean) => setProjectRunRead(projectId, run.id, isRead),
    onSuccess,
    onError,
  })
  const cancel = useMutation({
    mutationFn: () => cancelProjectRun(projectId, run.id),
    onSuccess,
    onError,
  })
  const remove = useMutation({
    mutationFn: () => deleteProjectRun(projectId, run.id),
    onSuccess: () => {
      onSuccess()
      // Only when the page the user is on IS this run. Deleting a row from the sidebar while
      // reading a different task must not move them somewhere they did not ask to go.
      if (active) void navigate('/')
    },
    onError,
  })

  // The stored title, not the displayed one: a row may drop a `NNN: ` prefix its reference chip
  // is already painting (#788), and an edit that started from the shortened text would silently
  // delete the number from the record.
  const editor = useTitleEditor(runTitle(run), (next) => rename.mutate(next))

  return {
    editor,
    confirming,
    setConfirming,
    /** What a menu item does when picked: begin a rename, ask before a destructive verb, or just
     *  fire — everything in the middle group is reversible from this same menu. */
    select: (action: TaskRowAction) => {
      if (action === 'rename') {
        // Recorded, not started — see `onMenuCloseAutoFocus`.
        renaming.current = true
      } else if (action === 'cancel' || action === 'delete') {
        setConfirming(action)
      } else {
        perform(action)
      }
    },
    /** The confirmed half of the two destructive verbs. */
    perform,
    /**
     * Where a rename actually BEGINS: once the menu has finished closing.
     *
     * Not in `onSelect`, and that is not a style choice. An open Radix menu traps focus — its
     * FocusScope listens for `focusin` and pulls focus back into the menu whenever it lands
     * outside. React applies the rename input's `autoFocus` during the same commit that closes
     * the menu, while that listener is still attached, so the input was focused and immediately
     * un-focused again; the blur that followed is `TitleEditor.commit`, and the edit was over
     * before a key could be pressed. (Observed exactly that: focus → input, focus → menu, blur.)
     *
     * `onCloseAutoFocus` runs after the content has unmounted and the trap is gone, so the input
     * mounts into a document with nothing left to fight. `preventDefault` then keeps Radix from
     * moving focus anywhere on its way out.
     */
    onMenuCloseAutoFocus: (event: Event) => {
      if (!renaming.current) return
      renaming.current = false
      event.preventDefault()
      editor.begin()
    },
  }

  function perform(action: TaskRowAction): void {
    switch (action) {
      case 'archive':
        archive.mutate(true)
        break
      case 'unarchive':
        archive.mutate(false)
        break
      case 'mark-read':
        read.mutate(true)
        break
      case 'mark-unread':
        read.mutate(false)
        break
      case 'cancel':
        cancel.mutate()
        break
      case 'delete':
        remove.mutate()
        break
      case 'rename':
        break
    }
  }
}

/** The same two questions the run header asks, in the same words — one confirm grammar for a
 *  destructive task action, wherever it was invoked from. */
function ConfirmDialog({ run, actions }: { run: RunRecord; actions: TaskRowActions }) {
  const confirming = actions.confirming
  return (
    <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && actions.setConfirming(null)}>
      <AlertDialogContent data-slot="task-row-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {confirming === 'delete' ? 'Delete this task?' : 'Cancel this task?'}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {confirming === 'delete' ? (
              <>
                This removes the run, its transcript, its worktree and its branch. There is no
                undo.
                <span className="mt-1 block truncate font-medium text-foreground" title={runTitle(run)}>
                  {runTitle(run)}
                </span>
              </>
            ) : (
              'The agent is stopped and the run completes as cancelled. The worktree stays.'
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction
            className="bg-danger text-danger-foreground hover:brightness-[0.96]"
            onClick={() => {
              if (confirming !== null) actions.perform(confirming)
              actions.setConfirming(null)
            }}
          >
            {confirming === 'delete' ? 'Delete' : 'Cancel the run'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
