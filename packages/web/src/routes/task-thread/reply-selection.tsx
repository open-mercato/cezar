import { ArrowUpIcon, MessageSquarePlusIcon, ReplyIcon } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'

import { Kbd } from '@/components/kbd'
import { isApplePlatform } from '@/lib/keybindings'
import { cn } from '@/lib/utils'

import { trimBlankEdges } from './diff-comments'

/**
 * Text selected in the agent's replies gets a small toolbar (the screenshot in task 26a7603d):
 * **Add to chat** puts the passage in the composer as a quote chip; **Reply** opens a comment box
 * under the quote first. Either rides the next message like a diff comment does (`addQuote`).
 *
 * One listener set per thread, not per message: the toolbar follows the document selection and
 * only answers when BOTH ends of it sit in assistant messages of this run's thread.
 */

const REPLY_SLOT = '[data-slot="assistant-message"]'
/** How long a touch selection must stay unchanged before the toolbar reads it. */
export const SETTLE_MS = 250

interface Anchor {
  text: string
  rect: { top: number; bottom: number; left: number; width: number }
}

function elementOf(node: Node | null): Element | null {
  if (!node) return null
  return node instanceof Element ? node : node.parentElement
}

/**
 * The range pulled back to the last character it really selects. A triple-click selects a whole
 * paragraph by ending at the START of whatever follows it — the next block's text, or an empty
 * element — and for a reply's last paragraph that is outside the reply, which failed the end check.
 */
export function selectedExtent(range: Range): Range {
  const root = range.commonAncestorContainer
  if (root.nodeType === Node.TEXT_NODE) return range
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let last: Node | null = null
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!range.intersectsNode(node)) continue
    const text = node.textContent ?? ''
    const from = node === range.startContainer ? range.startOffset : 0
    const to = node === range.endContainer ? range.endOffset : text.length
    if (text.slice(from, to).trim() !== '') last = node
  }
  if (!last || last === range.endContainer) return range
  const trimmed = range.cloneRange()
  trimmed.setEnd(last, (last.textContent ?? '').length)
  return trimmed
}

/** The selected text when the whole selection lies in this run's assistant replies, else undefined. */
export function replySelectionText(selection: Selection | null, runId: string): string | undefined {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return undefined
  const range = selectedExtent(selection.getRangeAt(0))
  const start = elementOf(range.startContainer)?.closest(REPLY_SLOT)
  const end = elementOf(range.endContainer)?.closest(REPLY_SLOT)
  if (!start || !end) return undefined
  const thread = start.closest('[data-route="task-thread"]')
  if (!thread || thread.getAttribute('data-run-id') !== runId || !thread.contains(end)) return undefined
  const text = trimBlankEdges(selection.toString())
  return text.trim() === '' ? undefined : text
}

function rectOf(range: Range): Anchor['rect'] | undefined {
  const rect = range.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return undefined
  return { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width }
}

