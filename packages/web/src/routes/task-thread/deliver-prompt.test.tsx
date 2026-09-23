import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ApiRun, RunStatus } from '@open-mercato/cezar-api-client'

import { deliveryPath, useDeliverPrompt } from './deliver-prompt'
import { useContinueAction } from './follow-up-engine'

/**
 * The composer's delivery recovery (deliver-prompt.ts).
 *
 * The bug it exists for: the thread's record can drift from the run the server actually has — a
 * workspace-stream update lost on a half-open socket, and nothing refetches it (no polling, a
 * five-minute staleTime, no refetch on focus). The composer then posts to the endpoint the stale
 * record names, the server answers 409, and the prompt bounces back into the draft. Re-sending
 * aims by the same stale record, so only a page reload used to fix it.
 *
 * These drive the REAL hooks against a stubbed server, because the whole behaviour is which
 * request goes out second.
 */

const run = (status: RunStatus, extra: Partial<ApiRun> = {}): ApiRun =>
  ({
    id: 'r1',
    title: 'do the thing',
    workflow: 'quick-task',
    task: 'Summarize what this project does.',
    status,
    createdAt: '2026-07-14T12:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [
      { id: 'task', name: 'Do the task', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, sessionId: 'sess-1' },
    ],
    ...extra,
  }) as ApiRun

interface SentRequest {
  path: string
  method: string
  body: unknown
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Records every request; `overrides` are keyed `METHOD path` and may answer differently per call
 *  (the queue form), which is how a first 409 is followed by nothing at all. */
function stubFetch(overrides: Record<string, () => Response> = {}): SentRequest[] {
  const sent: SentRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const method = init.method ?? 'GET'
      sent.push({ path, method, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined })
      const override = overrides[`${method} ${path}`]
      if (override) return override()
      if (method === 'GET' && path === '/api/v1/providers/status') {
        return jsonResponse({
          providers: [
            { provider: 'claude', status: 'connected', enabled: true },
            { provider: 'codex', status: 'not-installed', enabled: true },
            { provider: 'opencode', status: 'not-installed', enabled: true },
          ],
        })
      }
      return jsonResponse({})
    }),
  )
  return sent
}

/** The two hooks the thread wires together, driven from one harness. */
async function renderDeliver(record: ApiRun, overrides: Record<string, () => Response> = {}) {
  const sent = stubFetch(overrides)
  const client = createQueryClient()
  const view = renderHook(
    () => {
      const action = useContinueAction(record)
      return { action, deliver: useDeliverPrompt(record, action) }
    },
    {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    },
  )
  // Provider discovery gates `continueWith`; wait for it so a rejection can only be the server's.
  await waitFor(() => expect(view.result.current.action.canContinue).toBe(true))
  return { sent, client, deliver: (text: string) => view.result.current.deliver(text, []) }
}

const posts = (sent: SentRequest[], path: string) =>
  sent.filter((request) => request.method === 'POST' && request.path === path)

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('deliveryPath', () => {
  it('a live or queued run takes the message endpoint', () => {
    expect(deliveryPath('running')).toBe('live')
    expect(deliveryPath('waiting')).toBe('live')
    // A queued run folds the message into its prompt (#472) — the same POST /messages.
    expect(deliveryPath('queued')).toBe('live')
  })

  it('every settled status takes Continue', () => {
    for (const status of ['done', 'failed', 'cancelled', 'review'] as const) {
      expect(deliveryPath(status)).toBe('continue')
    }
  })
})

