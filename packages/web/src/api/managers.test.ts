import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

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
  mergeNewestPage,
  orderManagers,
  refreshManagerChats,
  resetManagerStreams,
  trimManagerChat,
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

  it('marks a chat nobody shows stale when a turn ends, without fetching it', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    onTestFinished(() => { vi.unstubAllGlobals() })
    client.setQueryData(managerKeys.list, { managers: [managerFixture({ status: 'working' })] })
    client.setQueryData(managerKeys.messages('global'), pages(page([userMessage(1)])))
    applyManagerEvent(client, 'manager-change', JSON.stringify({ id: 'global', manager: managerFixture({ status: 'working', unread: 1 }) }))
    expect(client.getQueryState(managerKeys.messages('global'))?.isInvalidated).toBe(false)
    applyManagerEvent(client, 'manager-change', JSON.stringify({ id: 'global', manager: managerFixture() }))
    await vi.waitFor(() => expect(client.getQueryState(managerKeys.messages('global'))?.isInvalidated).toBe(true))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('catching a chat up', () => {
  let client: QueryClient
  const fetchMock = vi.fn()
  const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  const urls = () => fetchMock.mock.calls.map(([url]) => String(url))
  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
    resetManagerStreams()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  /** Three loaded pages, newest first, and a mounted chat watching them. */
  function threePages() {
    const data = {
      pages: [page([userMessage(101), assistantMessage(102, { text: 'He', streaming: true })], true), page([userMessage(51)], true), page([userMessage(1)], false)],
      pageParams: [undefined, 52, 2],
    }
    client.setQueryData(managerKeys.messages('global'), data)
    const observer = new InfiniteQueryObserver(client, {
      queryKey: managerKeys.messages('global'),
      queryFn: () => Promise.reject(new Error('no page fetch expected')),
      initialPageParam: undefined as number | undefined,
      getNextPageParam: () => undefined,
      staleTime: Infinity,
    })
    onTestFinished(observer.subscribe(() => {}))
    return data
  }

  it('re-reads only the newest page when a turn ends, keeping the older ones and unchanged rows', async () => {
    const data = threePages()
    const settled = assistantMessage(102, { text: 'Hello', streaming: false })
    fetchMock.mockResolvedValueOnce(answer({ messages: [userMessage(101), settled, userMessage(103, 'new')], hasMore: true }))
    client.setQueryData(managerKeys.list, { managers: [managerFixture({ status: 'working' })] })
    applyManagerEvent(client, 'manager-change', JSON.stringify({ id: 'global', manager: managerFixture() }))
    await vi.waitFor(() => expect(managerChat(client.getQueryData(managerKeys.messages('global')))).toHaveLength(5))
    expect(urls()).toEqual(['/api/v1/workspace/managers/global/messages?limit=50'])
    const next = client.getQueryData<typeof data>(managerKeys.messages('global'))!
    expect(next.pages).toHaveLength(3)
    expect(next.pages[1]).toBe(data.pages[1])
    expect(next.pages[0]!.messages[0]).toBe(data.pages[0]!.messages[0])
    expect(managerChat(next).find((m) => m.id === 'm102')).toMatchObject({ text: 'Hello', streaming: false })
  })

  it('catches every cached chat up with one request each on a reconnect', async () => {
    threePages()
    client.setQueryData(managerKeys.messages('idle'), pages(page([userMessage(1)])))
    fetchMock.mockResolvedValue(answer({ messages: [userMessage(101)], hasMore: true }))
    await refreshManagerChats(client)
    expect(urls()).toEqual(['/api/v1/workspace/managers/global/messages?limit=50'])
    expect(client.getQueryState(managerKeys.messages('idle'))?.isInvalidated).toBe(true)
    expect(client.getQueryState(managerKeys.messages('global'))?.isInvalidated).toBe(false)
  })

  it('never flips a settled reply back to streaming from a page read before the settle', async () => {
    threePages()
    let land!: (response: Response) => void
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { land = resolve }))
    const refresh = refreshManagerChats(client)
    applyManagerEvent(client, 'manager-message', JSON.stringify({ managerId: 'global', message: assistantMessage(102, { text: 'Hello!', streaming: false }) }))
    land(answer({ messages: [assistantMessage(102, { text: 'Hel', streaming: true })], hasMore: true }))
    await refresh
    expect(managerChat(client.getQueryData(managerKeys.messages('global'))).find((m) => m.id === 'm102')).toMatchObject({ text: 'Hello!', streaming: false })
  })

  it('keeps the longer streamed text when deltas outran the page', async () => {
    threePages()
    let land!: (response: Response) => void
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { land = resolve }))
    const refresh = refreshManagerChats(client)
    applyManagerEvent(client, 'manager-delta', JSON.stringify({ managerId: 'global', messageId: 'm102', offset: 2, append: 'llo' }))
    land(answer({ messages: [assistantMessage(102, { text: 'He', streaming: true })], hasMore: true }))
    await refresh
    expect(managerChat(client.getQueryData(managerKeys.messages('global'))).find((m) => m.id === 'm102')).toMatchObject({ text: 'Hello', streaming: true })
  })
})

describe('mergeNewestPage', () => {
  it('starts over from the fresh page when it shares no row with a chat that has more', () => {
    const fresh = page([userMessage(200), userMessage(201)], true)
    expect(mergeNewestPage(pages(page([userMessage(1)]), page([userMessage(0)])), fresh)).toEqual({ pages: [fresh], pageParams: [undefined] })
  })

  it('never seeds a chat nobody fetched', () => {
    expect(mergeNewestPage(undefined, page([userMessage(1)]))).toBeUndefined()
  })
})

