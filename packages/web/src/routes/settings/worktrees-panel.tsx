import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { reclaimWorktrees, removeRunWorktree } from '@/api/client'
import { queryKeys, useWorktrees } from '@/api/queries'
import type { WorktreeInfo } from '@open-mercato/cezar-api-client'
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
import { toast } from '@/components/ui/toaster'
import { formatMem } from '@/lib/tasks-table'
import { shortAge } from '@/lib/format'

/** What the confirm dialog is about — a bulk reclaim, or one row's delete. */
type Confirming = { kind: 'reclaim' } | { kind: 'delete'; runId: string; title: string } | null

/**
 * Settings → Resources: the worktrees management panel (#483). Lists every task
 * worktree materialized on disk with its size, age and retention state; a
 * per-row Delete (reclaims the directory AND branch, the spec-006 route), a
 * footer with the total disk used and the keep-limit, and a "Reclaim now" button
 * that runs the count-based enforcer immediately. Both destructive actions
 * confirm through the design-system AlertDialog (native confirm() is banned).
 * Live-updates through the global event stream (queryKeys.worktrees).
 */
export function WorktreesPanel() {
  const worktrees = useWorktrees()
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState<Confirming>(null)
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.worktrees })

  const reclaim = useMutation({
    mutationFn: () => reclaimWorktrees(),
    onSuccess: (result) => {
      void refresh()
      toast(
        result.reclaimed.length === 0
          ? 'Nothing to reclaim — all worktrees are within the limit'
          : `Reclaimed ${result.reclaimed.length} worktree${result.reclaimed.length === 1 ? '' : 's'} (branch kept)`,
      )
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  const remove = useMutation({
    mutationFn: (runId: string) => removeRunWorktree(runId),
    onSuccess: () => {
      void refresh()
      toast('Worktree removed')
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  if (worktrees.isPending) {
    return (
      <p data-slot="worktrees-loading" className="text-[13px] text-soft-foreground">
        Loading worktrees…
      </p>
    )
  }
  if (worktrees.isError) {
    return (
      <p data-slot="worktrees-error" className="text-[13px] text-danger">
        Worktrees did not load: {worktrees.error.message}
      </p>
    )
  }

  const { worktrees: rows, totalBytes, keep } = worktrees.data
  const busy = reclaim.isPending || remove.isPending

  const runConfirmed = () => {
    if (confirming?.kind === 'reclaim') reclaim.mutate()
    else if (confirming?.kind === 'delete') remove.mutate(confirming.runId)
    setConfirming(null)
  }

  return (
    <div data-slot="worktrees-panel" className="flex flex-col gap-3">
      {rows.length === 0 ? (
        <p data-slot="worktrees-empty" className="text-[13px] text-soft-foreground">
          No task worktrees on disk.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">Task worktrees currently materialized on disk</caption>
            <thead>
              <tr className="border-b border-border text-left text-[12px] text-soft-foreground">
                <th scope="col" className="px-3 py-2 font-medium">Task</th>
                <th scope="col" className="px-3 py-2 font-medium">Status</th>
                <th scope="col" className="px-3 py-2 font-medium">Size</th>
                <th scope="col" className="px-3 py-2 font-medium">Age</th>
                <th scope="col" className="px-3 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => (
                <WorktreeRow
                  key={w.runId}
                  worktree={w}
                  disabled={busy}
                  onDelete={() => setConfirming({ kind: 'delete', runId: w.runId, title: w.title })}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p data-slot="worktrees-footer" className="text-[12px] text-soft-foreground">
          {rows.length} worktree{rows.length === 1 ? '' : 's'}
          {totalBytes !== null ? ` · ${formatMem(totalBytes) || '0 kB'} on disk` : ' · size unavailable'}
          {' · '}
          {keep === 0 ? 'keeping all (unlimited)' : `keeping the last ${keep}`}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-action="worktrees-reclaim-now"
          disabled={busy}
          onClick={() => setConfirming({ kind: 'reclaim' })}
        >
          Reclaim now
        </Button>
      </div>

      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirming?.kind === 'delete' ? 'Delete this worktree?' : 'Reclaim old worktrees?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming?.kind === 'delete' ? (
                <>
                  This removes the worktree directory and its branch — the local-only work is not
                  recoverable afterwards.
                  <span className="mt-1 block truncate font-medium text-foreground" title={confirming.title}>
                    {confirming.title}
                  </span>
                </>
              ) : (
                'Finished worktrees beyond the keep-limit are reclaimed now (directory only). Their branches are kept, so the work stays recoverable.'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              data-action="worktrees-confirm"
              className={confirming?.kind === 'delete' ? 'bg-danger text-danger-foreground hover:brightness-[0.96]' : undefined}
              onClick={runConfirmed}
            >
              {confirming?.kind === 'delete' ? 'Delete' : 'Reclaim now'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function WorktreeRow({
  worktree,
  disabled,
  onDelete,
}: {
  worktree: WorktreeInfo
  disabled: boolean
  onDelete: () => void
}) {
  return (
    <tr data-slot="worktree-row" data-run={worktree.runId} className="border-b border-border last:border-0">
      <th scope="row" className="max-w-[220px] px-3 py-2 text-left font-normal">
        <span className="block truncate text-foreground" title={worktree.title}>{worktree.title}</span>
        <span className="block truncate font-mono text-[11px] text-soft-foreground">
          {worktree.branch ?? worktree.runId.slice(0, 8)}
        </span>
      </th>
      <td className="px-3 py-2">
        <span className="text-[12px] text-soft-foreground">{worktree.status}</span>
        {worktree.reclaimable ? (
          <span data-slot="worktree-reclaimable" className="ml-1 text-[11px] text-soft-foreground">
            (reclaimable)
          </span>
        ) : null}
      </td>
      <td className="px-3 py-2 tabular-nums text-soft-foreground">
        {worktree.sizeBytes !== null ? formatMem(worktree.sizeBytes) || '0 kB' : '—'}
      </td>
      <td className="px-3 py-2 tabular-nums text-soft-foreground">{shortAge(worktree.finishedAt ?? undefined) || '—'}</td>
      <td className="px-3 py-2 text-right">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-action="worktree-delete"
          aria-label={`Delete the worktree for ${worktree.title}`}
          disabled={disabled}
          onClick={onDelete}
        >
          Delete
        </Button>
      </td>
    </tr>
  )
}
