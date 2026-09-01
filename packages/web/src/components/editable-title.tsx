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
  /** Open on something other than the current title — the task thread re-opens a half-typed
   *  rename restored from the draft store (#939). Deliberately NOT an optional argument to
   *  `begin`: `begin` is wired straight to an `onClick` on both surfaces, and an overload would
   *  quietly seed the editor with a MouseEvent. */
  beginWith: (initial: string) => void
  /**
   * Whether blur should commit — false for an editor that opened ITSELF from a restored draft
   * and has not been touched since (#939, #940 review).
   *
   * Blur-commit is right for an editor the user opened: they clicked the pencil, they typed,
   * clicking away means "yes". It is wrong for one that reappeared on its own an hour later —
   * the first stray click anywhere in the thread would silently apply a rename they walked away
   * from. So a restored editor waits: it holds the text, and the moment the user types in it (or
   * presses Enter) it behaves like any other rename.
   */
  commitOnBlur: boolean
  commit: () => void
  cancel: () => void
}

export function useTitleEditor(title: string, onCommit: (next: string) => void): TitleEditor {
  const [editing, setEditing] = useState(false)
  const [draft, setDraftValue] = useState('')
  // Enter both commits AND blurs in sequence — the ref makes whichever fires second a no-op,
  // so one edit can never become two PATCHes.
  const committed = useRef(false)
  // See `commitOnBlur` above: only an editor the user opened, or has typed in, commits on blur.
  const [commitOnBlur, setCommitOnBlur] = useState(true)

  const setDraft = (value: string) => {
    setDraftValue(value)
    setCommitOnBlur(true)
  }
  const beginWith = (initial: string) => {
    setDraftValue(initial)
    setCommitOnBlur(false)
    committed.current = false
    setEditing(true)
  }
  const begin = () => {
    beginWith(title)
    setCommitOnBlur(true)
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

  return { editing, draft, setDraft, begin, beginWith, commitOnBlur, commit, cancel }
}

/** The in-place input, wired to the machine: Enter commits, Escape abandons, blur commits —
 *  except for an untouched editor restored from a draft (`commitOnBlur`).
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
      onBlur={() => {
        if (editor.commitOnBlur) editor.commit()
      }}
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
