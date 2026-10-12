import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { ApiError, cancelRun } from '@/api/client'
import { queryKeys } from '@/api/queries'
import type { ApiRun } from '@open-mercato/cezar-api-client'
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
import { runTitle } from '@/lib/task-groups'

export type RunConfirmKind = 'cancel' | 'delete'

/** The destructive confirms — one dialog, two scripts. Never a native confirm(). Shared by the
 *  run header and the composer's Stop, so "what does stopping do?" is answered in one place. */
export function RunConfirmDialog({
  run,
  confirming,
  onOpenChange,
  onConfirm,
}: {
  run: ApiRun
  confirming: RunConfirmKind | null
  onOpenChange: (open: boolean) => void
  onConfirm: (kind: RunConfirmKind) => void
}) {
  return (
    <AlertDialog open={confirming !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{confirming === 'delete' ? 'Delete this task?' : 'Stop this task?'}</AlertDialogTitle>
          <AlertDialogDescription>
            {confirming === 'delete' ? (
              <>
                This removes the run, its transcript, its worktree and its branch. There is no
                undo.
                <span className="mt-1 block truncate font-medium text-foreground" title={runTitle(run)}>
                  {runTitle(run)}
                </span>
              </>
            ) : run.status === 'queued' ? (
              // Nothing has started yet, so there is no agent to stop — say what actually happens.
              'The task leaves the queue before it starts and completes as cancelled.'
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
              if (confirming) onConfirm(confirming)
              onOpenChange(false)
            }}
          >
            {confirming === 'delete' ? 'Delete' : 'Stop the run'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * Stopping a run from the composer: the request (open the confirm), the dialog to render, and the
 * pending flag. It ends the whole run (not just the current turn), so it confirms first, through
 * the same dialog the header's menu opens. The composer's send button IS the trigger (it turns
 * into ■ while the agent works and the box is empty) — see `Composer.stop`.
 */
export function useStopRun(run: ApiRun) {
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState<RunConfirmKind | null>(null)
  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
  const cancel = useMutation({
    mutationFn: () => cancelRun(run.id),
    onSuccess: invalidate,
    onError: (error: Error) => {
      // A 409 means the run already left the live state — redraw to the truth (run-header's rule).
      if (error instanceof ApiError && error.status === 409) void invalidate()
      toast(error.message, { tone: 'danger' })
    },
  })
  return {
    request: () => setConfirming('cancel'),
    pending: cancel.isPending,
    dialog: (
      <RunConfirmDialog
        run={run}
        confirming={confirming}
        onOpenChange={(open) => !open && setConfirming(null)}
        onConfirm={() => cancel.mutate()}
      />
    ),
  }
}