describe('useDeliverPrompt', () => {
  it('the reported bug: a thread that reads as done, over a run that is running', async () => {
    const { sent, deliver } = await renderDeliver(run('done'), {
      'POST /api/v1/runs/r1/continue': () => jsonResponse({ error: 'run is still active' }, 409),
      'GET /api/v1/runs/r1': () => jsonResponse(run('running')),
      'POST /api/v1/runs/r1/messages': () => jsonResponse({ delivered: true }),
    })

    await expect(deliver('one more thing')).resolves.toBeTruthy()

    // The prompt reached the live session rather than bouncing back into the draft…
    expect(posts(sent, '/api/v1/runs/r1/messages')[0]?.body).toMatchObject({ text: 'one more thing' })
    // …and it took exactly one authoritative refetch to work out where to send it.
    expect(sent.filter((r) => r.method === 'GET' && r.path === '/api/v1/runs/r1')).toHaveLength(1)
  })

  it('the refetch heals the cached record, so the thread stops claiming the run is done', async () => {
    const { client, deliver } = await renderDeliver(run('done'), {
      'POST /api/v1/runs/r1/continue': () => jsonResponse({ error: 'run is still active' }, 409),
      'GET /api/v1/runs/r1': () => jsonResponse(run('running')),
      'POST /api/v1/runs/r1/messages': () => jsonResponse({ delivered: true }),
    })

    await deliver('one more thing')

    expect(client.getQueryData<ApiRun>(['default', 'runs', 'detail', 'r1'])?.status).toBe('running')
  })

  it('the mirror: a session that closed under a record still claiming it takes the reply as a Continue', async () => {
    const { sent, deliver } = await renderDeliver(run('running'), {
      'POST /api/v1/runs/r1/messages': () => jsonResponse({ error: 'session closed' }, 409),
      'GET /api/v1/runs/r1': () => jsonResponse(run('done')),
      'POST /api/v1/runs/r1/continue': () => jsonResponse({ continued: true }),
    })

    await expect(deliver('carry on')).resolves.toBeTruthy()

    expect(posts(sent, '/api/v1/runs/r1/continue')[0]?.body).toMatchObject({ text: 'carry on' })
  })

  it('a 409 the fresh record AGREES with is the server’s answer, not a routing mistake', async () => {
    const { sent, deliver } = await renderDeliver(run('done'), {
      'POST /api/v1/runs/r1/continue': () =>
        jsonResponse({ error: 'Claude Code is disabled. Enable it in Settings → Agents → Providers.' }, 409),
      'GET /api/v1/runs/r1': () => jsonResponse(run('done')),
    })

    await expect(deliver('go on')).rejects.toThrow('Claude Code is disabled')
    expect(posts(sent, '/api/v1/runs/r1/messages')).toHaveLength(0)
    expect(posts(sent, '/api/v1/runs/r1/continue')).toHaveLength(1)
  })

  it('an empty submit is a Continue, and a run that is already live has nothing to continue', async () => {
    const { sent, deliver } = await renderDeliver(run('done'), {
      'POST /api/v1/runs/r1/continue': () => jsonResponse({ error: 'run is still active' }, 409),
      'GET /api/v1/runs/r1': () => jsonResponse(run('running')),
    })

    await expect(deliver('')).rejects.toThrow('run is still active')
    // An empty message is not a message: nothing is delivered on the live path either.
    expect(posts(sent, '/api/v1/runs/r1/messages')).toHaveLength(0)
  })

  it('a fresh record with no session to resume keeps the original error', async () => {
    const { sent, deliver } = await renderDeliver(run('running'), {
      'POST /api/v1/runs/r1/messages': () => jsonResponse({ error: 'session closed' }, 409),
      'GET /api/v1/runs/r1': () =>
        jsonResponse(run('failed', { steps: [{ id: 'task', name: 'Do the task', kind: 'agent', status: 'failed', iterations: 1, tokensUsed: 0 }] as ApiRun['steps'] })),
    })

    await expect(deliver('carry on')).rejects.toThrow('session closed')
    expect(posts(sent, '/api/v1/runs/r1/continue')).toHaveLength(0)
  })

  it('a non-409 failure is reported as it comes — no refetch, no second attempt', async () => {
    const { sent, deliver } = await renderDeliver(run('running'), {
      'POST /api/v1/runs/r1/messages': () => jsonResponse({ error: 'agent crashed' }, 500),
    })

    await expect(deliver('carry on')).rejects.toThrow('agent crashed')
    expect(sent.filter((r) => r.method === 'GET' && r.path === '/api/v1/runs/r1')).toHaveLength(0)
    expect(posts(sent, '/api/v1/runs/r1/messages')).toHaveLength(1)
  })
})
