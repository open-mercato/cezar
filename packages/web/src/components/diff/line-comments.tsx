import { MessageSquareOffIcon, PencilIcon, PlusIcon } from 'lucide-react'
import { createContext, useContext, useEffect, useRef, useState, type KeyboardEvent } from 'react'

import { Button } from '@/components/ui/button'
import { isSubmitShortcut } from '@/lib/use-submit-shortcut'
import { cn } from '@/lib/utils'

import { describeLines } from './line-label'
import type { HunkLine } from './parse-patch'
import {
  COMMENT_MAX,
  type DiffLineAnchor,
  type DiffLineComment,
  type DiffLineEnd,
  type DiffNewLineComment,
} from './types'

/**
 * Line comments inside the diff renderer — the self-review flow: hover a line, press "+", leave
 * a note for the agent. The renderer only DRAWS them; storage, identity and delivery belong to
 * the host (the Changes tab files them as a draft the thread composer sends with the next
 * message).
 *
 * Reached through context rather than threaded through the card → body → row chain: every row
 * needs it, and none of the layers in between does.
 */

/** A line's anchor, or `undefined` for a line that has no number on the side it lives on. */
export function anchorForLine(path: string, line: HunkLine): DiffLineAnchor | undefined {
  if (line.kind === 'del') return line.oldLine === undefined ? undefined : { path, side: 'old', line: line.oldLine }
  return line.newLine === undefined ? undefined : { path, side: 'new', line: line.newLine }
}

export function anchorKey(anchor: DiffLineAnchor): string {
  return `${anchor.side}:${anchor.line}\u0000${anchor.path}`
}

/**
 * What a drag (or shift-click) from row `a` to row `b` of one file comments on: anchored at the
 * LAST line (where the editor and the comment render), `start` at the first, and every covered
 * line's text as the excerpt. Rows are positions in the file's displayed line list, so a range
 * may cross removed and added lines. `undefined` when the last line has no number to anchor to.
 */
export function rangeTarget(
  path: string,
  lines: readonly HunkLine[],
  a: number,
  b: number,
): { anchor: DiffLineAnchor; start?: DiffLineEnd; excerpt: string } | undefined {
  const from = Math.max(0, Math.min(a, b))
  const to = Math.min(lines.length - 1, Math.max(a, b))
  const last = lines[to]
  const anchor = last ? anchorForLine(path, last) : undefined
  if (!anchor) return undefined
  const covered = lines.slice(from, to + 1)
  if (from === to) return { anchor, excerpt: last!.text }
  const first = anchorForLine(path, lines[from]!)
  return {
    anchor,
    ...(first ? { start: { side: first.side, line: first.line } } : {}),
    excerpt: excerptWithGaps(covered),
  }
}

/**
 * The covered lines' text, with a marker wherever the range crossed a COLLAPSED context gap: the
 * displayed list skips those lines, and an excerpt that read as continuous would tell the agent
 * "lines 10–80" while quietly quoting half of them.
 */
function excerptWithGaps(covered: readonly HunkLine[]): string {
  const out: string[] = []
  let lastOld: number | undefined
  let lastNew: number | undefined
  for (const line of covered) {
    const skipped =
      (line.newLine !== undefined && lastNew !== undefined && line.newLine > lastNew + 1) ||
      (line.oldLine !== undefined && lastOld !== undefined && line.oldLine > lastOld + 1)
    if (skipped) {
      const count =
        line.newLine !== undefined && lastNew !== undefined ? line.newLine - lastNew - 1
        : line.oldLine! - lastOld! - 1
      out.push(`⋯ ${count} unchanged ${count === 1 ? 'line' : 'lines'} not shown`)
    }
    out.push(line.text)
    if (line.oldLine !== undefined) lastOld = line.oldLine
    if (line.newLine !== undefined) lastNew = line.newLine
  }
  return out.join('\n')
}

/**
 * The file a row belongs to, provided by the file body: its displayed line list (hunks plus
 * expanded context, in order), each line's position in it, and how each position is marked.
 */
export interface FileLines {
  path: string
  lines: readonly HunkLine[]
  orderOf: ReadonlyMap<HunkLine, number>
  /** `selected` — inside the drag or the open editor's range; `commented` — under a saved comment. */
  markAt: (order: number) => 'selected' | 'commented' | undefined
}

export const FileLinesContext = createContext<FileLines | null>(null)

/** The row classes for a mark: a tint over the line for the live selection, a bar in the gutter
 *  edge for lines a saved comment covers — so commented code reads as commented at a glance. */
