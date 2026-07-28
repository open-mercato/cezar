import { useRef, useState } from 'react'

import { cn } from '@/lib/utils'

/**
 * The ONE inline-rename state machine (#389, spec step 15). Two surfaces flip a title into an
 * input — the run header's h1 and the Tasks table's Task cell — and their semantics must never
 * drift: Enter/blur commit once, Escape abandons, a trimmed-empty or unchanged draft is not
 * worth a request. The markup differs per surface (an h1 is not a table cell), so this module
 * carries the machine and the input; each surface keeps its own resting presentation.
 */
export interface TitleEditor {
  editing: boolean
  draft: string
  setDraft: (value: string) => void
  begin: () => void
  commit: () => void
  cancel: () => void
}

export function useTitleEditor(title: string, onCommit: (next: string) => void): TitleEditor {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  // Enter both commits AND blurs in sequence — the ref makes whichever fires second a no-op,
  // so one edit can never become two PATCHes.
  const committed = useRef(false)

  const begin = () => {
    setDraft(title)
    committed.current = false
    setEditing(true)
  }
  const commit = () => {
    if (committed.current) return
    committed.current = true
    setEditing(false)
    const next = draft.trim()
    if (next.length === 0 || next === title) return // nothing to say to the server
    onCommit(next)
  }
  const cancel = () => {
    committed.current = true
    setEditing(false)
  }

  return { editing, draft, setDraft, begin, commit, cancel }
}

/** The in-place input, wired to the machine: Enter commits, Escape abandons, blur commits.
 *  Sizing/typography come from the surface via `className`; the chrome is shared. */
export function TitleEditInput({ editor, className }: { editor: TitleEditor; className?: string }) {
  return (
    <input
      data-slot="title-input"
      aria-label="Task title"
      // eslint-disable-next-line jsx-a11y/no-autofocus — the user just asked to edit this field
      autoFocus
      value={editor.draft}
      onChange={(event) => editor.setDraft(event.target.value)}
      onBlur={editor.commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          editor.commit()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          editor.cancel()
        }
      }}
      className={cn(
        'w-full min-w-0 rounded-sm border border-border bg-card px-1.5 py-0.5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
        className
      )}
    />
  )
}
