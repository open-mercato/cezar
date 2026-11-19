import type { ManagerMessage } from '@open-mercato/cezar-api-client'
import { useCallback, useMemo, useRef, type RefObject } from 'react'

import { useManagerUserMessages } from '@/api/managers'
import { JUMP_OFFSET_PX, mergeMyMessages, type MyMessage, type MyMessagePlace } from '@/components/my-messages/my-messages'
import { untilFrame, useMyMessagesNav, type MyMessagesAdapter, type MyMessagesNav } from '@/components/my-messages/use-my-messages-nav'
import { toast } from '@/components/ui/toaster'

export function managerMyMessages(messages: readonly ManagerMessage[]): MyMessage[] {
  const out: MyMessage[] = []
  for (const message of messages) {
    if (message.kind !== 'user') continue
    const attachments = message.attachments ?? []
    const images = attachments.filter((attachment) => attachment.mediaType.startsWith('image/')).length
    out.push({ id: message.id, order: message.seq, ts: message.at, text: message.text, images, files: attachments.length - images })
  }
  return out
}

const byMessageId = (box: HTMLElement, id: string) =>
  Array.from(box.querySelectorAll<HTMLElement>('[data-message-id]')).find((node) => node.dataset.messageId === id)

/**
 * The manager chat's side of "your messages" (spec 2026-11-17-my-message-navigation). A reply
 * drawn on its question card has no row of its own, so it lands on that card.
 */
export function useManagerMyMessages({
  id,
  messages,
  onCard,
  hasNextPage,
  fetchNextPage,
  scrollRef,
  away,
  revealAt,
}: {
  id: string
  messages: readonly ManagerMessage[]
  onCard: ReadonlySet<string>
  hasNextPage: boolean
  fetchNextPage: () => Promise<unknown>
  scrollRef: RefObject<HTMLElement | null>
  away: boolean
  revealAt: (row: HTMLElement, inset: number) => void
}): MyMessagesNav {
  const index = useManagerUserMessages(id, away)
  const items = useMemo(
    () => mergeMyMessages(managerMyMessages(index.data ?? []), managerMyMessages(messages)),
    [index.data, messages],
  )
  const state = useRef({ messages, onCard, hasNextPage, fetchNextPage })
  state.current = { messages, onCard, hasNextPage, fetchNextPage }

  const rowOf = useCallback((messageId: string): HTMLElement | undefined => {
    const box = scrollRef.current
    if (!box) return undefined
    const { messages: loaded, onCard: shownOnCard } = state.current
    if (!shownOnCard.has(messageId)) return byMessageId(box, messageId)
    const at = loaded.findIndex((message) => message.id === messageId)
    const card = at > 0 ? loaded[at - 1] : undefined
    return card ? byMessageId(box, card.id) : undefined
  }, [scrollRef])

  const scroller = useCallback(() => scrollRef.current, [scrollRef])
  const viewport = useCallback(() => {
    const rect = scrollRef.current?.getBoundingClientRect()
    return rect ? { top: rect.top, bottom: rect.bottom } : { top: 0, bottom: 0 }
  }, [scrollRef])
  const place = useCallback((item: MyMessage): MyMessagePlace => {
    const row = rowOf(item.id)
    if (!row) return 'above' // every loaded message has a row; the rest are older
    const rect = row.getBoundingClientRect()
    return { top: rect.top, bottom: rect.bottom }
  }, [rowOf])

  const reveal = useCallback(async (item: MyMessage): Promise<HTMLElement | undefined> => {
    const loaded = () => state.current.messages.some((message) => message.id === item.id)
    // The #2218 walk: page back until the message is in the chat.
    while (!loaded() && state.current.hasNextPage) {
      const before = state.current.messages
      try {
        await state.current.fetchNextPage()
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
        return undefined
      }
      await untilFrame(() => state.current.messages !== before)
    }
    if (!(await untilFrame(() => rowOf(item.id) !== undefined))) {
      toast('Could not load that message', { tone: 'danger' })
      return undefined
    }
    const row = rowOf(item.id)!
    revealAt(row, JUMP_OFFSET_PX)
    return row.querySelector<HTMLElement>('[data-slot="manager-user-bubble"]') ?? row
  }, [revealAt, rowOf])

  const adapter = useMemo<MyMessagesAdapter>(
    () => ({ items, scroller, viewport, place, reveal }),
    [items, scroller, viewport, place, reveal],
  )
  return useMyMessagesNav(adapter, away)
}
