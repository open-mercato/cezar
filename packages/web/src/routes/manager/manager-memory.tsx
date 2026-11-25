import { PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'
import {
  MANAGER_MEMORY_LIMITS,
  managerMemoryKeySchema,
  managerMemoryKindSchema,
  type ManagerMemoryEntry,
  type ManagerMemoryKind,
  type ManagerSummary,
} from '@open-mercato/cezar-api-client'
import { useManagerMemory, useManagerMemoryWrite } from '@/api/managers'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const KIND_LABEL: Record<ManagerMemoryKind, string> = {
  preference: 'Preference',
  feedback: 'Feedback',
  decision: 'Decision',
  pointer: 'Ongoing work',
}

const SOURCE_LABEL: Record<ManagerMemoryEntry['source'], string> = { user: 'you', manager: 'the manager', import: 'imported' }

interface Draft { key: string; kind: ManagerMemoryKind; text: string; why: string; isNew: boolean }

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '')

function EntryForm({ draft, onChange, onCancel, onSave, saving, taken = [] }: {
  draft: Draft
  /** Keys already saved: a new entry under one would silently replace it. */
  taken?: string[]
  onChange: (draft: Draft) => void
  onCancel: () => void
  onSave: () => void
  saving: boolean
}) {
  const key = draft.isNew ? (draft.key || slug(draft.text)) : draft.key
  const keyValid = managerMemoryKeySchema.safeParse(key).success
  const keyTaken = draft.isNew && taken.includes(key)
  const valid = keyValid && !keyTaken && draft.text.trim().length > 0
  return (
    <form
      data-slot="manager-memory-form"
      className="flex flex-col gap-2 rounded-md border p-3"
      onSubmit={(event) => { event.preventDefault(); if (valid) onSave() }}
    >
      <div className="flex gap-2">
        <Select value={draft.kind} onValueChange={(kind) => onChange({ ...draft, kind: kind as ManagerMemoryKind })}>
          <SelectTrigger aria-label="Kind" className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            {managerMemoryKindSchema.options.map((kind) => <SelectItem key={kind} value={kind}>{KIND_LABEL[kind]}</SelectItem>)}
          </SelectContent>
        </Select>
        {draft.isNew ? (
          <Input
            aria-label="Key"
            placeholder={slug(draft.text) || 'key, e.g. full-prs-not-drafts'}
            value={draft.key}
            onChange={(event) => onChange({ ...draft, key: event.target.value })}
            className="flex-1 font-mono text-xs"
          />
        ) : <span className="flex-1 self-center truncate font-mono text-xs text-muted-foreground">{draft.key}</span>}
      </div>
      <Textarea
        aria-label="What to remember"
        placeholder="Open full PRs, not drafts"
        maxLength={MANAGER_MEMORY_LIMITS.text}
        value={draft.text}
        onChange={(event) => onChange({ ...draft, text: event.target.value })}
        rows={2}
      />
      <Input
        aria-label="Why (optional)"
        placeholder="Why (optional)"
        maxLength={MANAGER_MEMORY_LIMITS.why}
        value={draft.why}
        onChange={(event) => onChange({ ...draft, why: event.target.value })}
      />
      {draft.isNew && draft.key && !keyValid ? <p className="text-xs text-danger">Use lowercase letters, digits and dashes.</p> : null}
      {keyTaken ? <p className="text-xs text-danger">“{key}” is already saved: edit that entry instead.</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" disabled={!valid || saving}>Save</Button>
      </div>
    </form>
  )
}

/** Spec 2026-11-21-manager-short-sessions-and-memory § 2.1: what every new session starts from. */
export function MemoryDialog({ manager, open, onOpenChange, onCloseAutoFocus }: {
  manager: ManagerSummary
  open: boolean
  onOpenChange: (open: boolean) => void
  onCloseAutoFocus?: (event: Event) => void
}) {
  const query = useManagerMemory(manager.id, open)
  const write = useManagerMemoryWrite(manager.id)
  const [draft, setDraft] = useState<Draft | null>(null)
  const data = query.data
  const save = () => {
    if (!draft) return
    const key = draft.isNew ? (draft.key || slug(draft.text)) : draft.key
    write.mutate(
      { key, input: { kind: draft.kind, text: draft.text.trim(), ...(draft.why.trim() ? { why: draft.why.trim() } : {}), source: 'user' } },
      { onSuccess: () => setDraft(null), onError: (error) => toast(errorMessage(error), { tone: 'danger' }) },
    )
  }
  const remove = (key: string) => write.mutate({ key }, { onError: (error) => toast(errorMessage(error), { tone: 'danger' }) })
  const full = data ? data.entries.length >= data.limits.entries : false
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-slot="manager-memory"
        className="grid max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)] sm:max-w-xl"
        {...(onCloseAutoFocus ? { onCloseAutoFocus } : {})}
      >
        <DialogHeader>
          <DialogTitle>Memory</DialogTitle>
          <DialogDescription>
            What {manager.name} carries into every new session: your preferences, feedback, standing decisions and ongoing work. It saves these when you tell it to remember something; you can edit them here.
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-1 flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain px-1 py-1">
          {query.isPending ? <p className="text-sm text-muted-foreground">Loading memory…</p> : null}
          {query.isError ? <p role="alert" className="text-sm text-danger">{errorMessage(query.error)}</p> : null}
          {data ? (
            <div className="flex flex-col gap-1">
              <p data-slot="manager-memory-budget" className="text-xs text-muted-foreground">
                {data.entries.length} of {data.limits.entries} entries · {data.usedBytes} of {data.limits.bytes} bytes
              </p>
              <div className="h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, (data.usedBytes / data.limits.bytes) * 100)}%` }} />
              </div>
            </div>
          ) : null}
          {data && data.entries.length === 0 && !draft ? (
            <p className="text-sm text-muted-foreground">Nothing yet. Tell the manager “remember …”, or add an entry.</p>
          ) : null}
          <ul className="flex flex-col gap-2">
            {data?.entries.map((entry) => draft && !draft.isNew && draft.key === entry.key ? (
              <li key={entry.key}>
                <EntryForm draft={draft} onChange={setDraft} onCancel={() => setDraft(null)} onSave={save} saving={write.isPending} />
              </li>
            ) : (
              <li key={entry.key} data-slot="manager-memory-entry" className="flex items-start gap-2 rounded-md border p-2.5">
                <div className="flex min-w-0 flex-1 flex-col gap-1 wrap-anywhere">
                  <div className="flex min-w-0 items-center gap-2">
                    <Badge variant="secondary">{KIND_LABEL[entry.kind]}</Badge>
                    <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{entry.key}</span>
                  </div>
                  <p className="text-sm">{entry.text}</p>
                  {entry.why ? <p className="text-xs text-muted-foreground">Why: {entry.why}</p> : null}
                  <p className="text-xs text-muted-foreground">Saved by {SOURCE_LABEL[entry.source]}</p>
                </div>
                <Button
                  type="button" variant="ghost" size="icon" aria-label={`Edit ${entry.key}`}
                  onClick={() => setDraft({ key: entry.key, kind: entry.kind, text: entry.text, why: entry.why ?? '', isNew: false })}
                >
                  <PencilIcon aria-hidden="true" />
                </Button>
                <Button type="button" variant="ghost" size="icon" aria-label={`Delete ${entry.key}`} disabled={write.isPending} onClick={() => remove(entry.key)}>
                  <Trash2Icon aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
          {draft?.isNew ? (
            <EntryForm draft={draft} onChange={setDraft} onCancel={() => setDraft(null)} onSave={save} saving={write.isPending} taken={data?.entries.map((entry) => entry.key)} />
          ) : data && !draft ? (
            <Button type="button" variant="outline" size="sm" className="self-start" disabled={full} onClick={() => setDraft({ key: '', kind: 'preference', text: '', why: '', isNew: true })}>
              <PlusIcon aria-hidden="true" />
              Add
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
