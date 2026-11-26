import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'

import { parseMarkRects, placeNote, type MarkRect } from '../task-preview/browser-view'
import { DesignNotePopup } from '../task-preview/design-note-popup'
import type { NotePick } from '../task-preview/design-notes'
import { parseDesignPick } from '../task-preview/design-picks'
import type { AssetComment, DiffComments } from '../task-thread/diff-comments'

/**
 * Comment mode on an HTML asset: click an element of the page, write a comment, and it joins the
 * run's review comments (`useDiffComments`) — chips in the composers, one review message to the
 * agent. The page runs the Design Mode picker (`?picker=1` on the artifact URL) and speaks its
 * protocol; the frame stays sandboxed and opaque, so messages go to it with `'*'` (an opaque
 * origin cannot be named) and carry only selectors and numbers, never a comment's text.
 */

/** What the frame is asked for so it runs the picker. */
export function withPicker(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}picker=1`
}

/** A saved comment as the popup's pick: the popup reads only the selector and the element's tag. */
export function pickOfComment(comment: AssetComment, mark: string): NotePick {
  const tail = comment.selector.split(' > ').at(-1) ?? comment.selector
  return {
    url: '',
    selector: comment.selector,
    tag: /^[a-z][a-z0-9-]*/i.exec(tail)?.[0] ?? tail,
    text: comment.label,
    html: comment.excerpt,
    styles: {},
    rect: { x: 0, y: 0, width: 0, height: 0 },
    viewport: { width: 0, height: 0 },
    components: [],
    source: '',
    mark,
  }
}

interface Editing {
  /** The element's picker key in THIS document. */
  key: string
  pick: NotePick
  /** Absent for a new comment not saved yet. */
  commentId?: string
}

export function AssetCommentsLayer({
  frameRef,
  frameKey,
  asset,
  store,
  active,
  onActiveChange,
}: {
  frameRef: RefObject<HTMLIFrameElement | null>
  /** Changes whenever the frame loads a new document — a new picker knows nothing yet. */
  frameKey: string
  asset: string
  store: Pick<DiffComments, 'assetComments' | 'addAsset' | 'update' | 'remove' | 'ready'>
  active: boolean
  onActiveChange: (active: boolean) => void
}) {
  const comments = useMemo(() => store.assetComments.filter((c) => c.asset === asset), [asset, store.assetComments])
  const [ready, setReady] = useState(false)
  const [rects, setRects] = useState<Record<string, MarkRect>>({})
  const [editing, setEditing] = useState<Editing | null>(null)
  const [text, setText] = useState('')
  /** A comment saved in this document keeps the picker key its element was framed under. */
  const aliases = useRef(new Map<string, string>())
  const removed = useRef(false)

  useEffect(() => {
    setReady(false)
    setRects({})
    setEditing(null)
    aliases.current.clear()
  }, [frameKey])

  const markOf = useCallback((comment: AssetComment) => aliases.current.get(comment.id) ?? comment.id, [])

  const post = useCallback(
    (message: Record<string, unknown>) => {
      frameRef.current?.contentWindow?.postMessage({ source: 'cezar-design-host', ...message }, '*')
    },
    [frameRef],
  )

  // Every saved comment is framed and numbered in the page (found again by its selector after a
  // reload); a new one being written is framed without a number.
  const marks = useMemo(() => {
    const saved = comments.map((comment, index) => ({ key: markOf(comment), n: index + 1, selector: comment.selector }))
    return editing && editing.commentId === undefined ? [...saved, { key: editing.key }] : saved
  }, [comments, editing, markOf])
  const marksKey = JSON.stringify(marks)
  const sendMarks = useCallback(() => post({ type: 'set-marks', marks: JSON.parse(marksKey) as unknown }), [marksKey, post])

  useEffect(() => {
    if (ready) post({ type: 'set-active', active })
  }, [active, post, ready])
  useEffect(() => {
    if (ready) sendMarks()
  }, [ready, sendMarks])

  // Read fresh by the listener below.
  const state = useRef({ comments, editing, active })
  state.current = { comments, editing, active }

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // THIS frame only. Its origin is opaque, so the window is the check.
      if (event.source === null || event.source !== frameRef.current?.contentWindow) return
      const data = event.data as { source?: unknown; type?: unknown; element?: unknown; key?: unknown; rects?: unknown } | null
      if (data === null || typeof data !== 'object' || data.source !== 'cezar-design') return
      const now = state.current
      if (data.type === 'ready') {
        aliases.current.clear()
        setReady(true)
      } else if (data.type === 'rects') {
        setRects(parseMarkRects(data.rects))
      } else if (data.type === 'toggle') {
        onActiveChange(false)
      } else if (data.type === 'cancel') {
        // Esc in the page: closes the open comment, else leaves comment mode.
        if (now.editing) setEditing(null)
        else onActiveChange(false)
      } else if (data.type === 'picked') {
        const pick = parseDesignPick(data.element)
        if (!pick?.mark || !now.active) {
          sendMarks()
          return
        }
        const mark = pick.mark
        setRects((known) => ({ ...known, [mark]: pick.rect }))
        setEditing({ key: mark, pick: { ...pick, mark } })
        setText('')
      } else if (data.type === 'mark-clicked' && typeof data.key === 'string') {
        const key = data.key
        const comment = now.comments.find((c) => markOf(c) === key)
        if (!comment) return
        removed.current = false
        setEditing({ key, pick: pickOfComment(comment, key), commentId: comment.id })
        setText(comment.body)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [frameRef, markOf, onActiveChange, sendMarks])

  /** Close the open popup. An edit to a saved comment is kept — the popup edits it in place; a
   *  draft never added is dropped (its frame goes with it). */
  const closeEditing = useCallback(() => {
    const saved = editing?.commentId ? comments.find((c) => c.id === editing.commentId) : undefined
    if (saved && !removed.current && text.trim() !== '' && text.trim() !== saved.body) store.update(saved.id, text.trim())
    setEditing(null)
  }, [comments, editing, store, text])

  // Esc wherever the keyboard is in the cockpit (the toolbar button, the popup once its field
  // let go of focus): the first closes the open popup, the next leaves comment mode. A key the
  // popup's field or another overlay already handled arrives `defaultPrevented` and is left alone.
  // Esc pressed INSIDE the page reaches us as the picker's `cancel` instead.
  const latestClose = useRef(closeEditing)
  latestClose.current = closeEditing
  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
      event.preventDefault()
      if (state.current.editing) latestClose.current()
      else onActiveChange(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, onActiveChange])

  // The comment being edited was removed elsewhere (a chip's ✕, a send): nothing left to show.
  useEffect(() => {
    if (editing?.commentId !== undefined && !comments.some((c) => c.id === editing.commentId)) setEditing(null)
  }, [comments, editing])

  const areaRef = useRef<HTMLDivElement>(null)
  const noteRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const anchorRect = editing ? rects[editing.key] : undefined
  useLayoutEffect(() => {
    if (!editing) return setPosition(null)
    const area = areaRef.current?.parentElement
    const note = noteRef.current
    if (!area || !note) return
    setPosition(placeNote(anchorRect, { width: area.clientWidth, height: area.clientHeight }, { width: note.offsetWidth, height: note.offsetHeight }))
  }, [anchorRect, editing])
  // The click that opened it happened inside the frame; once placed, the cursor goes to the field.
  const placed = position !== null
  const editingKey = editing?.key
  useEffect(() => {
    if (placed && editingKey) noteRef.current?.querySelector<HTMLElement>('textarea')?.focus()
  }, [editingKey, placed])

  if (!editing) return <div ref={areaRef} hidden />

  const number = editing.commentId ? comments.findIndex((c) => c.id === editing.commentId) + 1 : 0
  const close = closeEditing

  return (
    <div ref={areaRef}>
      <div
        ref={noteRef}
        data-slot="asset-comment-popup"
        role="dialog"
        aria-label="Comment on this element"
        className="absolute z-20 w-[min(360px,calc(100%-16px))] rounded-xl border border-border bg-background shadow-lg"
        style={position ? { left: position.left, top: position.top } : { visibility: 'hidden', left: 0, top: 0 }}
      >
        <DesignNotePopup
          noun="comment"
          note={{
            key: editing.key,
            pick: editing.pick,
            text,
            phase: 'draft',
            added: editing.commentId !== undefined,
            ...(number > 0 ? { number } : {}),
          }}
          notes={{
            setText: (_key, next) => setText(next),
            markAdded: () => {
              const body = text.trim()
              if (body === '') return
              const id = store.addAsset({
                asset,
                selector: editing.pick.selector,
                label: editing.pick.text,
                excerpt: editing.pick.html,
                body,
              })
              if (id) aliases.current.set(id, editing.key)
            },
            discard: () => {
              if (editing.commentId) {
                removed.current = true
                store.remove(editing.commentId)
              }
            },
          }}
          onClose={close}
        />
      </div>
    </div>
  )
}
