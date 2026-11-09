import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { assistantMessage, managerFixture, userMessage } from '@/routes/manager/manager-fixtures'
import {
  applyManagerChange,
  applyManagerEvent,
  applyManagerMessage,
  createManager,
  decideManagerAction,
  sendManagerMessage,
  getManagerMessages,
  managerChat,
  managerKeys,
  managersNeedAttention,
  orderManagers,
} from './managers'

const page = (messages: ReturnType<typeof userMessage>[], hasMore = false) => ({ messages, hasMore })
const pages = (...list: ReturnType<typeof page>[]) => ({ pages: list, pageParams: list.map(() => undefined) })

describe('applyManagerChange', () => {
  const list = { managers: [managerFixture({ id: 'a' }), managerFixture({ id: 'b' })] }

  it('replaces in place, adds, deletes', () => {
    const renamed = managerFixture({ id: 'a', name: 'New' })
    expect(applyManagerChange(list, 'a', renamed, false)?.managers.map((m) => m.name)).toEqual(['New', 'Global Manager'])
    expect(applyManagerChange(list, 'c', managerFixture({ id: 'c' }), false)?.managers).toHaveLength(3)
    expect(applyManagerChange(list, 'a', undefined, true)?.managers.map((m) => m.id)).toEqual(['b'])
  })

  it('never invents a list nobody fetched', () => {
    expect(applyManagerChange(undefined, 'a', managerFixture(), false)).toBeUndefined()
  })

  it('leaves the list alone for a bare id that is not a deletion', () => {
    expect(applyManagerChange(list, 'a', undefined, false)).toBe(list)
  })
})

describe('applyManagerMessage', () => {
  it('replaces by id in whichever page holds it', () => {
    const data = pages(page([userMessage(5)]), page([assistantMessage(1)]))
    const next = applyManagerMessage(data, assistantMessage(1, { text: 'more' }))
    expect(managerChat(next).map((m) => ('text' in m ? m.text : ''))).toEqual(['more', 'jak progres prac'])
  })

  it('appends a new message to the newest page', () => {
    const next = applyManagerMessage(pages(page([userMessage(5)]), page([userMessage(1)])), userMessage(6))
    expect(next?.pages[0]?.messages.map((m) => m.seq)).toEqual([5, 6])
  })

  it('does not seed an unfetched chat', () => {
    expect(applyManagerMessage(undefined, userMessage(1))).toBeUndefined()
  })
})

describe('managerChat', () => {
  it('orders by seq across pages', () => {
    const chat = managerChat(pages(page([userMessage(4), userMessage(5)]), page([userMessage(1), userMessage(2)])))
    expect(chat.map((m) => m.seq)).toEqual([1, 2, 4, 5])
  })
})

describe('applyManagerEvent', () => {
  let client: QueryClient
  beforeEach(() => {
    client = new QueryClient()
  })

  it('folds a message frame into a fetched chat', () => {
    client.setQueryData(managerKeys.messages('g'), pages(page([userMessage(1)])))
    applyManagerEvent(client, 'manager-message', JSON.stringify({ managerId: 'g', message: userMessage(2) }))
    expect(managerChat(client.getQueryData(managerKeys.messages('g')))).toHaveLength(2)
  })

  it('drops malformed and invalid frames', () => {
    client.setQueryData(managerKeys.list, { managers: [] })
    applyManagerEvent(client, 'manager-change', 'not json')
    applyManagerEvent(client, 'manager-change', JSON.stringify({ nope: 1 }))
    applyManagerEvent(client, 'manager-message', JSON.stringify({ managerId: 'g' }))
    expect(client.getQueryData(managerKeys.list)).toEqual({ managers: [] })
  })

  it('drops the chat with a deleted manager', () => {
    client.setQueryData(managerKeys.list, { managers: [managerFixture()] })
    client.setQueryData(managerKeys.messages('global'), pages(page([])))
    applyManagerEvent(client, 'manager-change', JSON.stringify({ id: 'global', deleted: true }))
    expect(client.getQueryData(managerKeys.list)).toEqual({ managers: [] })
    expect(client.getQueryData(managerKeys.messages('global'))).toBeUndefined()
  })

  it('re-reads the chat when a turn ends: a frame may have raced the page fetch', () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    client.setQueryData(managerKeys.list, { managers: [managerFixture({ status: 'working' })] })
    applyManagerEvent(client, 'manager-change', JSON.stringify({ id: 'global', manager: managerFixture({ status: 'working', unread: 1 }) }))
    expect(invalidate).not.toHaveBeenCalled()
    applyManagerEvent(client, 'manager-change', JSON.stringify({ id: 'global', manager: managerFixture() }))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: managerKeys.messages('global') })
  })
})

describe('orderManagers', () => {
  it('leads with the most recent activity, falling back to creation', () => {
    const ordered = orderManagers([
      managerFixture({ id: 'old', lastActivityAt: '2026-10-01T00:00:00Z' }),
      managerFixture({ id: 'new', lastActivityAt: '2026-10-31T00:00:00Z' }),
      managerFixture({ id: 'fresh', createdAt: '2026-10-15T00:00:00Z' }),
    ])
    expect(ordered.map((m) => m.id)).toEqual(['new', 'fresh', 'old'])
  })
})

describe('managersNeedAttention', () => {
  it('fires on unread or a pending approval', () => {
    expect(managersNeedAttention(undefined)).toBe(false)
    expect(managersNeedAttention([managerFixture()])).toBe(false)
    expect(managersNeedAttention([managerFixture({ unread: 1 })])).toBe(true)
    expect(managersNeedAttention([managerFixture({ pendingActions: 1 })])).toBe(true)
  })
})

describe('client', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  const answer = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('refuses a send whose attachments the server did not keep, so the composer restores the draft', async () => {
    const images = [{ uploadId: 'a'.repeat(24) }]
    fetchMock.mockResolvedValueOnce(answer({ ok: true }))
    await expect(sendManagerMessage('g', 'look', images)).rejects.toThrow('Restart cezar')
    fetchMock.mockResolvedValueOnce(answer({ ok: true, attachments: 1 }))
    await expect(sendManagerMessage('g', 'look', images)).resolves.toMatchObject({ attachments: 1 })
  })

  it('needs no proof for a message with no files', async () => {
    fetchMock.mockResolvedValueOnce(answer({ ok: true }))
    await expect(sendManagerMessage('g', 'hi')).resolves.toBeTruthy()
  })

  it('posts a create and validates the summary', async () => {
    fetchMock.mockResolvedValue(answer(managerFixture()))
    const manager = await createManager({ instructions: 'x', projects: 'all' })
    expect(manager.id).toBe('global')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/v1/workspace/managers')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ instructions: 'x', projects: 'all' })
  })

  it('pages with before + limit', async () => {
    fetchMock.mockResolvedValue(answer({ messages: [], hasMore: false }))
    await getManagerMessages('global', 7)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/workspace/managers/global/messages?limit=50&before=7')
  })

  it('says the server\'s own refusal', async () => {
    fetchMock.mockResolvedValueOnce(answer({ error: 'nope' }, 409))
    await expect(decideManagerAction('g', 'a1', 'approve')).rejects.toThrow('nope')
  })
})