export function markClass(mark: 'selected' | 'commented' | undefined): string | undefined {
  if (mark === 'selected') return 'relative before:pointer-events-none before:absolute before:inset-0 before:bg-primary/15'
  if (mark === 'commented') return 'shadow-[inset_3px_0_0_0_var(--color-primary)]'
  return undefined
}

/** The one open editor (one at a time, like a review tool): a new comment, or a saved one being
 *  edited in place (`commentId` set). */
export interface LineCommentEditing {
  /** The `pendingText` slot — per new-comment anchor, or per edited comment. */
  key: string
  /** The row the editor hangs under (`anchorKey`). */
  threadKey: string
  anchor: DiffLineAnchor
  /** First line of a range; absent for one line. */
  start?: DiffLineEnd
  excerpt: string
  commentId?: string
  initial?: string
  oldPath?: string
}

/** A drag in progress: from where the "+" was pressed to the row under the pointer. */
export interface LineSelection {
  path: string
  from: number
  to: number
}

export interface LineCommentsApi {
  comments: readonly DiffLineComment[]
  byKey: ReadonlyMap<string, readonly DiffLineComment[]>
  editing: LineCommentEditing | null
  selection: LineSelection | null
  canAdd: boolean
  /** `stretch` — this re-opens the current new comment over a wider range; its text comes along. */
  open: (anchor: DiffLineAnchor, excerpt: string, start?: DiffLineEnd, stretch?: boolean) => void
  /** Press on a "+": start a range at that row. Releasing anywhere opens the editor for it. */
  beginSelect: (path: string, order: number, lines: readonly HunkLine[]) => void
  /** The pointer entered another row while a range is being dragged. */
  extendSelect: (path: string, order: number) => void
  /** Absent ⇒ saved comments are read-only. */
  edit?: (comment: DiffLineComment) => void
  cancel: () => void
  /** `false` ⇒ the host refused it; the editor stays open. */
  submit: (comment: DiffNewLineComment) => boolean
  update: (id: string, body: string) => boolean
  remove?: (id: string) => void
  /** Unsent editor text, kept OUTSIDE React state: virtualization can unmount the editor's row
   *  mid-sentence, and a keystroke must not re-render every row of the diff. */
  pendingText: Map<string, string>
  /** The editor key the user just OPENED. Consumed by that editor's first mount, so a row that
   *  virtualization re-mounts later does not steal focus or scroll the page. */
  focusRequest: { current: string | null }
}

export const LineCommentsContext = createContext<LineCommentsApi | null>(null)

export function useLineComments(): LineCommentsApi | null {
  return useContext(LineCommentsContext)
}

/** A device whose primary pointer cannot hover — a phone or tablet. Read at tap time, not at
 *  render: a hybrid laptop can switch between touch and trackpad without a re-render. */
function isTouchPrimary(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(hover: none)').matches
}

/**
 * Tap-to-comment: on a touch-primary device the hover "+" never shows, so tapping the line itself
 * opens its editor. Spread onto the row element. Inert on hover devices (the "+" is there), when
 * the host takes no comments, and when the tap ends a text selection — selecting code to copy it
 * must not pop an editor open.
 *
 * A plain function over the context value rather than a hook: rows return early for hunk and
 * gap rows, so the caller reads the context once, above those returns, and passes it in.
 */
export function tapToComment(api: LineCommentsApi | null, anchor: DiffLineAnchor | undefined, excerpt: string) {
  if (!api?.canAdd || anchor === undefined) return undefined
  return {
    onClick: (event: React.MouseEvent<HTMLElement>) => {
      if (!isTouchPrimary()) return
      if ((event.target as HTMLElement).closest('button, a, textarea, input')) return
      if ((window.getSelection?.()?.toString() ?? '') !== '') return
      api.open(anchor, excerpt)
    },
  }
}

/**
 * The hover "+" in a line's marker column. Press and drag across rows to comment on a RANGE
 * (releasing opens the editor under the last line); a plain click is a one-line range. With an
 * editor already open for a new comment in this file, shift-click stretches its range to here.
 * Keyboard activation (Enter/Space — a click with `detail === 0`) opens the one line.
 */
