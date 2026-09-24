import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { commitRun } from '@/api/client'
import { queryKeys } from '@/api/queries'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { runTitle } from '@/lib/task-groups'
import { isSubmitShortcut } from '@/lib/use-submit-shortcut'

/**
 * The Commit dialog (spec #390: "message box prefilled with auto-summary; commit -A").
 * `POST /api/runs/:id/git/commit` stages everything and commits in the run's worktree; every
 * predictable git failure (clean tree, hook, identity) comes back as a 409 whose words land
 * in the danger toast verbatim.
 */
export function CommitDialog({
  run,
  open,
  onOpenChange,
}: {
  run: ApiRun
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [message, setMessage] = useState('')

  // Re-prefill on every open: the run's display title (titleSummary ?? title) is the
  // auto-summary the spec names; an abandoned edit must not leak into the next commit.
  // Deps are [open] alone ON PURPOSE: a record refetch (SSE) while the dialog is open must
  // not clobber a half-edited message.
  const title = runTitle(run)
  const titleRef = useRef(title)
  titleRef.current = title
  useEffect(() => {
    if (open) setMessage(titleRef.current)
  }, [open])

  const commit = useMutation({
    mutationFn: (text: string) => commitRun(run.id, text),
    onSuccess: (result) => {
      toast(`Committed ${result.sha.slice(0, 7)}`)
      onOpenChange(false)
      // The diff is anchored at the merge-base, so the files stay visible — but the record's
      // diffStat and the repo commit log moved; refetch what claims to know them.
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.changes(run.id) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  const submit = () => {
    const text = message.trim()
    if (text.length === 0 || commit.isPending) return
    commit.mutate(text)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="commit-dialog">
        <DialogHeader>
          <DialogTitle>Commit changes</DialogTitle>
          <DialogDescription>
            Stages everything in the task&apos;s worktree (git add -A) and commits to{' '}
            {run.branch ? <span className="font-mono">{run.branch}</span> : 'its branch'}.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          data-slot="commit-message"
          aria-label="Commit message"
          rows={3}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            // Like the review notes box: ⌘↵ / Ctrl+↵ submit, plain Enter stays a newline —
            // commit messages are multi-line prose with no Enter-sends muscle memory.
            const submits = isSubmitShortcut({
              key: event.key,
              shiftKey: event.shiftKey,
              metaKey: event.metaKey,
              ctrlKey: event.ctrlKey,
              altKey: event.altKey,
              repeat: event.repeat,
              isComposing: event.nativeEvent.isComposing,
            })
            if (submits && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            data-slot="commit-confirm"
            disabled={message.trim().length === 0 || commit.isPending}
            onClick={submit}
          >
            {commit.isPending ? 'Committing…' : 'Commit'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
