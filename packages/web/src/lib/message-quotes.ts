import { fence, formatDiffComments, indent, MESSAGE_TEXT_MAX, parseReviewMessage, trimBlankEdges, type DiffComment, type ReviewItem } from '@/routes/task-thread/diff-comments'

/** Maximum rendered text retained for one quote. */
export const QUOTE_MAX = 2_000
/** Maximum quote cards carried by one message. */
export const QUOTES_MAX = 12
export const QUOTES_HEADING = 'Quoted from the conversation:'
export const MESSAGE_QUOTES_SURFACE = 'message-quotes'

export interface MessageQuote {
  id: string
  ref?: number
  rowKey?: string
  role: 'assistant' | 'user'
  excerpt: string
  code: boolean
  body: string
}

export function capQuoteExcerpt(text: string): string {
  const trimmed = trimBlankEdges(text)
  // The ellipsis counts: a capped excerpt is exactly QUOTE_MAX long.
  return trimmed.length <= QUOTE_MAX ? trimmed : `${trimmed.slice(0, QUOTE_MAX - 1)}…`
}

/** `taskDescription`: in a task, ref 0 is the task's prompt (user) or the agent's reply to it
 *  (assistant). Off in the manager chat, whose first message is seq 0. */
export interface QuoteFormatOptions {
  taskDescription?: boolean
}

function labelFor(quote: Pick<MessageQuote, 'role' | 'ref'>, taskDescription: boolean): string {
  if (taskDescription && quote.role === 'user' && quote.ref === 0) return 'the task description'
  if (taskDescription && quote.role === 'assistant' && quote.ref === 0) return 'your reply to the task'
  if (quote.ref === undefined) return quote.role === 'assistant' ? 'your message' : 'my earlier message'
  return quote.role === 'assistant' ? `your message #${quote.ref}` : `my earlier message #${quote.ref}`
}

/** Caps each excerpt and drops duplicates (first wins). No count cap: a cross-window merge may
 *  hold more than QUOTES_MAX, and a draft must keep what one send cannot carry. */
export function dedupeMessageQuotes(quotes: readonly MessageQuote[]): MessageQuote[] {
  const seen = new Set<string>()
  const out: MessageQuote[] = []
  for (const quote of quotes) {
    const excerpt = capQuoteExcerpt(quote.excerpt)
    const key = `${quote.role}\u0000${quote.ref ?? ''}\u0000${excerpt}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ ...quote, excerpt })
  }
  return out
}

/** What one message carries: deduped, at most QUOTES_MAX. */
export function normalizeMessageQuotes(quotes: readonly MessageQuote[]): MessageQuote[] {
  return dedupeMessageQuotes(quotes).slice(0, QUOTES_MAX)
}

/** Formats the stable, plain-Markdown block attached to a sent message. */
export function formatMessageQuotes(quotes: readonly MessageQuote[], { taskDescription = true }: QuoteFormatOptions = {}): string {
  if (quotes.length === 0) return ''
  const blocks = normalizeMessageQuotes(quotes).map((quote) => {
    const excerpt = quote.code ? fence(quote.excerpt) : quote.excerpt.split('\n').map((line) => `> ${line}`).join('\n')
    const note = quote.body.trim()
    return `- From ${labelFor(quote, taskDescription)}:\n\n${indent(excerpt)}${note === '' ? '' : `\n\n${indent(note)}`}`
  })
  return `${QUOTES_HEADING}\n\n${blocks.join('\n\n')}`
}

function headerLabel(text: string): { role: 'assistant' | 'user'; ref?: number } | undefined {
  if (text === 'the task description') return { role: 'user', ref: 0 }
  if (text === 'your reply to the task') return { role: 'assistant', ref: 0 }
  let match = /^your message(?: #(\d+))?$/.exec(text)
  if (match) return { role: 'assistant', ...(match[1] ? { ref: Number(match[1]) } : {}) }
  match = /^my earlier message(?: #(\d+))?$/.exec(text)
  if (match) return { role: 'user', ...(match[1] ? { ref: Number(match[1]) } : {}) }
  return undefined
}

/** Reads only the quote block owned by this feature; unknown text remains ordinary Markdown. */
export function parseQuotesMessage(text: string): { lead: string; items: MessageQuote[] } | undefined {
  const at = text.indexOf(`${QUOTES_HEADING}\n\n`)
  if (at === -1 || (at > 0 && text[at - 1] !== '\n')) return undefined
  const lead = text.slice(0, at).trim()
  const lines = text.slice(at + QUOTES_HEADING.length + 2).split('\n')
  const items: MessageQuote[] = []
  let i = 0
  while (i < lines.length) {
    const match = /^- From (.+):$/.exec(lines[i] ?? '')
    if (!match) {
      if ((lines[i] ?? '').trim() === '') { i++; continue }
      return undefined
    }
    const source = headerLabel(match[1]!)
    if (!source) return undefined
    i++
    const content: string[] = []
    while (i < lines.length && !/^- From .+:$/.test(lines[i] ?? '')) {
      content.push((lines[i] ?? '').replace(/^ {2}/, ''))
      i++
    }
    while (content[0]?.trim() === '') content.shift()
    while (content.at(-1)?.trim() === '') content.pop()
    let excerpt = ''
    let code = false
    const opening = /^(`{3,})\s*$/.exec(content[0] ?? '')
    if (opening) {
      code = true
      const close = content.findIndex((line, index) => index > 0 && line.trim() === opening[1])
      excerpt = content.slice(1, close === -1 ? undefined : close).join('\n')
      content.splice(0, close === -1 ? content.length : close + 1)
    } else {
      const quoted: string[] = []
      while (content[0]?.startsWith('> ')) quoted.push(content.shift()!.slice(2))
      excerpt = quoted.join('\n')
    }
    while (content[0]?.trim() === '') content.shift()
    items.push({ id: `quote-${items.length + 1}`, ...source, excerpt, code, body: content.join('\n').trim() })
  }
  return items.length > 0 ? { lead, items } : undefined
}

