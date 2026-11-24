import { useCallback, useMemo } from 'react'

import { toast } from '@/components/ui/toaster'
import { addMessageQuote, dedupeMessageQuotes, MESSAGE_QUOTES_SURFACE, normalizeMessageQuotes, QUOTES_FULL_MESSAGE, type MessageQuote } from '@/lib/message-quotes'

import { useDraftList } from './diff-comments'

/** The run's quote drafts: the diff-comments store, made generic (spec 2026-11-20 §4). */
export interface MessageQuotes {
  ready: boolean
  quotes: readonly MessageQuote[]
  /** `false` when the quote could not be kept (QUOTES_MAX, draft cap). A duplicate is a no-op. */
  add: (capture: Omit<MessageQuote, 'id' | 'body'>) => boolean
  update: (quote: MessageQuote) => boolean
  remove: (id: string) => void
  /** Hand the quotes to a send; once it lands exactly the quotes it carried are dropped. */
  submit: <T>(send: (quotes: readonly MessageQuote[]) => Promise<T>) => Promise<T>
}

/** Defensive: the stored text is whatever the wire carried. Anything malformed is dropped. */
export function parseStoredQuotes(text: string): MessageQuote[] {
  if (text === '') return []
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(value)) return []
  const valid = value.filter((x): x is MessageQuote => {
    if (x === null || typeof x !== 'object') return false
    const q = x as Record<string, unknown>
    return typeof q.id === 'string' && typeof q.excerpt === 'string' && (q.role === 'assistant' || q.role === 'user')
  })
  return dedupeMessageQuotes(valid.map((q) => ({ ...q, body: typeof q.body === 'string' ? q.body : '', code: q.code === true })))
}

export function useMessageQuotes(runId: string): MessageQuotes {
  const list = useDraftList(runId, MESSAGE_QUOTES_SURFACE, parseStoredQuotes, 'Too many quotes to keep as a draft — send the ones you have first.', normalizeMessageQuotes)
  const { current, write, remove, submit, items, ready } = list
  const add = useCallback(
    (capture: Omit<MessageQuote, 'id' | 'body'>) => {
      const added = addMessageQuote(current(), capture)
      if (added.result === 'duplicate') return true
      if (added.result === 'full') {
        toast(QUOTES_FULL_MESSAGE, { tone: 'danger' })
        return false
      }
      return write(added.items)
    },
    [current, write],
  )
  const update = useCallback(
    (quote: MessageQuote) => write(dedupeMessageQuotes(current().map((item) => (item.id === quote.id ? quote : item)))),
    [current, write],
  )
  return useMemo(() => ({ ready, quotes: items, add, update, remove, submit }), [ready, items, add, update, remove, submit])
}
