import { useRemoveProject } from '@/api/queries'
import type { ProjectListEntry } from '@open-mercato/cezar-api-client'
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
import { toast } from '@/components/ui/toaster'

/**
 * Removing a project, said the same way in both places that offer it: the global registry table
 * (Settings → Projects) and the project's own General page.
 *
 * "Remove" next to a project path is exactly the kind of button a user reads as "delete my repo",
 * so the wording is load-bearing and belongs in ONE file — the confirm title, the body, the path
 * it names and the success toast all insist on the same fact: this DEREGISTERS.
 * `DELETE /api/v1/projects/:id` is a registry filter and touches nothing under the root (see the
 * route), and adding the folder back later finds its tasks and worktrees intact. It does NOT come
 * back on its own: boot registration is seed-once (`shouldAutoRegisterProject`), so serving the
 * folder again never re-registers it.
 *
 * The refusal that stays the server's is live work: a project with running tasks answers 409, and
 * its message is toasted verbatim. The boot project is NOT a refusal any more — removing the folder
 * cezar is serving is allowed and does what the button says (it leaves your project list; cezar
 * keeps serving the folder until you stop it). `isBoot` says so in the confirm step, because "it
 * stops being one of my projects" and "cezar stops running there" are two different sentences and
 * only the first one is true.
 */

/** The deregistration itself, with the wording every caller shares. `onRemoved` runs only after
 *  the server confirmed — the project's own settings page uses it to navigate off a URL that has
 *  just stopped resolving. */
export function useProjectRemoval() {
  const remove = useRemoveProject()
  return {
    isPending: remove.isPending,
    confirm: (project: ProjectListEntry, onRemoved?: () => void) =>
      remove.mutate(project.id, {
        // "Removed from the workspace", not "Deleted": the toast is the last word the user reads
        // about a button they may have pressed nervously.
        onSuccess: () => {
          toast(`${project.name} removed from the workspace — its files are untouched`)
          onRemoved?.()
        },
        onError: (error: Error) => toast(error.message, { tone: 'danger' }),
      }),
  }
}

/** The confirm step. `project` doubles as the open state — `null` while it is closed. */
export function RemoveProjectDialog({
  project,
  isBoot = false,
  onOpenChange,
  onConfirm,
}: {
  project: ProjectListEntry | null
  /** The folder this server was started in — see the header comment on why it is asked. */
  isBoot?: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  return (
    <AlertDialog open={project !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {project?.name} from the workspace?</AlertDialogTitle>
          <AlertDialogDescription>
            This only unregisters the project — <strong>nothing on disk is deleted</strong>. The
            folder, its git history and its task history all stay exactly where they are, and
            adding it back later finds everything intact.
            <span className="mt-1 block truncate font-mono text-[11px] text-foreground" title={project?.root}>
              {project?.root}
            </span>
            {isBoot ? (
              // The consequence the plain wording above does not cover, and the reason this dialog
              // exists as its own component: cezar is serving this folder, and unregistering it
              // does not stop that.
              <span data-slot="projects-remove-boot" className="mt-1 block text-[11px]">
                cezar is serving this folder right now, and keeps serving it after this — it just
                leaves your project list until you add it back.
                {project ? ' If it was your only project, cezar will list it again as “not registered”.' : null}
              </span>
            ) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction
            data-action="projects-confirm-remove"
            className="bg-danger text-danger-foreground hover:brightness-[0.96]"
            onClick={onConfirm}
          >
            Remove from list
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