describe('trimManagerChat', () => {
  it('keeps only the newest page, and leaves a one-page chat as it is', () => {
    const client = new QueryClient()
    const one = pages(page([userMessage(1)]))
    client.setQueryData(managerKeys.messages('a'), one)
    trimManagerChat(client, 'a')
    expect(client.getQueryData(managerKeys.messages('a'))).toBe(one)
    client.setQueryData(managerKeys.messages('b'), { pages: [page([userMessage(9)], true), page([userMessage(1)])], pageParams: [undefined, 9] })
    trimManagerChat(client, 'b')
    expect(client.getQueryData(managerKeys.messages('b'))).toEqual({ pages: [page([userMessage(9)], true)], pageParams: [undefined] })
  })
})

describe('streaming deltas', () => {
  let client: QueryClient
  const fetchMock = vi.fn()
  beforeEach(() => {
    client = new QueryClient()
    resetManagerStreams()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  type Frame = { name: 'manager-message' | 'manager-delta'; data: string }
  const full = (text: string, streaming = true): Frame => ({
    name: 'manager-message',
    data: JSON.stringify({ managerId: 'g', message: assistantMessage(2, { text, streaming }) }),
  })
  const delta = (offset: number, append: string): Frame => ({
    name: 'manager-delta',
    data: JSON.stringify({ managerId: 'g', messageId: 'm2', offset, append }),
  })
  const chatText = () => managerChat(client.getQueryData(managerKeys.messages('g'))).map((m) => ('text' in m ? m.text : ''))
  const reply = () => managerChat(client.getQueryData(managerKeys.messages('g'))).find((m) => m.id === 'm2')

  /** What the server sends for one reply: deltas, a keyframe when it doubles, one rewrite, the settle. */
  function script(): { frames: Frame[]; states: string[] } {
    const frames: Frame[] = [full('')]
    const states = ['']
    let text = ''
    let keyframe = 0
    for (let index = 0; index < 60; index += 1) {
      const next = index === 30 ? `${text.slice(0, -3)}[redacted]` : `${text}chunk ${index} `
      if (!next.startsWith(text) || next.length >= Math.max(keyframe * 2, 64)) {
        keyframe = next.length
        frames.push(full(next))
      } else frames.push(delta(text.length, next.slice(text.length)))
      text = next
      states.push(text)
    }
    frames.push(full(`${text}done`, false))
    states.push(`${text}done`)
    return { frames, states }
  }

  it('grows a fetched streaming reply and lets the settle frame replace it', () => {
    client.setQueryData(managerKeys.messages('g'), pages(page([userMessage(1)])))
    for (const frame of [full(''), delta(0, 'Hel'), delta(3, 'lo')]) applyManagerEvent(client, frame.name, frame.data)
    expect(chatText()).toEqual(['jak progres prac', 'Hello'])
    applyManagerEvent(client, 'manager-delta', JSON.stringify({ managerId: 'g', messageId: 'm2', offset: 5, append: '', commands: [{ id: 'c', tool: 'Bash', summary: 'ls' }] }))
    expect(reply()).toMatchObject({ commands: [{ summary: 'ls' }] })
    applyManagerEvent(client, ...Object.values(full('Hello!', false)) as [Frame['name'], string])
    expect(reply()).toMatchObject({ text: 'Hello!', streaming: false })
  })

  it('grows a streaming reply it only knows from the cache', () => {
    client.setQueryData(managerKeys.messages('g'), pages(page([assistantMessage(2, { text: 'He', streaming: true })])))
    applyManagerEvent(client, ...Object.values(delta(2, 'llo')) as [Frame['name'], string])
    expect(reply()).toMatchObject({ text: 'Hello', streaming: true })
  })

  it('applies a repeated delta once', () => {
    client.setQueryData(managerKeys.messages('g'), pages(page([])))
    for (const frame of [full(''), delta(0, 'ab'), delta(0, 'ab'), delta(2, 'c')]) applyManagerEvent(client, frame.name, frame.data)
    expect(reply()).toMatchObject({ text: 'abc' })
  })

  it('converges to the exact final transcript from a reconnect at any point', async () => {
    const { frames, states } = script()
    // Lost frames [cut, back); the reconnect's fetch reads the server at `readAt` and lands after `landsAt`.
    for (let cut = 1; cut < frames.length; cut += 3) {
      for (const [gap, race] of [[2, 0], [5, 3], [9, 9]] as const) {
        resetManagerStreams()
        client = new QueryClient()
        client.setQueryData(managerKeys.messages('g'), pages(page([])))
        const back = Math.min(cut + gap, frames.length)
        const readAt = back
        const landsAt = Math.min(back + race, frames.length)
        frames.slice(0, cut).forEach((frame) => applyManagerEvent(client, frame.name, frame.data))
        const server = states[readAt - 1]!
        const settled = readAt === frames.length
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ messages: [assistantMessage(2, { text: server, streaming: !settled })], hasMore: false })))
        const fetched = getManagerMessages('g', undefined)
        for (const frame of frames.slice(back, landsAt)) applyManagerEvent(client, frame.name, frame.data)
        client.setQueryData(managerKeys.messages('g'), pages(await fetched))
        for (let at = landsAt; at < frames.length; at += 1) {
          applyManagerEvent(client, frames[at]!.name, frames[at]!.data)
          // Never a duplicated or foreign character: whatever shows is a state the server had.
          expect(states, `cut ${cut} gap ${gap} race ${race} at ${at}`).toContain((reply() as { text: string }).text)
        }
        expect(reply(), `cut ${cut} gap ${gap} race ${race}`).toMatchObject({ text: states.at(-1), streaming: false })
      }
    }
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
