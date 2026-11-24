import { describe, expect, it } from 'vitest'

import {
  addMessageQuote,
  capQuoteExcerpt,
  dropSentQuotes,
  messageWithQuotesAndReview,
  formatMessageQuotes,
  parseMessageWithQuotesAndReview,
  parseQuotesMessage,
  QUOTE_MAX,
  QUOTES_MAX,
  withMessageQuotes,
  withMessageQuotesAndReview,
  type MessageQuote,
} from './message-quotes'

const prose: MessageQuote = {
  id: 'a', ref: 412, role: 'assistant', excerpt: 'The migration keeps the old column\nuntil the backfill finishes.', code: false, body: "Can't we drop it in the same migration?",
}
const code: MessageQuote = {
  id: 'b', ref: 398, role: 'user', excerpt: 'npm run db:migrate -- --dry\nconst fence = ```;', code: true, body: '',
}

describe('message quotes', () => {
  it('formats and parses prose, code, notes and the task description', () => {
    // The task row is the user's prompt, so the label round-trips to a user quote (jump target 'task').
    const task: MessageQuote = { ...prose, id: 'task', ref: 0, role: 'user', body: '' }
    const text = formatMessageQuotes([prose, code, task])
    expect(text).toContain('- From your message #412:')
    expect(text).toContain('- From my earlier message #398:')
    expect(text).toContain('- From the task description:')
    expect(text).toContain('````\n  npm run db:migrate -- --dry\n  const fence = ```;\n  ````')
    expect(parseQuotesMessage(`please explain\n\n${text}`)).toEqual({
      lead: 'please explain',
      items: [
        { ...prose, id: 'quote-1' },
        { ...code, id: 'quote-2' },
        { ...task, id: 'quote-3' },
      ],
    })
  })

  it('labels and parses the reply to the task in a task, and not in the manager chat', () => {
    const reply: MessageQuote = { ...prose, id: 'r', ref: 0, role: 'assistant', body: '' }
    const text = formatMessageQuotes([reply])
    expect(text).toContain('- From your reply to the task:')
    expect(parseQuotesMessage(text)?.items[0]).toMatchObject({ role: 'assistant', ref: 0 })
    expect(formatMessageQuotes([reply], { taskDescription: false })).toContain('- From your message #0:')
  })

  it('labels a manager chat seq 0 as a message, not the task description', () => {
    const first: MessageQuote = { ...prose, id: 'm0', ref: 0, role: 'user', body: '' }
    const text = withMessageQuotes('', [first, { ...prose, ref: 0 }], { taskDescription: false })
    expect(text).toContain('- From my earlier message #0:')
    expect(text).toContain('- From your message #0:')
    expect(text).not.toContain('the task description')
    expect(parseQuotesMessage(text)?.items.map(({ role, ref }) => ({ role, ref }))).toEqual([
      { role: 'user', ref: 0 },
      { role: 'assistant', ref: 0 },
    ])
  })

  it('keeps unknown blocks as ordinary text and does not misread an embedded heading', () => {
    expect(parseQuotesMessage('quoted text:\n\nQuoted from the conversation:\n\nnot an item')).toBeUndefined()
    expect(parseQuotesMessage('just text')).toBeUndefined()
  })

  it('caps an excerpt, the quote count and drops duplicates at the composition boundary', () => {
    const capped = capQuoteExcerpt('x'.repeat(10_000))
    expect(capped).toHaveLength(QUOTE_MAX)
    expect(capped.endsWith('…')).toBe(true)

    // Twenty distinct sources: only the first QUOTES_MAX are written.
    const many = Array.from({ length: 20 }, (_, i): MessageQuote => ({ ...prose, id: String(i), ref: 100 + i }))
    const text = formatMessageQuotes(many)
    expect(text.match(/^- From /gm)).toHaveLength(QUOTES_MAX)
    expect(text).toContain(`#${100 + QUOTES_MAX - 1}:`)
    expect(text).not.toContain(`#${100 + QUOTES_MAX}:`)

    // The same source and excerpt under another id is written once; the first one's note wins.
    const dup = formatMessageQuotes([prose, { ...prose, id: 'again', body: 'second note' }])
    expect(dup.match(/^- From /gm)).toHaveLength(1)
    expect(dup).not.toContain('second note')
    expect(withMessageQuotes('ask', [prose])).toMatch(/^ask\n\nQuoted from the conversation:/)
  })

  it('composes quotes before diff comments and parses both back', () => {
    const comment = { id: 'd', path: 'a.ts', side: 'new' as const, line: 1, excerpt: 'x', body: 'do it' }
    const combined = withMessageQuotesAndReview('please fix', [prose], [comment])
    expect(combined.indexOf('Quoted from the conversation:')).toBeLessThan(combined.indexOf('Review comments on the diff:'))
    const parsed = parseMessageWithQuotesAndReview(combined)
    expect(parsed?.lead).toBe('please fix')
    expect(parsed?.quotes).toEqual([{ ...prose, id: 'quote-1' }])
    expect(parsed?.comments).toHaveLength(1)
    expect(parsed?.comments[0]).toMatchObject({ path: 'a.ts', line: 1, body: 'do it' })

    // Either block alone parses too, and plain text is not a quoted message.
    expect(parseMessageWithQuotesAndReview(withMessageQuotes('hi', [prose]))).toMatchObject({ lead: 'hi', comments: [] })
    expect(parseMessageWithQuotesAndReview(withMessageQuotesAndReview('hi', [], [comment]))).toMatchObject({ lead: 'hi', quotes: [] })
    expect(parseMessageWithQuotesAndReview('just text')).toBeUndefined()
  })

  it('refuses an over-long message naming both kinds attached', () => {
    const comment = { id: 'd', path: 'a.ts', side: 'new' as const, line: 1, excerpt: 'x', body: 'do it' }
    const long = 'x'.repeat(100_000)
    expect(() => messageWithQuotesAndReview(long, [prose, { ...prose, id: 'p2', ref: 9 }], [comment])).toThrow(
      'Too long with the 2 quotes and the diff comment attached — shorten the message or remove some quotes or comments.',
    )
    expect(() => messageWithQuotesAndReview(long, [prose], [])).toThrow(/the quote attached .* remove some quotes\./)
    expect(messageWithQuotesAndReview('hi', [], [comment], 'Review feedback:\n')).toMatch(/^Review feedback:\nhi\n\nReview comments/)
  })
})

