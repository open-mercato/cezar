import { useEffect, useState } from 'react'

import { useRunFileOps } from '@/api/queries'
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

/**
 * The Code view's file operations (spec `2026-07-20-worktree-file-editing` §Revision 2026-10-10,
 * step 3): create, rename, delete — one dialog, three intents. Files only; the server refuses a
 * directory, and everything under `.git` or `node_modules`, in its own words, which are shown
 * verbatim rather than second-guessed here.
 */
export type FileAction =
  | { kind: 'create'; dir: string }
  | { kind: 'rename'; path: string }
  | { kind: 'delete'; path: string }

export function FileActionDialog({
  runId,
  action,
  onClose,
  onDone,
}: {
  runId: string
  action: FileAction | null
  onClose: () => void
  /** The path to show next: the new file, the renamed file, or null after a delete. */
  onDone: (path: string | null) => void
}) {
  const ops = useRunFileOps(runId)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const pending = ops.create.isPending || ops.rename.isPending || ops.remove.isPending

  // A dialog opened for a different target starts from that target, not the last one's text.
  const seed = action === null ? '' : action.kind === 'create' ? (action.dir ? `${action.dir}/` : '') : action.path
  useEffect(() => {
    setValue(seed)
    setError(null)
  }, [seed, action?.kind])

  const settle = (path: string | null) => ({
    onSuccess: () => {
      onDone(path)
      onClose()
    },
    onError: (err: Error) => setError(err.message),
  })
  const path = value.trim()

  if (action?.kind === 'delete') {
    return (
      <AlertDialog open onOpenChange={(open) => { if (!open && !pending) onClose() }}>
        <AlertDialogContent data-slot="file-delete-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this file?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="block truncate rounded-md bg-muted px-2 py-1.5 font-mono text-xs text-foreground" title={action.path}>
                {action.path}
              </span>
              <span className="mt-2 block">
                It is removed from the task&apos;s working directory, and the cockpit cannot bring it back. Its
                content is kept as a git object for about two weeks; the run&apos;s event log names it.
              </span>
              {error ? <span role="alert" className="mt-2 block text-danger">{error}</span> : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={pending}
              onClick={(event) => {
                // Stay open until the server answers: a refusal must be readable where it was asked.
                event.preventDefault()
                ops.remove.mutate(action.path, settle(null))
              }}
            >
              {pending ? 'Deleting…' : 'Delete file'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    )
  }

  const creating = action?.kind === 'create'
  const unchanged = action?.kind === 'rename' && path === action.path
  const submit = () => {
    if (action === null || path === '' || path.endsWith('/') || unchanged || pending) return
    if (action.kind === 'create') ops.create.mutate(path, settle(path))
    else if (action.kind === 'rename') ops.rename.mutate({ from: action.path, to: path }, settle(path))
  }

  return (
    <Dialog open={action !== null} onOpenChange={(open) => { if (!open && !pending) onClose() }}>
      <DialogContent data-slot="file-path-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{creating ? 'New file' : 'Rename or move file'}</DialogTitle>
          <DialogDescription>
            {creating
              ? 'A path inside the task’s working directory. Folders in it are created as needed.'
              : 'The new path inside the task’s working directory. It must not exist yet.'}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <Input
            autoFocus
            aria-label="File path"
            className="font-mono text-xs"
            placeholder="src/new-file.ts"
            spellCheck={false}
            autoComplete="off"
            value={value}
            onChange={(event) => {
              setValue(event.target.value)
              setError(null)
            }}
          />
          {error ? (
            <p role="alert" data-slot="file-action-error" className="mt-2 text-xs text-danger">
              {error}
            </p>
          ) : null}
          <DialogFooter className="mt-4">
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" variant="contrast" disabled={path === '' || path.endsWith('/') || unchanged || pending}>
              {creating ? 'Create' : 'Rename'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