export function AddCommentButton({
  anchor,
  excerpt,
  line,
}: {
  anchor: DiffLineAnchor | undefined
  excerpt: string
  line: HunkLine
}) {
  const api = useLineComments()
  const file = useContext(FileLinesContext)
  if (!api?.canAdd || anchor === undefined) return null
  const order = file?.orderOf.get(line)
  const editing = api.editing
  const stretchable =
    editing !== null && editing.commentId === undefined && editing.anchor.path === anchor.path && file !== null
  return (
    <button
      type="button"
      data-slot="diff-add-comment"
      // The file is named: every file has a "line 4", and a list of controls that all read
      // "Comment on line 4" is no list at all to a screen reader.
      aria-label={`Comment on ${anchor.path.split('/').at(-1)} ${anchor.side === 'old' ? 'removed ' : ''}line ${anchor.line}`}
      title="Add a comment for the agent — drag to cover several lines, or shift-click to extend"
      onMouseDown={(event) => {
        if (event.button !== 0) return
        // No text selection while dragging across code.
        event.preventDefault()
        if (event.shiftKey && stretchable) return // the click stretches the open range
        if (file && order !== undefined) api.beginSelect(anchor.path, order, file.lines)
      }}
      onClick={(event) => {
        if (event.shiftKey && stretchable && order !== undefined && editing) {
          const startAt = editing.start ?? editing.anchor
          const fromOrder = orderOfEnd(file!, anchor.path, startAt) ?? order
          const target = rangeTarget(anchor.path, file!.lines, fromOrder, order)
          if (target) api.open(target.anchor, target.excerpt, target.start, true)
          return
        }
        // A pointer click was already handled by press → release (`beginSelect`); only keyboard
        // activation, which has no press, opens from here.
        if (event.detail === 0) api.open(anchor, excerpt)
      }}
      className={cn(
        // Inside the 1rem marker column it sits in — never over the line numbers beside it.
        'absolute top-1/2 left-0 z-[1] flex size-4 -translate-y-1/2 items-center justify-center rounded-sm',
        'bg-primary text-primary-foreground opacity-0 shadow-xs transition-opacity',
        'group-hover/line:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      <PlusIcon aria-hidden="true" className="size-2.5" strokeWidth={3} />
    </button>
  )
}

/** Where a range end sits in the file's displayed lines, if it is displayed at all. */
export function orderOfEnd(file: FileLines, path: string, end: DiffLineEnd): number | undefined {
  const key = anchorKey({ path, side: end.side, line: end.line })
  for (const [line, order] of file.orderOf) {
    const at = anchorForLine(path, line)
    if (at && anchorKey(at) === key) return order
  }
  return undefined
}

/**
 * Everything that hangs under one row: its saved comments, then the editor when it is open
 * there. `anchors` is one entry in unified mode and up to two (old + new cell) in split mode;
 * a split context row maps both cells to the same anchor, so keys are deduplicated.
 */
export function LineCommentThread({ anchors }: { anchors: readonly (DiffLineAnchor | undefined)[] }) {
  const api = useLineComments()
  const file = useContext(FileLinesContext)
  if (!api) return null
  const keys = [...new Set(anchors.filter((a): a is DiffLineAnchor => a !== undefined).map(anchorKey))]
  const comments = keys.flatMap((key) => api.byKey.get(key) ?? [])
  const editing = api.editing !== null && keys.includes(api.editing.threadKey) ? api.editing : null
  if (comments.length === 0 && editing === null) return null
  const editingId = editing?.commentId
  return (
    <div data-slot="diff-line-comments" className="border-y border-primary/25 bg-primary/5 py-2.5 font-sans">
      {/* Sticky + capped: in no-wrap mode the rows are as wide as the longest line, and the
          editor's buttons must not end up scrolled off to the right of it. */}
      <div className="sticky left-0 flex w-full max-w-2xl flex-col gap-2 px-3 md:pl-24">
        {comments.map((comment) =>
          // The comment being edited is swapped for its editor, in place.
          comment.id === editingId && editing ?
            <CommentEditor key={editing.key} editing={editing} api={api} />
          : (
            <SavedComment
              key={comment.id}
              comment={comment}
              outdated={isOutdated(comment, file)}
              onEdit={api.edit}
              onRemove={api.remove}
            />
          ),
        )}
        {editing && editingId === undefined ? <CommentEditor key={editing.key} editing={editing} api={api} /> : null}
      </div>
    </div>
  )
}

/**
 * Comments are anchored by line NUMBER, so once the agent edits the file the number can point at
 * different code. A comment knows the code it was left on (`excerpt`; for a range, its last line
 * is the anchor's): when the line now at the anchor reads differently, the comment is outdated.
 * Unknowable — no excerpt, a cut-off one, the line not displayed — counts as current.
 */
export function isOutdated(comment: DiffLineComment, file: FileLines | null): boolean {
  if (!file || !comment.excerpt || comment.excerpt.endsWith('…')) return false
  const key = anchorKey(comment)
  const now = file.lines.find((line) => {
    const at = anchorForLine(comment.path, line)
    return at !== undefined && anchorKey(at) === key
  })
  if (!now) return false
  const then = comment.excerpt.split('\n').at(-1) ?? ''
  return then.trimEnd() !== now.text.trimEnd()
}

function SavedComment({
  comment,
  outdated = false,
  onEdit,
  onRemove,
}: {
  comment: DiffLineComment
  outdated?: boolean
  onEdit?: (comment: DiffLineComment) => void
  onRemove?: (id: string) => void
}) {
  return (
    <div
      data-slot="diff-line-comment"
      data-comment-id={comment.id}
      // An accent border on a tinted band is what sets a drafted comment apart from the code
      // around it; the lines it covers carry the accent bar in their gutter edge.
      role="group"
      aria-label={`Comment on ${describeLines(comment, comment.start)}`}
      className="flex flex-col gap-1.5 rounded-md border border-primary/40 bg-card px-3 py-2.5 text-[13px] leading-normal shadow-sm transition-shadow duration-500 data-[flash=true]:ring-2 data-[flash=true]:ring-primary"
    >
      {outdated ? (
        // The line under this card is not the one the note was about: say so, and show the code it
        // WAS about, rather than letting the note read as if it were about what is here now.
        <div data-slot="diff-line-comment-outdated" className="flex flex-col gap-1">
          <p className="text-[11px] font-medium text-pending-strong">Outdated — the code here changed since this comment</p>
          <pre className="max-h-32 overflow-auto rounded-sm border border-border/60 bg-muted/40 px-2 py-1 font-mono text-[12px] whitespace-pre text-muted-foreground">
            {comment.excerpt}
          </pre>
        </div>
      ) : null}
      <p className="break-words whitespace-pre-wrap text-foreground">{comment.body}</p>
      {onEdit || onRemove ? (
        <div className="flex items-center justify-end gap-1.5">
          {onEdit ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => onEdit(comment)}>
              <PencilIcon aria-hidden="true" className="size-3.5" />
              Edit
            </Button>
          ) : null}
          {onRemove ? (
            <Button type="button" variant="outline" size="sm" onClick={() => onRemove(comment.id)}>
              <MessageSquareOffIcon aria-hidden="true" className="size-3.5" />
              Remove from chat
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function CommentEditor({
  editing,
  api,
}: {
  editing: NonNullable<LineCommentsApi['editing']>
  api: LineCommentsApi
}) {
  const [text, setText] = useState(() => api.pendingText.get(editing.key) ?? editing.initial ?? '')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || api.focusRequest.current !== editing.key) return
    api.focusRequest.current = null
    el.focus({ preventScroll: true })
    el.setSelectionRange(el.value.length, el.value.length)
    // Brought into view on an explicit open only — the Changes tab gives this editor
    // scroll margin for its floating dock, keeping the editor clear of the composer.
    // `?.`: not every DOM implementation has it.
    el.closest<HTMLElement>('[data-slot="diff-comment-editor"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [])

  const body = text.trim()
  const submit = () => {
    if (body === '') return
    const stored =
      editing.commentId !== undefined ?
        api.update(editing.commentId, body)
      : api.submit({
          ...editing.anchor,
          ...(editing.start ? { start: editing.start } : {}),
          ...(editing.oldPath ? { oldPath: editing.oldPath } : {}),
          excerpt: editing.excerpt,
          body,
        })
    if (stored) api.pendingText.delete(editing.key)
  }
  const cancel = () => {
    api.pendingText.delete(editing.key)
    api.cancel()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      cancel()
      return
    }
    if (
      isSubmitShortcut({
        key: event.key,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        repeat: event.repeat,
        isComposing: event.nativeEvent.isComposing,
      })
    ) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <div data-slot="diff-comment-editor" className="flex flex-col gap-2">
      {/* No visible "Commenting on lines…" caption: the covered rows are tinted right above, and
          the textarea's accessible name still says it. */}
      <textarea
        ref={ref}
        rows={3}
        maxLength={COMMENT_MAX}
        value={text}
        aria-label={`Comment on ${describeLines(editing.anchor, editing.start)}`}
        placeholder="Add a comment for the AI"
        onChange={(event) => {
          setText(event.target.value)
          api.pendingText.set(editing.key, event.target.value)
        }}
        onKeyDown={onKeyDown}
        className="block w-full resize-y rounded-md border border-ring/60 bg-background px-3 py-2 text-base leading-normal outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-[3px] focus:ring-ring/15 md:text-sm"
      />
      <div className="flex items-center justify-end gap-1.5">
        <Button type="button" variant="ghost" size="sm" onClick={cancel}>
          Cancel
        </Button>
        <Button type="button" size="sm" disabled={body === ''} onClick={submit}>
          {editing.commentId !== undefined ? 'Save' : 'Comment'} <span aria-hidden="true">↵</span>
        </Button>
      </div>
    </div>
  )
}
