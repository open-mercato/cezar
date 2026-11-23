import { QuoteIcon, XIcon } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { QUOTE_MAX } from '@/lib/message-quotes'
import { isCoarsePointer } from './touch'
import { captureFromSelection, captureRange, isRetired, QUOTE_ACTION_ATTR, retireCapture, type QuoteCapture } from './types'

const GAP = 8
const HEIGHT = 44

/** The Quote action's keyboard shortcut, matched by physical key: on a Mac ⌥Q reports `œ`. */
export const QUOTE_SHORTCUT = 'Alt+Q'

function isQuoteKey(event: KeyboardEvent): boolean {
  const q = event.code ? event.code === 'KeyQ' : event.key.toLowerCase() === 'q'
  return q && event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey
}

/** The last valid capture, kept on touch when a tap collapses the selection (spec 2026-11-20, § 1). */
export function useMessageSelection(enabled = true): QuoteCapture | null {
  const [capture, setCapture] = useState<QuoteCapture | null>(null)
  const pending = useRef<number | null>(null)
  useEffect(() => {
    if (!enabled) return
    const update = () => {
      if (pending.current !== null) return
      pending.current = requestAnimationFrame(() => {
        pending.current = null
        const selection = typeof window.getSelection === 'function' ? window.getSelection() : null
        if (!selection || selection.isCollapsed) {
          const keep = isCoarsePointer()
          setCapture((current) => (current && keep && current.source.isConnected ? current : null))
          return
        }
        const next = captureFromSelection(selection)
        // The same text again (a selectionchange with nothing new) keeps the object, so no re-render.
        setCapture((current) => (sameCapture(current, next) ? current : next))
      })
    }
    const outside = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest(`[${QUOTE_ACTION_ATTR}]`)) return
      setCapture(null)
    }
    // A touch scroll starts with a pointerdown but never clicks.
    const away = isCoarsePointer() ? 'click' : 'pointerdown'
    document.addEventListener('selectionchange', update)
    document.addEventListener(away, outside, true)
    return () => {
      document.removeEventListener('selectionchange', update)
      document.removeEventListener(away, outside, true)
      if (pending.current !== null) cancelAnimationFrame(pending.current)
      pending.current = null
    }
  }, [enabled])
  return enabled ? capture : null
}

function sameCapture(a: QuoteCapture | null, b: QuoteCapture | null): boolean {
  if (a === b) return true
  return a !== null && b !== null && !isRetired(a) && a.source === b.source && a.excerpt === b.excerpt && a.code === b.code
}

function anchorRect(capture: QuoteCapture): DOMRect | undefined {
  const selection = window.getSelection()
  const live = selection && !selection.isCollapsed && selection.rangeCount ? selection.getRangeAt(0) : undefined
  const range = live ?? captureRange(capture)
  if (!range || typeof range.getClientRects !== 'function') return undefined
  const rects = range.getClientRects()
  return rects.item(rects.length - 1) ?? range.getBoundingClientRect()
}

/**
 * Floating "Quote" action at the selection. Hides itself after Quote, Esc, or ✕ for that capture.
 * Alt+Q quotes from the keyboard: a fixed toolbar is not next to the selection in Tab order.
 */
export function SelectionToolbar({ capture, onQuote, onDismiss, showClose = false, placement = 'above' }: {
  capture: QuoteCapture
  onQuote: (capture: QuoteCapture) => void
  onDismiss?: () => void
  /** A ✕ beside Quote, for hosts with no other obvious way out (the manager chat). */
  showClose?: boolean
  /** `below` on touch, where the native selection callout owns the space above. */
  placement?: 'above' | 'below'
}) {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const [dismissed, setDismissed] = useState<QuoteCapture | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const hidden = dismissed === capture
  const dismiss = useCallback(() => {
    setDismissed(capture)
    retireCapture(capture)
    // Every host clears the native selection with the toolbar, so Esc leaves nothing highlighted.
    window.getSelection()?.removeAllRanges()
    onDismiss?.()
  }, [capture, onDismiss])
  const quote = useCallback(() => {
    onQuote(capture)
    dismiss()
  }, [capture, dismiss, onQuote])

  const place = useCallback(() => {
    const rect = anchorRect(capture) ?? capture.source.getBoundingClientRect()
    // Off screen or gone: a fixed toolbar would float over unrelated text.
    if (!capture.source.isConnected || rect.bottom < 0 || rect.top > window.innerHeight) {
      setPosition(null)
      return
    }
    const width = ref.current?.offsetWidth ?? 80
    const left = Math.max(GAP, Math.min(window.innerWidth - width - GAP, rect.left + rect.width / 2 - width / 2))
    const above = rect.top - HEIGHT
    const below = rect.bottom + GAP
    setPosition({ left, top: placement === 'below' || above < GAP ? below : above })
  }, [capture, placement])

  useLayoutEffect(() => {
    if (!hidden) place()
  }, [hidden, place])

  useEffect(() => {
    if (hidden) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss()
      else if (isQuoteKey(event) && !event.repeat) {
        event.preventDefault()
        quote()
      }
    }
    // Capture phase: the transcript scroller is not the window, and scroll does not bubble.
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    window.addEventListener('keydown', onKey)
    // Content reflowing above the selection (an image loading) moves it without a scroll or a
    // resize event; an ancestor growing is what catches that.
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => place())
    for (let el: Element | null = capture.source; el && el !== document.documentElement; el = el.parentElement) observer?.observe(el)
    return () => {
      observer?.disconnect()
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
      window.removeEventListener('keydown', onKey)
    }
  }, [capture.source, dismiss, hidden, place, quote])

  if (hidden) return null
  const truncated = capture.excerpt.length === QUOTE_MAX && capture.excerpt.endsWith('…')
  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label="Quote selection"
      data-slot="quote-selection-toolbar"
      {...{ [QUOTE_ACTION_ATTR]: '' }}
      style={position ? { left: position.left, top: position.top } : { visibility: 'hidden', left: 0, top: 0 }}
      className="fixed z-50 flex items-center gap-1 rounded-md border border-border bg-background p-1 shadow-modal"
    >
      <Button
        size="sm"
        variant="outline"
        className="pointer-coarse:min-h-11"
        aria-keyshortcuts={QUOTE_SHORTCUT}
        title={`Quote (${QUOTE_SHORTCUT})`}
        onPointerDown={(event) => event.preventDefault()}
        onClick={quote}
      >
        <QuoteIcon aria-hidden="true" className="size-3.5" /> {truncated ? `Quote (first ${QUOTE_MAX} characters)` : 'Quote'}
      </Button>
      {showClose ? (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Close quote selection"
          className="pointer-coarse:size-11"
          onPointerDown={(event) => event.preventDefault()}
          onClick={dismiss}
        >
          <XIcon aria-hidden="true" className="size-3.5" />
        </Button>
      ) : null}
    </div>
  )
}
