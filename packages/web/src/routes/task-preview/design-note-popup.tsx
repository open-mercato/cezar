import { MessageSquareIcon, SendIcon, Trash2Icon, XIcon } from 'lucide-react'

import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'

import { pickLabel } from './design-picks'
import type { DesignNote, DesignNotes, NotePhase } from './design-notes'

/**
 * The note about one element of the app — the popup the Preview tab shows under its frame
 * (spec `.ai/specs/2026-10-09-design-mode.md` §7).
 *
 * Two faces of one small window, picked by where the note is in its life:
 *  - a DRAFT: a field and Add note. Before it is added, closing it (✕ / Esc) throws it away and
 *    deselects the element. Once added, ✕ / Esc only close it — removing it takes Delete.
 *    `DesignNotesTray` sends them all.
 *  - WITH THE AGENT (in progress, asking, done): read-only. Closing only hides it.
 */

const STATUS: Record<Exclude<NotePhase, 'draft'>, { label: string; tone: 'neutral' | 'pending' | 'success' | 'violet'; pulse?: boolean }> = {
  running: { label: 'In progress', tone: 'pending', pulse: true },
  asking: { label: 'Agent is waiting for your answer', tone: 'violet' },
  done: { label: 'Done', tone: 'success' },
}

export function DesignNotePopup({
  note,
  notes,
  onClose,
}: {
  note: DesignNote
  notes: Pick<DesignNotes, 'setText' | 'markAdded' | 'discard'>
  /** Hide the popup. For a draft the host has already been told to discard it. */
  onClose: () => void
}) {
  const isDraft = note.phase === 'draft'
  const empty = note.text.trim() === ''
  // Only a note never added is thrown away by ✕ / Esc — an added one is removed deliberately.
  const throwaway = isDraft && !note.added

  const dismiss = () => {
    if (throwaway) notes.discard(note.key)
    onClose()
  }

  const remove = () => {
    notes.discard(note.key)
    onClose()
  }

  const add = () => {
    if (note.added) return onClose()
    if (empty) return
    notes.markAdded(note.key)
    onClose()
  }

  const status = isDraft ? null : STATUS[note.phase as Exclude<NotePhase, 'draft'>]

  return (
    <div data-slot="design-note" data-phase={note.phase} className="flex flex-col gap-2 p-2.5 text-xs">
      <div className="flex items-center gap-1.5">
        {note.number !== undefined ? (
          // The twin of the badge on the element's frame in the page: comment glyph, number.
          <span
            data-slot="design-note-number"
            aria-label={`Note ${note.number}`}
            className="flex h-[21px] shrink-0 items-center gap-1 rounded-md bg-primary pr-[7px] pl-1.5 text-xs leading-none font-bold text-primary-foreground"
          >
            <MessageSquareIcon aria-hidden="true" className="size-3" strokeWidth={2.5} />
            {note.number}
          </span>
        ) : null}
        <span data-slot="design-note-element" className="min-w-0 flex-1 truncate font-mono text-[11px] font-medium text-foreground" title={note.pick.selector}>
          {pickLabel(note.pick)}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-6"
          aria-label={throwaway ? 'Discard note' : 'Close'}
          title={throwaway ? 'Discard this note and deselect the element (Esc)' : 'Close (Esc)'}
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

      {isDraft ? (
        <Textarea
          value={note.text}
          onChange={(event) => notes.setText(note.key, event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              dismiss()
            } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              add()
            }
          }}
          placeholder="What should change here?"
          // A batch on its way carries this text; an edit now would be lost to it.
          readOnly={note.sending === true}
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
        <div className="flex items-center justify-between gap-2">
          {note.added ? (
            <Button type="button" variant="ghost" size="sm" className="text-soft-foreground hover:text-danger" disabled={note.sending === true} onClick={remove}>
              <Trash2Icon aria-hidden="true" />
              Delete
            </Button>
          ) : (
            <span />
          )}
          <Button type="button" size="sm" disabled={!note.added && empty} title={note.added ? 'Done (Ctrl/⌘+Enter)' : 'Add note (Ctrl/⌘+Enter)'} onClick={add}>
            {note.added ? 'Done' : 'Add note'}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

/**
 * The batch's send button (2026-10-24): notes are collected like line comments on the Changes tab
 * and go to the agent together, as one message, when the user says so.
 */
export function DesignNotesTray({ notes }: { notes: Pick<DesignNotes, 'ready' | 'sending' | 'sendAll'> }) {
  // `sending` lives in the notes' store, so a tray remounted mid-send still knows it is busy.
  const busy = notes.sending
  if (notes.ready === 0 && !busy) return null

  const send = async () => {
    if (busy) return
    try {
      await notes.sendAll()
    } catch (error) {
      toast(error instanceof Error && error.message ? error.message : 'Could not send the notes.', { tone: 'danger' })
    }
  }

  return (
    <div
      data-slot="design-notes-tray"
      className="flex items-center gap-2 rounded-xl border border-border bg-background/95 py-1.5 pr-1.5 pl-3 text-xs shadow-lg"
    >
      <MessageSquareIcon aria-hidden="true" className="size-3.5 text-soft-foreground" />
      <span className="text-foreground">
        {notes.ready} {notes.ready === 1 ? 'note' : 'notes'}
      </span>
      <Button type="button" size="sm" disabled={busy} onClick={() => void send()}>
        <SendIcon aria-hidden="true" />
        {busy ? 'Sending…' : 'Send to agent'}
      </Button>
    </div>
  )
}
