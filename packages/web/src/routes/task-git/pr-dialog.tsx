import { useEffect, useRef, useState } from 'react'

import { draftRunPr } from '@/api/client'
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
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

export interface PrEdit {
  title?: string
  body?: string
}

type Preview = { phase: 'loading' } | { phase: 'ready'; title: string; body: string; generated: boolean } | { phase: 'failed' }

/**
 * The publish dialog (#1757): the server's generated title and body — or its unchanged fallback —
 * editable before `gh pr create`. Never a gate: Create PR works while the preview loads or after
 * it failed, and then publishes exactly what it did before this dialog existed.
 */
export function PrDialog({
  run,
  open,
  onOpenChange,
  draft,
  publishing,
  onPublish,
}: {
  run: ApiRun
  open: boolean
  onOpenChange: (open: boolean) => void
  draft: boolean
  publishing: boolean
  onPublish: (edit: PrEdit) => void
}) {
  const [preview, setPreview] = useState<Preview>({ phase: 'loading' })
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  // A preview answering after the dialog closed (or reopened) must not land in the new one.
  const ask = useRef(0)

  useEffect(() => {
    if (!open) return
    const mine = ++ask.current
    setPreview({ phase: 'loading' })
    draftRunPr(run.id).then(
      (answer) => {
        if (ask.current !== mine) return
        setPreview({ phase: 'ready', ...answer })
        setTitle(answer.title)
        setBody(answer.body)
      },
      () => {
        if (ask.current === mine) setPreview({ phase: 'failed' })
      },
    )
    return () => {
      ask.current++
    }
  }, [open, run.id])

  const ready = preview.phase === 'ready'
  const submit = () => {
    if (publishing) return
    // Without a preview there is nothing to send: the server's default title and body apply.
    onPublish(ready && title.trim() && body.trim() ? { title: title.trim(), body } : {})
  }
  const label = draft ? 'Create draft PR' : 'Create PR'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="pr-dialog" className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
          <DialogDescription data-slot="pr-dialog-status">
            {preview.phase === 'loading'
              ? 'Writing a title and description from the task’s changes…'
              : preview.phase === 'failed'
                ? 'Could not prepare a description — the PR gets the task’s handoff notes.'
                : preview.generated
                  ? 'Generated from the task’s changes — edit before publishing.'
                  : 'From the task’s handoff notes — edit before publishing.'}
          </DialogDescription>
        </DialogHeader>
        <Input
          data-slot="pr-title"
          aria-label="Pull request title"
          value={title}
          disabled={!ready}
          placeholder={ready ? undefined : run.title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <Textarea
          data-slot="pr-body"
          aria-label="Pull request description"
          rows={14}
          className="max-h-[50vh] font-mono text-xs"
          value={body}
          disabled={!ready}
          onChange={(event) => setBody(event.target.value)}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            data-slot="pr-confirm"
            disabled={publishing || (ready && (!title.trim() || !body.trim()))}
            onClick={submit}
          >
            {publishing ? 'Publishing…' : label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
