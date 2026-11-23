export { QUOTE_MAX, QUOTES_MAX, type MessageQuote } from '@/lib/message-quotes'
import { capQuoteExcerpt } from '@/lib/message-quotes'
import type { MessageQuote } from '@/lib/message-quotes'

export interface QuoteCapture extends Omit<MessageQuote, 'id' | 'body'> {
  source: HTMLElement
}

// Kept beside the capture, not on it: hosts spread a capture into a stored quote.
const ranges = new WeakMap<QuoteCapture, Range>()

// A capture that was quoted or dismissed: the same text selected again must be a NEW capture,
// since hosts hide a handled one by identity.
const retired = new WeakSet<QuoteCapture>()

export function retireCapture(capture: QuoteCapture): void {
  retired.add(capture)
}

export function isRetired(capture: QuoteCapture): boolean {
  return retired.has(capture)
}

/** A copy of the captured range: it outlives the selection, so the toolbar can follow scrolls. */
export function captureRange(capture: QuoteCapture): Range | undefined {
  return ranges.get(capture)
}

/** Marks a host element (a toolbar, a composer chip) whose pointerdown must not drop the capture. */
export const QUOTE_ACTION_ATTR = 'data-quote-action'

function textBetween(startNode: Node, startOffset: number, endNode: Node, endOffset: number): boolean {
  const between = document.createRange()
  between.setStart(startNode, startOffset)
  between.setEnd(endNode, endOffset)
  return between.toString().trim() !== ''
}

function clampTo(node: Node, range: Range): Range {
  const clipped = document.createRange()
  clipped.selectNodeContents(node)
  if (clipped.compareBoundaryPoints(Range.START_TO_START, range) < 0) clipped.setStart(range.startContainer, range.startOffset)
  if (clipped.compareBoundaryPoints(Range.END_TO_END, range) > 0) clipped.setEnd(range.endContainer, range.endOffset)
  return clipped
}

/** Streamdown's Shiki lines are block spans with no "\n" between them, so join them by hand. */
function codeTextWithin(codeBody: Element, range: Range): string {
  const lines = [...codeBody.querySelectorAll('pre > code > span')]
  if (!lines.length) return clampTo(codeBody, range).toString()
  return lines
    .filter((line) => range.intersectsNode(line))
    .map((line) => clampTo(line, range).toString().replace(/\n$/, ''))
    .join('\n')
}

export function captureFromSelection(selection: Selection, root: ParentNode = document): QuoteCapture | null {
  if (selection.isCollapsed || !selection.rangeCount) return null
  const range = selection.getRangeAt(0)
  const elementOf = (node: Node): Element | null => node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement
  const commonBody = elementOf(range.commonAncestorContainer)?.closest<HTMLElement>('[data-quote-body]')
  const startBody = elementOf(range.startContainer)?.closest<HTMLElement>('[data-quote-body]')
  const endBody = elementOf(range.endContainer)?.closest<HTMLElement>('[data-quote-body]')
  const body = commonBody ?? startBody ?? endBody ?? (() => {
    const intersecting = [...root.querySelectorAll<HTMLElement>('[data-quote-body]')].filter((candidate) => range.intersectsNode(candidate))
    return intersecting.length === 1 ? intersecting[0] : undefined
  })()
  if (!body || !body.isConnected || !root.contains(body)) return null
  if ((startBody && startBody !== body) || (endBody && endBody !== body)) return null
  // A boundary outside the body is fine only when nothing visible lies between it and the body:
  // a tool card or sub-agent panel next to the message must never be quoted as the message.
  if (!startBody && textBetween(range.startContainer, range.startOffset, body, 0)) return null
  if (!endBody && textBetween(body, body.childNodes.length, range.endContainer, range.endOffset)) return null
  // Session cards, ask cards and the like sit inside a body but are never quotable.
  if (elementOf(range.commonAncestorContainer)?.closest('[data-quote-excluded]')) return null
  for (const excluded of body.querySelectorAll('[data-quote-excluded]')) {
    if (range.intersectsNode(excluded)) return null
  }
  // A code block selected with its header ("ts", Copy) quotes only the code, as code.
  const codeBlockBody = elementOf(range.commonAncestorContainer)
    ?.closest('[data-streamdown="code-block"]')
    ?.querySelector('[data-streamdown="code-block-body"]')
  let text = selection.toString()
  if (codeBlockBody && !codeBlockBody.contains(range.commonAncestorContainer)) text = codeTextWithin(codeBlockBody, range)
  // One cap rule for capture and storage; it keeps a code selection's first-line indent.
  const excerpt = capQuoteExcerpt(text)
  if (excerpt.trim() === '') return null
  const row = body.closest<HTMLElement>('[data-row-key]')
  const refValue = body.dataset.quoteRef
  const ref = refValue === undefined || refValue === '' ? undefined : Number(refValue)
  const role = body.dataset.quoteRole === 'user' ? 'user' : 'assistant'
  const code = Boolean(codeBlockBody) || Boolean(elementOf(range.commonAncestorContainer)?.closest('pre code'))
  const capture: QuoteCapture = {
    source: body,
    excerpt,
    code,
    role,
    ...(Number.isFinite(ref) ? { ref } : {}),
    ...(row?.dataset.rowKey ? { rowKey: row.dataset.rowKey } : {}),
  }
  ranges.set(capture, range.cloneRange())
  return capture
}