describe('the quote list rules every host shares', () => {
  const capture = { role: 'assistant' as const, ref: 4, excerpt: 'Keep the column.', code: false }

  it('adds a quote, ignores the same source and text twice, and refuses a 13th', () => {
    const first = addMessageQuote([], capture)
    expect(first.result).toBe('added')
    const items = first.result === 'added' ? first.items : []
    expect(items).toMatchObject([{ ...capture, body: '' }])
    expect(addMessageQuote(items, capture).result).toBe('duplicate')
    expect(addMessageQuote(items, { ...capture, ref: 5 }).result).toBe('added')
    const full = Array.from({ length: QUOTES_MAX }, (_, i) => ({ ...capture, id: `q${i}`, ref: i, body: '' }))
    expect(addMessageQuote(full, { ...capture, ref: 99 }).result).toBe('full')
  })

  it('drops only what a send carried, as it was sent', () => {
    const sent = [{ ...capture, id: 'a', body: '' }, { ...capture, id: 'b', ref: 5, body: 'why?' }]
    const now = [sent[0]!, { ...sent[1]!, body: 'edited in flight' }, { ...capture, id: 'c', ref: 6, body: '' }]
    expect(dropSentQuotes(now, sent).map((q) => q.id)).toEqual(['b', 'c'])
  })

  it('labels the manager chat\'s seq 0 as a message, not the task', () => {
    const zero = { ...capture, id: 'z', ref: 0, body: '' }
    expect(messageWithQuotesAndReview('hi', [zero], [], '', { taskDescription: false })).toContain('From your message #0:')
    expect(messageWithQuotesAndReview('hi', [zero], [])).toContain('From your reply to the task:')
  })
})