/** Adds quotes after typed text, retaining slash-command semantics. */
export function withMessageQuotes(text: string, quotes: readonly MessageQuote[], options?: QuoteFormatOptions): string {
  const block = formatMessageQuotes(quotes, options)
  return block === '' ? text : text.trim() === '' ? block : `${text}\n\n${block}`
}

/** Composes the two cockpit-owned blocks in the wire order: typed text, quotes, then review. */
export function withMessageQuotesAndReview(
  text: string,
  quotes: readonly MessageQuote[],
  comments: readonly DiffComment[],
  options?: QuoteFormatOptions,
): string {
  const quoted = withMessageQuotes(text, quotes, options)
  const review = formatDiffComments(comments)
  return review === '' ? quoted : quoted.trim() === '' ? review : `${quoted}\n\n${review}`
}

function count(n: number, one: string): string {
  return n === 1 ? `the ${one}` : `the ${n} ${one}s`
}

/** The send with both blocks attached, refused HERE when it would exceed the server's cap — the
 *  error names what is attached. Throws, so the host keeps the text, the quotes and the comments. */
export function messageWithQuotesAndReview(
  text: string,
  quotes: readonly MessageQuote[],
  comments: readonly DiffComment[],
  prefix = '',
  options?: QuoteFormatOptions,
): string {
  const message = `${prefix}${withMessageQuotesAndReview(text, quotes, comments, options)}`
  if (message.length <= MESSAGE_TEXT_MAX) return message
  const kinds = [quotes.length ? count(quotes.length, 'quote') : '', comments.length ? count(comments.length, 'diff comment') : ''].filter(Boolean)
  const attached = kinds.length ? kinds.join(' and ') : 'its attachments'
  const remove = quotes.length && comments.length ? 'some quotes or comments' : quotes.length ? 'some quotes' : 'some comments'
  throw new Error(`Too long with ${attached} attached — shorten the message or remove ${remove}.`)
}

/** Parses both blocks in either direction, returning the typed lead and both item lists. */
export function parseMessageWithQuotesAndReview(text: string): {
  lead: string
  quotes: MessageQuote[]
  comments: ReviewItem[]
} | undefined {
  const review = parseReviewMessage(text)
  const withoutReview = review?.lead ?? text
  const quotes = parseQuotesMessage(withoutReview)
  if (!review && !quotes) return undefined
  return { lead: quotes?.lead ?? withoutReview, quotes: quotes?.items ?? [], comments: review?.items ?? [] }
}

export const QUOTES_FULL_MESSAGE = `Up to ${QUOTES_MAX} quotes per message — send these first.`

export function newQuoteId(): string {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `quote-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** One add rule for every host: a duplicate (same source and excerpt) is a no-op, a 13th is
 *  refused so the host can say so (QUOTES_FULL_MESSAGE). */
export function addMessageQuote(
  items: readonly MessageQuote[],
  capture: Omit<MessageQuote, 'id' | 'body'>,
): { result: 'added'; items: MessageQuote[] } | { result: 'duplicate' } | { result: 'full' } {
  const excerpt = capQuoteExcerpt(capture.excerpt)
  if (items.some((q) => q.role === capture.role && q.ref === capture.ref && capQuoteExcerpt(q.excerpt) === excerpt)) return { result: 'duplicate' }
  if (items.length >= QUOTES_MAX) return { result: 'full' }
  return { result: 'added', items: dedupeMessageQuotes([...items, { ...capture, id: newQuoteId(), body: '' }]) }
}

/** After a send, drop exactly what it carried, as it was sent: a quote added or re-noted in
 *  flight stays for the next message. */
export function dropSentQuotes(current: readonly MessageQuote[], sent: readonly MessageQuote[]): MessageQuote[] {
  const sentAs = new Map(sent.map((quote) => [quote.id, quote]))
  return current.filter((quote) => {
    const was = sentAs.get(quote.id)
    return was === undefined || was.body !== quote.body || was.excerpt !== quote.excerpt
  })
}
