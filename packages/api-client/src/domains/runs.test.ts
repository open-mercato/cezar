import { describe, expect, it, vi } from 'vitest'

import { ApiError, createCezarClient } from '../client.ts'

const RUN = {
  id: 'run-1',
  title: 'Investigate checkout',
  workflow: 'quick-task',
  task: 'Investigate checkout failures.',
  status: 'running',
  createdAt: '2026-08-18T10:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  steps: [],
}

const HISTORY_PAGE = {
  events: [],
  itemCount: 0,
  liveCursor: 'live-cursor',
  asOfSeq: 0,
  hasOlder: false,
}

const HISTORY_CONTEXT = {
  contextEvents: [],
  asOfSeq: 0,
}

describe('CezarRunsDomain', () => {
  it('validates list, history, context, and update responses at the boundary', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json([RUN]))
      .mockResolvedValueOnce(Response.json(HISTORY_PAGE))
      .mockResolvedValueOnce(Response.json(HISTORY_CONTEXT))
      .mockResolvedValueOnce(Response.json({ ...RUN, title: 'Renamed' }))
    const runs = createCezarClient({ baseUrl: 'https://cezar.test', fetch })
      .forProject('project-a').runs

    await expect(runs.list()).resolves.toEqual([RUN])
    await expect(runs.history('run/a')).resolves.toEqual(HISTORY_PAGE)
    await expect(runs.historyContext('run/a')).resolves.toEqual(HISTORY_CONTEXT)
    await expect(runs.update('run/a', { title: 'Renamed' })).resolves.toMatchObject({ title: 'Renamed' })
    expect(fetch.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: (init as RequestInit).method,
      body: (init as RequestInit).body,
    }))).toEqual([
      { url: 'https://cezar.test/api/v1/p/project-a/runs', method: 'GET', body: undefined },
      { url: 'https://cezar.test/api/v1/p/project-a/runs/run%2Fa/history', method: 'GET', body: undefined },
      { url: 'https://cezar.test/api/v1/p/project-a/runs/run%2Fa/history-context', method: 'GET', body: undefined },
      {
        url: 'https://cezar.test/api/v1/p/project-a/runs/run%2Fa',
        method: 'PATCH',
        body: JSON.stringify({ title: 'Renamed' }),
      },
    ])
    expect(createCezarClient({ baseUrl: 'https://cezar.test' }).forProject('project-a').resolveUrl('/api/runs/run-a/images/1'))
      .toBe('https://cezar.test/api/v1/p/project-a/runs/run-a/images/1')
  })

  it('uses the documented paths, verbs, bodies, and response schemas for every other run operation', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json(RUN))
      .mockResolvedValueOnce(Response.json({ archived: 2 }))
      .mockResolvedValueOnce(Response.json({ read: 2 }))
      .mockResolvedValueOnce(Response.json({ ...RUN, seenAt: '2026-08-18T10:01:00.000Z' }))
      .mockResolvedValueOnce(Response.json(RUN))
    const controller = new AbortController()
    const runs = createCezarClient({ baseUrl: 'https://cezar.test', fetch }).forProject('p/a').runs

    await expect(runs.get('run/a', { signal: controller.signal })).resolves.toEqual(RUN)
    await expect(runs.archiveFinished()).resolves.toEqual({ archived: 2 })
    await expect(runs.markAllSeen()).resolves.toEqual({ read: 2 })
    await expect(runs.markSeen('run/a')).resolves.toMatchObject({ seenAt: '2026-08-18T10:01:00.000Z' })
    await expect(runs.markUnseen('run/a')).resolves.toEqual(RUN)

    expect(fetch.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: (init as RequestInit | undefined)?.method,
      body: (init as RequestInit | undefined)?.body,
    }))).toEqual([
      { url: 'https://cezar.test/api/v1/p/p%2Fa/runs/run%2Fa', method: 'GET', body: undefined },
      { url: 'https://cezar.test/api/v1/p/p%2Fa/runs/archive-finished', method: 'POST', body: undefined },
      { url: 'https://cezar.test/api/v1/p/p%2Fa/runs/read-all', method: 'POST', body: undefined },
      { url: 'https://cezar.test/api/v1/p/p%2Fa/runs/run%2Fa/read', method: 'POST', body: undefined },
      { url: 'https://cezar.test/api/v1/p/p%2Fa/runs/run%2Fa/unread', method: 'POST', body: undefined },
    ])
    expect((fetch.mock.calls[0]?.[1] as RequestInit).signal).toBe(controller.signal)
  })

  it('passes a history cursor and read cancellation signal through unchanged', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(HISTORY_PAGE))
    const controller = new AbortController()
    const runs = createCezarClient({ fetch }).forProject(null).runs

    await runs.history('run/a', 'cursor value', { signal: controller.signal })

    expect(fetch.mock.calls[0]?.[0]).toBe('/api/v1/runs/run%2Fa/history?cursor=cursor+value')
    expect((fetch.mock.calls[0]?.[1] as RequestInit).signal).toBe(controller.signal)
  })

  it('normalizes a failed domain response into ApiError', async () => {
    const client = createCezarClient({
      fetch: async () => Response.json({ error: 'expired' }, { status: 401 }),
    })

    await expect(client.forProject(null).runs.list()).rejects.toMatchObject({
      name: 'ApiError',
      status: 401,
      path: '/api/v1/runs',
    })
    await expect(client.forProject(null).runs.list()).rejects.toBeInstanceOf(ApiError)
  })

  it('rejects malformed successful responses instead of returning untrusted data', async () => {
    const client = createCezarClient({ fetch: async () => Response.json({ runs: [] }) })

    await expect(client.forProject(null).runs.list()).rejects.toMatchObject({
      name: 'ApiError',
      status: 200,
      path: '/api/v1/runs',
    })
  })
})