export function ReplySelection({
  runId,
  onAddToChat,
  onComment,
  canComment,
}: {
  runId: string
  /** Attach the passage to the next message as a quote chip. */
  onAddToChat: (excerpt: string) => void
  /** Keep a comment on the passage; `false` when it could not be kept (the box stays open). */
  onComment: (comment: { excerpt: string; body: string }) => boolean
  /** The comment list has loaded — until then both actions are off, like the diff's "+". */
  canComment: boolean
}) {
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const [mode, setMode] = useState<'toolbar' | 'reply'>('toolbar')
  const [body, setBody] = useState('')
  const range = useRef<Range | null>(null)
  const surface = useRef<HTMLDivElement | null>(null)
  const modeRef = useRef(mode)
  modeRef.current = mode
  const bodyRef = useRef(body)
  bodyRef.current = body

  const close = useCallback(() => {
    range.current = null
    setAnchor(null)
    setMode('toolbar')
    setBody('')
  }, [])

  const read = useCallback(() => {
    if (modeRef.current === 'reply') return
    const selection = window.getSelection()
    const text = replySelectionText(selection, runId)
    const picked = text !== undefined && selection ? selectedExtent(selection.getRangeAt(0)).cloneRange() : undefined
    const rect = picked ? rectOf(picked) : undefined
    if (text === undefined || !picked || !rect) {
      if (range.current) close()
      return
    }
    range.current = picked
    setAnchor({ text, rect })
  }, [close, runId])

  useEffect(() => {
    // Read once the gesture ends, not on every `selectionchange` of a drag; a selection that
    // collapses (a click elsewhere, typing) hides the toolbar straight away. A touch selection is
    // adjusted with the OS's handles, which fire no pointer events — there the toolbar follows the
    // selection once it has settled.
    let touch = false
    let settle: number | undefined
    const onPointerUp = (event: PointerEvent) => {
      if (surface.current?.contains(event.target as Node)) return
      window.setTimeout(read, 0)
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.shiftKey || event.key === 'Shift') read()
    }
    const onSelectionChange = () => {
      const collapsed = window.getSelection()?.isCollapsed !== false
      if (modeRef.current === 'toolbar' && range.current && collapsed) close()
      if (!touch) return
      window.clearTimeout(settle)
      if (!collapsed) settle = window.setTimeout(read, SETTLE_MS)
    }
    const onPointerDown = (event: PointerEvent) => {
      touch = event.pointerType === 'touch'
      if (modeRef.current !== 'reply' || surface.current?.contains(event.target as Node)) return
      // A typed comment is never thrown away by a stray click — Escape or ✕ discard it.
      if (bodyRef.current.trim() === '') close()
    }
    document.addEventListener('pointerup', onPointerUp)
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keyup', onKeyUp)
    document.addEventListener('selectionchange', onSelectionChange)
    return () => {
      document.removeEventListener('pointerup', onPointerUp)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keyup', onKeyUp)
      document.removeEventListener('selectionchange', onSelectionChange)
      window.clearTimeout(settle)
    }
  }, [close, read])

  // The surfaces are `fixed`: follow the passage as the thread scrolls or the window resizes.
  const open = anchor !== null
  useEffect(() => {
    if (!open) return
    const follow = () => {
      const rect = range.current ? rectOf(range.current) : undefined
      if (rect) return setAnchor((current) => (current ? { ...current, rect } : current))
      // The passage's row left the page (a long thread unmounts far rows). The toolbar goes; an
      // open Reply box stays where it was, so a comment being typed is never thrown away.
      if (modeRef.current === 'toolbar') close()
    }
    window.addEventListener('scroll', follow, true)
    window.addEventListener('resize', follow)
    return () => {
      window.removeEventListener('scroll', follow, true)
      window.removeEventListener('resize', follow)
    }
  }, [open, close])

  const addToChat = useCallback(() => {
    if (!anchor) return
    onAddToChat(anchor.text)
    window.getSelection()?.removeAllRanges()
    close()
  }, [anchor, close, onAddToChat])

  // ⌘L / Ctrl+L, only while the toolbar is up — the browser keeps it the rest of the time.
  useEffect(() => {
    if (!anchor || mode !== 'toolbar') return
    const apple = isApplePlatform()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') return close()
      const mod = apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
      if (canComment && mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'l') {
        event.preventDefault()
        addToChat()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [anchor, mode, addToChat, canComment, close])

  if (!anchor) return null
  return createPortal(
    mode === 'toolbar' ?
      <SelectionToolbar
        surface={surface}
        rect={anchor.rect}
        canComment={canComment}
        onAddToChat={addToChat}
        onReply={() => setMode('reply')}
      />
    : <ReplyBox
        surface={surface}
        rect={anchor.rect}
        excerpt={anchor.text}
        body={body}
        onBodyChange={setBody}
        onCancel={close}
        onSubmit={() => {
          if (body.trim() === '') return
          if (onComment({ excerpt: anchor.text, body: body.trim() })) {
            window.getSelection()?.removeAllRanges()
            close()
          }
        }}
      />,
    document.body,
  )
}

const MARGIN = 8

function SelectionToolbar({
  surface,
  rect,
  canComment,
  onAddToChat,
  onReply,
}: {
  surface: RefObject<HTMLDivElement | null>
  rect: Anchor['rect']
  canComment: boolean
  onAddToChat: () => void
  onReply: () => void
}) {
  const apple = isApplePlatform()
  // Above the passage; below it when there is no room above.
  const above = rect.top > 56
  const center = Math.min(Math.max(rect.left + rect.width / 2, 130), window.innerWidth - 130)
  const style = above ?
      { top: rect.top - MARGIN, left: center, transform: 'translate(-50%, -100%)' }
    : { top: rect.bottom + MARGIN, left: center, transform: 'translateX(-50%)' }
  const button =
    'flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-foreground hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50'
  return (
    <div
      ref={surface}
      role="toolbar"
      aria-label="Selected text"
      data-slot="reply-selection-toolbar"
      style={style}
      // Keep the selection: a mousedown on a button would otherwise collapse it before the click.
      onMouseDown={(event) => event.preventDefault()}
      className="fixed z-50 flex items-center gap-0.5 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
    >
      <button type="button" className={button} onClick={onAddToChat} disabled={!canComment}>
        <MessageSquarePlusIcon aria-hidden="true" className="size-4 text-muted-foreground" />
        Add to chat
        <Kbd className="ml-0.5">{apple ? '⌘L' : 'Ctrl+L'}</Kbd>
      </button>
      <button type="button" className={button} onClick={onReply} disabled={!canComment}>
        <ReplyIcon aria-hidden="true" className="size-4 text-muted-foreground" />
        Reply
      </button>
    </div>
  )
}

function ReplyBox({
  surface,
  rect,
  excerpt,
  body,
  onBodyChange,
  onCancel,
  onSubmit,
}: {
  surface: RefObject<HTMLDivElement | null>
  rect: Anchor['rect']
  excerpt: string
  body: string
  onBodyChange: (body: string) => void
  onCancel: () => void
  onSubmit: () => void
}) {
  const input = useRef<HTMLTextAreaElement | null>(null)
  useLayoutEffect(() => input.current?.focus(), [])
  const width = Math.min(380, window.innerWidth - MARGIN * 2)
  const left = Math.min(Math.max(rect.left, MARGIN), window.innerWidth - width - MARGIN)
  const above = rect.top > 190
  const style = above ?
      { top: rect.top - MARGIN, left, width, transform: 'translateY(-100%)' }
    : { top: rect.bottom + MARGIN, left, width }
  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
    } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      onSubmit()
    }
  }
  return (
    <div
      ref={surface}
      role="dialog"
      aria-label="Reply to the selected text"
      data-slot="reply-selection-box"
      style={style}
      className="fixed z-50 flex flex-col gap-2 rounded-lg border border-border bg-popover p-2.5 text-popover-foreground shadow-md"
    >
      <blockquote
        data-slot="reply-selection-quote"
        className="line-clamp-2 border-l-2 border-border pl-2.5 text-label break-words text-muted-foreground"
      >
        {excerpt.replace(/\s+/g, ' ')}
      </blockquote>
      <div className="flex items-end gap-2">
        <textarea
          ref={input}
          rows={1}
          value={body}
          onChange={(event) => onBodyChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Reply…"
          aria-label="Your comment"
          className="field-sizing-content max-h-40 min-h-8 flex-1 resize-none bg-transparent px-1 py-1.5 text-sm outline-none placeholder:text-soft-foreground"
        />
        <button
          type="button"
          aria-label="Add comment"
          onClick={onSubmit}
          disabled={body.trim() === ''}
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground',
            'hover:bg-primary/90 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50',
          )}
        >
          <ArrowUpIcon aria-hidden="true" className="size-4" />
        </button>
      </div>
    </div>
  )
}
