import type { ApiRun } from '@open-mercato/cezar-api-client'
import { useRunGitStatus } from '@/api/queries'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { runTitle } from '@/lib/task-groups'
import { canRemoveTaskWorktree } from './run-actions'

/** Mounted only while open, so status is checked again for each confirmation. */
export function TaskWorktreeRemovalDialog({ run, pending, onClose, onConfirm }: {
  run: ApiRun
  pending: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  const status = useRunGitStatus(run.id, true)
  const clean = status.data?.uncommitted === 0
  const ready = canRemoveTaskWorktree(run) && !status.isFetching && !status.isError && clean && !pending
  return (
    <AlertDialog open onOpenChange={open => { if (!open && !pending) onClose() }}>
      <AlertDialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col">
        <AlertDialogHeader className="min-h-0 overflow-y-auto">
          <AlertDialogTitle>Remove this task’s worktree?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>The task, transcript and local branch stay, including unpushed commits. Continue can recreate the checkout from that branch.</p>
              <p>Ignored local files, including build artifacts and dependencies, are deleted and must be rebuilt. Commit or stash any other uncommitted changes first.</p>
              <p className="break-words font-medium text-foreground">{runTitle(run)}</p>
              <p className="break-all font-mono text-xs">{run.worktreePath}</p>
              <p role="status">
                {pending ? 'Requesting worktree removal…' : !canRemoveTaskWorktree(run)
                  ? 'This task no longer has a removable worktree.' : status.isFetching
                    ? 'Checking for uncommitted changes…' : status.isError || status.data?.uncommitted === undefined
                      ? 'Could not check the worktree. It may be missing or unavailable. Close this dialog and try again.'
                      : !clean ? 'This worktree has uncommitted changes. Commit or stash them before removing it.'
                        : 'The worktree has no uncommitted changes. Cleanup runs before the directory is removed; if it needs attention, resolve it on this task.'}
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="shrink-0">
          <AlertDialogCancel disabled={pending}>Keep worktree</AlertDialogCancel>
          <AlertDialogAction disabled={!ready} className="bg-danger text-danger-foreground hover:brightness-[0.96]"
            onClick={event => { event.preventDefault(); if (ready) onConfirm() }}>
            {pending ? 'Requesting…' : 'Remove worktree'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
