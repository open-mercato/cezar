import { useMutation, useQueryClient } from '@tanstack/react-query'
import { FolderGit2Icon, MoreHorizontalIcon, RecycleIcon, Trash2Icon } from 'lucide-react'
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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/components/ui/toaster'
import { formatMem } from '@/lib/tasks-table'
import { shortAge } from '@/lib/format'
import { SettingsError, SettingsGroup } from './settings-field'

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

  const heading = {
    title: 'On disk',
    description:
      'Task worktrees currently on disk. Delete one to reclaim its space now, or reclaim everything past the keep-limit at once. Branches are always kept, so the work stays recoverable.',
  }

  if (worktrees.isPending) {
    return (
      <SettingsGroup {...heading} bare>
        <div data-slot="worktrees-loading" role="status" aria-label="Loading worktrees…">
          <Skeleton className="h-32 w-full rounded-xl" />
        </div>
      </SettingsGroup>
    )
  }
  if (worktrees.isError) {
    return (
      <SettingsGroup {...heading} bare>
        <SettingsError data-slot="worktrees-error" title="Worktrees did not load">
          {worktrees.error.message}
        </SettingsError>
      </SettingsGroup>
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
    <SettingsGroup
      {...heading}
      bare
      data-slot="worktrees-panel"
      actions={
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-action="worktrees-reclaim-now"
          disabled={busy}
          onClick={() => setConfirming({ kind: 'reclaim' })}
        >
          <RecycleIcon aria-hidden="true" className="size-3.5" />
          Reclaim now
        </Button>
      }
    >
      {rows.length === 0 ? (
        <Empty data-slot="worktrees-empty" className="rounded-xl border border-dashed border-border py-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderGit2Icon />
            </EmptyMedia>
            <EmptyTitle>No task worktrees on disk</EmptyTitle>
            <EmptyDescription>A worktree appears here when a task starts in its own checkout.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Card flush>
          <Table>
            <caption className="sr-only">Task worktrees currently materialized on disk</caption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-5">Task</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead className="text-right">Age</TableHead>
                <TableHead className="w-12 pr-3">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((w) => (
                <WorktreeRow
                  key={w.runId}
                  worktree={w}
                  disabled={busy}
                  onDelete={() => setConfirming({ kind: 'delete', runId: w.runId, title: w.title })}
                />
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <p data-slot="worktrees-footer" className="text-xs tabular-nums text-muted-foreground">
        {rows.length} worktree{rows.length === 1 ? '' : 's'}
        {totalBytes !== null ? ` · ${formatMem(totalBytes) || '0 kB'} on disk` : ' · size unavailable'}
        {' · '}
        {keep === 0 ? 'keeping all (unlimited)' : `keeping the last ${keep}`}
      </p>

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
                  <span className="mt-2 block truncate font-medium text-foreground" title={confirming.title}>
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
              className={confirming?.kind === 'delete' ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : undefined}
              onClick={runConfirmed}
            >
              {confirming?.kind === 'delete' ? 'Delete' : 'Reclaim now'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsGroup>
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
    <TableRow data-slot="worktree-row" data-run={worktree.runId}>
      <TableCell className="max-w-[260px] py-2.5 pl-5">
        <span className="block truncate font-medium text-foreground" title={worktree.title}>{worktree.title}</span>
        <span className="block truncate font-mono text-[11px] text-muted-foreground">
          {worktree.branch ?? worktree.runId.slice(0, 8)}
        </span>
      </TableCell>
      <TableCell>
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="font-normal">{worktree.status}</Badge>
          {worktree.reclaimable ? (
            <span data-slot="worktree-reclaimable" className="text-xs text-muted-foreground">
              reclaimable
            </span>
          ) : null}
        </span>
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        {worktree.sizeBytes !== null ? formatMem(worktree.sizeBytes) || '0 kB' : '—'}
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        {shortAge(worktree.finishedAt ?? undefined) || '—'}
      </TableCell>
      <TableCell className="pr-3 text-right">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={`Actions for ${worktree.title}`} disabled={disabled}>
              <MoreHorizontalIcon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              variant="destructive"
              data-action="worktree-delete"
              aria-label={`Delete the worktree for ${worktree.title}`}
              onSelect={onDelete}
            >
              <Trash2Icon aria-hidden="true" />
              Delete worktree
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  )
}
