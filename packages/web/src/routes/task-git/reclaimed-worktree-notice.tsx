import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArchiveRestoreIcon } from 'lucide-react'

import { restoreRunWorktree } from '@/api/client'
import { queryKeys } from '@/api/queries'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/components/ui/toaster'

import { isRunActive } from '../task-thread/run-actions'

/** "Restore worktree" (spec 2026-11-19-worktree-disk-usage): the resume path's re-materialization
 *  on demand. Every run query is refetched afterwards, so the tab flips to the live worktree. */
export function useRestoreWorktree(runId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => restoreRunWorktree(runId),
    onSuccess: (result) => {
      if (result.status === 'restored') toast('Worktree restored from its branch')
    },
    // A failure refreshes too: a branch deleted meanwhile turns the tab into its empty state.
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
  })
}

/**
 * The note a reclaimed task's Changes tab carries above its diff: what the diff is (the kept
 * branch's commits, not a worktree), why on-disk actions are gone, and the way back.
 */
export function ReclaimedWorktreeNotice({ run }: { run: ApiRun }) {
  const restore = useRestoreWorktree(run.id)
  const active = isRunActive(run.status)
  return (
    <div
      data-slot="reclaimed-worktree-notice"
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-4 py-2 text-label text-muted-foreground md:px-6"
    >
      <ArchiveRestoreIcon aria-hidden="true" className="size-4 shrink-0" />
      <p className="min-w-0 flex-1">
        Showing the committed changes on <code>{run.branch}</code>. This task&apos;s worktree was reclaimed to free
        disk, so uncommitted work, file context, editors and the terminal are unavailable until it is restored.
      </p>
      <RestoreWorktreeButton restore={restore} active={active} />
      {restore.isError ? (
        <p role="alert" data-slot="restore-worktree-error" className="basis-full text-danger">
          {restore.error.message}
        </p>
      ) : null}
    </div>
  )
}

function RestoreWorktreeButton({
  restore,
  active,
}: {
  restore: ReturnType<typeof useRestoreWorktree>
  active: boolean
}) {
  return (
    <Button
      size="sm"
      variant="outline"
      data-slot="restore-worktree"
      disabled={restore.isPending || active}
      title={active ? 'The task is running — restore it once it stops' : 'Check the branch out again into its worktree'}
      onClick={() => restore.mutate()}
    >
      {restore.isPending ? <Spinner /> : <ArchiveRestoreIcon aria-hidden="true" />}
      {restore.isPending ? 'Restoring…' : 'Restore worktree'}
    </Button>
  )
}

/** The restore button alone, with its error under it — for a view that has nothing to show
 *  without the tree (the Files tab's reclaimed state). */
export function RestoreWorktreeAction({ run }: { run: ApiRun }) {
  const restore = useRestoreWorktree(run.id)
  return (
    <div className="flex flex-col items-center gap-2">
      <RestoreWorktreeButton restore={restore} active={isRunActive(run.status)} />
      {restore.isError ? (
        <p role="alert" data-slot="restore-worktree-error" className="text-label text-danger">
          {restore.error.message}
        </p>
      ) : null}
    </div>
  )
}
