import { XIcon } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { ApiRun } from '@open-mercato/cezar-api-client'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'

import { pickLabel } from '../task-thread/design-picks'
import type { DesignNote, DesignNotes, NotePhase } from './design-notes'

/**
 * The note about one element of the app — the popup the Browser column shows under its frame
 * (spec `.ai/specs/2026-10-09-design-mode.md` §7).
 *
 * Three faces of one small window, picked by where the note is in its life:
 *  - a DRAFT: a field and Send. Closing it (✕ / Esc) throws the draft away and deselects the
 *    element — clicking another element instead keeps it, and that is how drafts are kept.
 *  - WAITING in the prompt queue: still the user's to reword or take back.
 *  - WITH THE AGENT (in progress, asking, done): read-only. Closing only hides it.
 */

const STATUS: Record<Exclude<NotePhase, 'draft'>, { label: string; tone: 'neutral' | 'pending' | 'success' | 'violet'; pulse?: boolean }> = {
  queued: { label: 'In queue', tone: 'neutral' },
  running: { label: 'In progress', tone: 'pending', pulse: true },
  asking: { label: 'Agent is waiting for your answer', tone: 'violet' },
  done: { label: 'Done', tone: 'success' },
}

/** What Send will do, which depends on what the session is doing right now. */
function sendPlan(status: ApiRun['status']): { action: string; hint: string } {
  if (status === 'running') return { action: 'Send', hint: 'The agent is working — this waits its turn and runs next.' }
  if (status === 'waiting') return { action: 'Send', hint: 'The agent is free — this starts right away.' }
  if (status === 'queued') return { action: 'Send', hint: 'This task has not started — the note joins its first prompt.' }
  return { action: 'Reopen & send', hint: 'The session is closed — this reopens it with the note.' }
}

export function DesignNotePopup({
  note,
  run,
  notes,
  onClose,
}: {
  note: DesignNote
  run: ApiRun
  notes: Pick<DesignNotes, 'setText' | 'discard' | 'send' | 'saveQueued' | 'withdraw'>
  /** Hide the popup. For a draft the host has already been told to discard it. */
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const isDraft = note.phase === 'draft'
  const isQueued = note.phase === 'queued'
  // A waiting note is edited as a copy and SAVED, so a half-typed rewording is never what the
  // agent receives if its turn comes mid-sentence.
  const [edit, setEdit] = useState(note.text)
  useEffect(() => setEdit(note.text), [note.key, note.text])

  const attempt = async (action: () => Promise<void>, fallback: string): Promise<boolean> => {
    setBusy(true)
    try {
      await action()
      return true
    } catch (error) {
      toast(error instanceof Error && error.message ? error.message : fallback, { tone: 'danger' })
      return false
    } finally {
      setBusy(false)
    }
  }

  /** ✕ and Esc: a draft is thrown away with its element's frame; anything sent is only hidden. */
  const dismiss = () => {
    if (isDraft) notes.discard(note.key)
    onClose()
  }

  const send = async () => {
    if (note.text.trim() === '' || busy) return
    // On success the frame stays, numbered; the window has done its job.
    if (await attempt(() => notes.send(note.key), 'Could not send the note.')) onClose()
  }

  const plan = sendPlan(run.status)
  const status = isDraft ? null : STATUS[note.phase as Exclude<NotePhase, 'draft'>]
  const text = isDraft ? note.text : edit

  return (
    <div data-slot="design-note" data-phase={note.phase} className="flex flex-col gap-2 p-2.5 text-xs">
      <div className="flex items-center gap-1.5">
        {note.number !== undefined ? (
          <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-primary px-1 text-[11px] font-bold text-primary-foreground">
            {note.number}
          </span>
        ) : null}
        <span data-slot="design-note-element" className="min-w-0 flex-1 truncate font-mono text-[11px] font-medium text-foreground" title={note.pick.selector}>
          {pickLabel(note.pick)}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={isDraft ? 'Discard note' : 'Close'}
          title={isDraft ? 'Discard this note and deselect the element (Esc)' : 'Close (Esc)'}
          onClick={dismiss}
        >
          <XIcon aria-hidden="true" />
        </Button>
      </div>

      {status ? (
        <p data-slot="design-note-status" className="flex items-center gap-1.5 text-soft-foreground">
          <StatusDot tone={status.tone} pulse={status.pulse ?? false} />
          {status.label}
        </p>
      ) : null}

      {isDraft || isQueued ? (
        <Textarea
          value={text}
          onChange={(event) => (isDraft ? notes.setText(note.key, event.target.value) : setEdit(event.target.value))}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              dismiss()
            } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              if (isDraft) void send()
              else if (edit.trim() !== '' && edit.trim() !== note.text) void attempt(() => notes.saveQueued(note.key, edit), 'Could not save the note.')
            }
          }}
          placeholder="What should change here?"
          aria-label="Note for the agent"
          // The window appears because the user just pointed at something to talk about.
          autoFocus
          rows={3}
          className="min-h-16 resize-none text-[13px] md:text-[13px]"
        />
      ) : (
        <p data-slot="design-note-text" className="max-h-40 overflow-y-auto rounded-md border border-border bg-muted/40 px-2 py-1.5 text-[13px] break-words whitespace-pre-wrap text-foreground">
          {note.text}
        </p>
      )}

      {isDraft ? (
        <div className="flex items-center gap-2">
          <p data-slot="design-note-hint" className="min-w-0 flex-1 text-soft-foreground">
            {plan.hint}
          </p>
          <Button type="button" size="sm" disabled={busy || note.text.trim() === ''} onClick={() => void send()}>
            {plan.action}
          </Button>
        </div>
      ) : isQueued ? (
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="danger-ghost"
            size="sm"
            disabled={busy}
            onClick={() =>
              void attempt(() => notes.withdraw(note.key), 'Could not remove the note.').then((removed) => {
                if (removed) onClose()
              })
            }
          >
            Remove from queue
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={busy || edit.trim() === '' || edit.trim() === note.text}
            onClick={() => void attempt(() => notes.saveQueued(note.key, edit), 'Could not save the note.')}
          >
            Save
          </Button>
        </div>
      ) : null}
    </div>
  )
}
