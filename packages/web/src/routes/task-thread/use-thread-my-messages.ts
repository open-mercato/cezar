import { isImageAttachmentName, queryScope, type RunUserMessage } from '@open-mercato/cezar-api-client'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useMemo, useRef } from 'react'

import { getRunUserMessages } from '@/api/client'
import type { RunHistoryState } from '@/api/run-history'
import { countAttachments, JUMP_OFFSET_PX, mergeMyMessages, type MyMessage, type MyMessagePlace } from '@/components/my-messages/my-messages'
import { untilFrame, useMyMessagesNav, type MyMessagesAdapter, type MyMessagesNav } from '@/components/my-messages/use-my-messages-nav'
import { toast } from '@/components/ui/toaster'

import type { TranscriptSection } from './session-transcript'
import type { ThreadScrollControls } from './thread-scroller'

/** A `user-message` line opens the turn keyed by its own seq (thread-state `newTurn`). */
export const userRowKey = (seq: number) => (seq === 0 ? 'task' : `turn-seq-${seq}:user`)

/** Transcript order of a user row key; undefined for rows that are no user message of ours. */
export function userRowOrder(key: string, queuedIndex = 0): number | undefined {
  if (key === 'task') return 0
  // The queued stack renders right under the opening task, above every turn.
  if (key.startsWith('queued:')) return 0.5 + queuedIndex / 1000
  const match = /^turn-seq-(\d+):user$/.exec(key)
  return match ? Number(match[1]) : undefined
}

export function indexedThreadMessages(messages: readonly RunUserMessage[]): MyMessage[] {
  return messages
    .filter((message) => message.seq !== 0 || message.text !== '' || message.images + message.files > 0)
    .map((message) => ({
      id: userRowKey(message.seq),
      order: message.seq,
      ...(message.ts !== undefined ? { ts: message.ts } : {}),
      text: message.text,
      images: message.images,
      files: message.files,
    }))
}

export function loadedThreadMessages(sections: readonly TranscriptSection[]): MyMessage[] {
  const out: MyMessage[] = []
  let queued = 0
  for (const section of sections) {
    const message = section.userMessage
    const key = section.userMessageKey
    if (!message || !key) continue
    const isQueued = key.startsWith('queued:')
    const order = userRowOrder(key, isQueued ? queued++ : 0)
    if (order === undefined) continue
    const counts = message.images && message.images.length > 0
      ? countAttachments(message.images, isImageAttachmentName)
      : { images: message.imageCount ?? 0, files: 0 }
    out.push({
      id: key,
      order,
      ...(message.ts !== undefined ? { ts: message.ts } : {}),
      text: message.text,
      ...counts,
      ...(isQueued ? { pending: 'queued' as const } : {}),
    })
  }
  return out
}

/** The loaded user row closest to `order`, preferring the one at or before it. */
export function nearestUserRowKey(keys: readonly string[], order: number): string | undefined {
  let before: { key: string; order: number } | undefined
  let after: { key: string; order: number } | undefined
  for (const key of keys) {
    const o = userRowOrder(key)
    if (o === undefined) continue
    if (o <= order) { if (!before || o > before.order) before = { key, order: o } }
    else if (!after || o < after.order) after = { key, order: o }
  }
  return (before ?? after)?.key
}

const rowSelector = (key: string) => {
  const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(key) : key.replace(/["\\]/g, '\\$&')
  return `[data-slot="thread-row"][data-row-key="${escaped}"]`
}

/**
 * The task thread's side of "your messages" (spec 2026-11-17-my-message-navigation): the list
 * is the server's index of the whole run merged with what is loaded, and a jump to a message in
 * a range that is not loaded pages back through the history first.
 */
export function useThreadMyMessages({
  runId,
  sections,
  rowKeys,
  history,
  scroll,
}: {
  runId: string
  sections: readonly TranscriptSection[]
  rowKeys: readonly string[]
  history: RunHistoryState | undefined
  scroll: ThreadScrollControls
}): MyMessagesNav {
  const index = useQuery({
    queryKey: ['run-user-messages', queryScope(), runId],
    queryFn: ({ signal }) => getRunUserMessages(runId, { signal }),
    // Only once the reader is away from the tail: at the tail there is no control to feed.
    enabled: scroll.pillVisible,
    staleTime: 15_000,
  })
  const items = useMemo(
    () => mergeMyMessages(indexedThreadMessages(index.data?.messages ?? []), loadedThreadMessages(sections)),
    [index.data, sections],
  )
  const rowKeysRef = useRef(rowKeys)
  rowKeysRef.current = rowKeys
  const historyRef = useRef(history)
  historyRef.current = history
  const { scrollElRef, revealRow } = scroll

  const scroller = useCallback(() => scrollElRef.current, [scrollElRef])
  const viewport = useCallback(() => {
    const box = scrollElRef.current
    if (!box) return { top: 0, bottom: 0 }
    const rect = box.getBoundingClientRect()
    // On md+ the run header sticks to the scroller's top, and the dock always sticks to its bottom.
    const header = box.querySelector<HTMLElement>('[data-slot="run-header"]')
    const top = header && getComputedStyle(header).position === 'sticky' ? Math.max(rect.top, header.getBoundingClientRect().bottom) : rect.top
    const dock = box.querySelector<HTMLElement>('[data-slot="thread-dock"]')
    const bottom = dock ? Math.min(rect.bottom, dock.getBoundingClientRect().top) : rect.bottom
    return { top, bottom }
  }, [scrollElRef])

  const place = useCallback((item: MyMessage): MyMessagePlace => {
    const box = scrollElRef.current
    const row = box?.querySelector<HTMLElement>(rowSelector(item.id))
    if (row) {
      const rect = row.getBoundingClientRect()
      return { top: rect.top, bottom: rect.bottom }
    }
    const keys = rowKeysRef.current
    const at = keys.indexOf(item.id)
    // Not loaded: an older range (every newer one is loaded, the tail always is).
    if (at < 0) return 'above'
    // Loaded but outside virtua's window: on the side of the first row it did render.
    const first = box?.querySelector<HTMLElement>('[data-slot="thread-row"][data-row-key]')
    const firstAt = first ? keys.indexOf(first.dataset.rowKey!) : -1
    return at < firstAt ? 'above' : 'below'
  }, [scrollElRef])

  const reveal = useCallback(async (item: MyMessage): Promise<HTMLElement | undefined> => {
    let key = item.id
    let loadFailed = false
    const loaded = () => rowKeysRef.current.includes(key)
    while (!loaded() && historyRef.current?.hasOlder) {
      const before = rowKeysRef.current
      try {
        await historyRef.current.loadOlder()
      } catch {
        loadFailed = true
        break
      }
      // The page resolves before its rows render.
      await untilFrame(() => rowKeysRef.current !== before)
    }
    if (!loaded() && !(await untilFrame(loaded))) {
      // Whole history paged in and the message still has no row of its own (it folded into
      // another turn): land on the nearest user row instead of an error. Only a failed page is one.
      const near = loadFailed ? undefined : nearestUserRowKey(rowKeysRef.current, item.order)
      if (!near) {
        toast('Could not load that message', { tone: 'danger' })
        return undefined
      }
      key = near
    }
    const box = scrollElRef.current
    if (!box) return undefined
    const inset = viewport().top - box.getBoundingClientRect().top + JUMP_OFFSET_PX
    if (!revealRow(key, inset)) {
      // Virtualized: the row exists only once virtua renders it.
      await untilFrame(() => box.querySelector(rowSelector(key)) !== null)
      revealRow(key, inset)
    }
    await untilFrame(() => box.querySelector(rowSelector(key)) !== null)
    const row = box.querySelector<HTMLElement>(rowSelector(key))
    return row?.querySelector<HTMLElement>('[data-slot="user-bubble"]') ?? row ?? undefined
  }, [revealRow, scrollElRef, viewport])

  const adapter = useMemo<MyMessagesAdapter>(
    () => ({ items, scroller, viewport, place, reveal }),
    [items, scroller, viewport, place, reveal],
  )
  return useMyMessagesNav(adapter, scroll.pillVisible)
}
