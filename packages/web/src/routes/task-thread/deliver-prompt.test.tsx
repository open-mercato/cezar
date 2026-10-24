import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ApiRun, RunStatus } from '@open-mercato/cezar-api-client'

import { trackMessageSent } from '@/lib/telemetry'

import { SESSION_GAP_RETRY_DELAYS_MS, deliveryPath, useDeliverPrompt } from './deliver-prompt'
import { useContinueAction } from './follow-up-engine'

vi.mock('@/lib/telemetry', () => ({ trackMessageSent: vi.fn() }))

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
async function renderDeliver(
  record: ApiRun,
  overrides: Record<string, () => Response> = {},
  wait: (delayMs: number) => Promise<void> = async () => {},
  surface?: 'existing_session' | 'review' | null,
) {
  const sent = stubFetch(overrides)
  const client = createQueryClient()
  const view = renderHook(
    () => {
      const action = useContinueAction(record)
      return { action, deliver: useDeliverPrompt(record, action.continueWith, surface === undefined ? { wait } : { wait, surface }) }
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
  vi.mocked(trackMessageSent).mockClear()
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

  it('telemetry 77117b95: an empty one-click Continue on a run that is already live succeeds silently', async () => {
    const { sent, client, deliver } = await renderDeliver(run('done'), {
      'POST /api/v1/runs/r1/continue': () => jsonResponse({ error: 'run is still active' }, 409),
      'GET /api/v1/runs/r1': () => jsonResponse(run('running')),
    })

    // Nothing to continue: the run the click asked for is ALREADY live, so this is the state the
    // user wanted, not a failure. Resolving (rather than throwing "run is still active") is what
    // stops the cockpit toasting an error for a task that is simply already under way.
    await expect(deliver('')).resolves.toBeUndefined()
    // Nothing was delivered on the live path either — an empty message is not a message.
    expect(posts(sent, '/api/v1/runs/r1/messages')).toHaveLength(0)
    // The refetch ran and healed the cache the thread reads.
    expect(sent.filter((r) => r.method === 'GET' && r.path === '/api/v1/runs/r1')).toHaveLength(1)
    expect(client.getQueryData<ApiRun>(['default', 'runs', 'detail', 'r1'])?.status).toBe('running')
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

  /** Answers from `responses` in order, repeating the last one. */
  const sequence = (...responses: Array<() => Response>) => {
    let call = 0
    return () => responses[Math.min(call++, responses.length - 1)]!()
  }

  it('telemetry 1408d7cb: a session that closed while the run settles waits for Continue instead of failing', async () => {
    const waits: number[] = []
    const { sent, deliver } = await renderDeliver(
      run('running'),
      {
        'POST /api/v1/runs/r1/messages': () => jsonResponse({ error: 'session closed' }, 409),
        // Still `running` while the engine settles the record, then parked at review.
        'GET /api/v1/runs/r1': sequence(() => jsonResponse(run('running')), () => jsonResponse(run('review'))),
        'POST /api/v1/runs/r1/continue': () => jsonResponse({ continued: true }),
      },
      async (delayMs) => {
        waits.push(delayMs)
      },
    )

    await expect(deliver('carry on')).resolves.toBeTruthy()

    expect(waits).toEqual([SESSION_GAP_RETRY_DELAYS_MS[0]])
    expect(posts(sent, '/api/v1/runs/r1/messages')).toHaveLength(2)
    expect(posts(sent, '/api/v1/runs/r1/continue')[0]?.body).toMatchObject({ text: 'carry on' })
  })

  it('a message sent between two workflow steps reaches the next step’s session', async () => {
    const { sent, deliver } = await renderDeliver(run('running'), {
      'POST /api/v1/runs/r1/messages': sequence(
        () => jsonResponse({ error: 'session closed' }, 409),
        () => jsonResponse({ delivered: true }),
      ),
      'GET /api/v1/runs/r1': () => jsonResponse(run('running')),
    })

    await expect(deliver('carry on')).resolves.toBeTruthy()
    expect(posts(sent, '/api/v1/runs/r1/messages')).toHaveLength(2)
    expect(posts(sent, '/api/v1/runs/r1/continue')).toHaveLength(0)
  })

  it('the wait is bounded: a run that never settles reports the refusal', async () => {
    const waits: number[] = []
    const { sent, deliver } = await renderDeliver(
      run('running'),
      {
        'POST /api/v1/runs/r1/messages': () => jsonResponse({ error: 'session closed' }, 409),
        'GET /api/v1/runs/r1': () => jsonResponse(run('running')),
      },
      async (delayMs) => {
        waits.push(delayMs)
      },
    )

    await expect(deliver('carry on')).rejects.toThrow('session closed')
    expect(waits).toEqual([...SESSION_GAP_RETRY_DELAYS_MS])
    expect(posts(sent, '/api/v1/runs/r1/messages')).toHaveLength(SESSION_GAP_RETRY_DELAYS_MS.length + 1)
    expect(posts(sent, '/api/v1/runs/r1/continue')).toHaveLength(0)
  })

  it('telemetry 77117b95: a Continue refused while a settled run still unwinds waits for it to let go', async () => {
    const waits: number[] = []
    // The record already says `review` — the engine settles it BEFORE the turn-end autosave drops
    // the run — so the fresh record agrees with the Continue path while the server still refuses it.
    const { sent, deliver } = await renderDeliver(
      run('review'),
      {
        'POST /api/v1/runs/r1/continue': sequence(
          () => jsonResponse({ error: 'run is still active' }, 409),
          () => jsonResponse({ error: 'run is still active' }, 409),
          () => jsonResponse({ continued: true }),
        ),
        'GET /api/v1/runs/r1': () => jsonResponse(run('review')),
      },
      async (delayMs) => {
        waits.push(delayMs)
      },
    )

    await expect(deliver('one more fix')).resolves.toBeTruthy()
    expect(waits).toEqual([SESSION_GAP_RETRY_DELAYS_MS[0], SESSION_GAP_RETRY_DELAYS_MS[1]])
    expect(posts(sent, '/api/v1/runs/r1/continue')).toHaveLength(3)
    expect(posts(sent, '/api/v1/runs/r1/messages')).toHaveLength(0)
  })

  it('the unwinding wait is bounded too: a run that never lets go reports the refusal', async () => {
    const waits: number[] = []
    const { sent, deliver } = await renderDeliver(
      run('review'),
      {
        'POST /api/v1/runs/r1/continue': () => jsonResponse({ error: 'run is still active' }, 409),
        'GET /api/v1/runs/r1': () => jsonResponse(run('review')),
      },
      async (delayMs) => {
        waits.push(delayMs)
      },
    )

    await expect(deliver('one more fix')).rejects.toThrow('run is still active')
    expect(waits).toEqual([...SESSION_GAP_RETRY_DELAYS_MS])
    expect(posts(sent, '/api/v1/runs/r1/continue')).toHaveLength(SESSION_GAP_RETRY_DELAYS_MS.length + 1)
  })

  /** What `fetch` throws when the request got no answer — WebKit's `Load failed`. */
  const unreachable = () => {
    throw new TypeError('Load failed')
  }

  it('telemetry 7adbfbd7: a Continue that got no answer is re-posted once when the record proves it never landed', async () => {
    const { sent, deliver } = await renderDeliver(run('review'), {
      'POST /api/v1/runs/r1/continue': sequence(unreachable, () => jsonResponse({ continued: true })),
      'GET /api/v1/runs/r1': () => jsonResponse(run('review')),
    })

    await expect(deliver('one more fix')).resolves.toBeTruthy()
    expect(posts(sent, '/api/v1/runs/r1/continue')).toHaveLength(2)
  })

  it('a lost Continue the record shows as landed is never re-posted', async () => {
    const landed = run('review', {
      steps: [
        ...run('review').steps,
        { id: 'continue-1', name: 'Continue', kind: 'agent', status: 'pending', iterations: 0, tokensUsed: 0 },
      ] as ApiRun['steps'],
    })
    const { sent, deliver } = await renderDeliver(run('review'), {
      'POST /api/v1/runs/r1/continue': unreachable,
      'GET /api/v1/runs/r1': () => jsonResponse(landed),
    })

    await expect(deliver('one more fix')).rejects.toThrow('cannot reach the cezar server')
    expect(posts(sent, '/api/v1/runs/r1/continue')).toHaveLength(1)
    expect(posts(sent, '/api/v1/runs/r1/messages')).toHaveLength(0)
  })

  it('a lost Continue is not re-posted when the server cannot answer the refetch either', async () => {
    const { sent, deliver } = await renderDeliver(run('review'), {
      'POST /api/v1/runs/r1/continue': unreachable,
      'GET /api/v1/runs/r1': unreachable,
    })

    await expect(deliver('one more fix')).rejects.toThrow('cannot reach the cezar server')
    expect(posts(sent, '/api/v1/runs/r1/continue')).toHaveLength(1)
  })

  it('a lost live message is never re-posted — nothing proves it did not land', async () => {
    const { sent, deliver } = await renderDeliver(run('waiting'), {
      'POST /api/v1/runs/r1/messages': unreachable,
      'GET /api/v1/runs/r1': () => jsonResponse(run('waiting')),
    })

    await expect(deliver('hello')).rejects.toThrow('cannot reach the cezar server')
    expect(posts(sent, '/api/v1/runs/r1/messages')).toHaveLength(1)
    expect(sent.filter((r) => r.method === 'GET' && r.path === '/api/v1/runs/r1')).toHaveLength(0)
  })

  it('a different live 409 the fresh record agrees with is not retried', async () => {
    const { sent, deliver } = await renderDeliver(run('running'), {
      'POST /api/v1/runs/r1/messages': () =>
        jsonResponse({ error: 'Claude Code is disabled. Enable it in Settings → Agents → Providers.' }, 409),
      'GET /api/v1/runs/r1': () => jsonResponse(run('running')),
    })

    await expect(deliver('go on')).rejects.toThrow('Claude Code is disabled')
    expect(posts(sent, '/api/v1/runs/r1/messages')).toHaveLength(1)
  })

  it('a non-409 failure is reported as it comes — no refetch, no second attempt', async () => {
    const { sent, deliver } = await renderDeliver(run('running'), {
      'POST /api/v1/runs/r1/messages': () => jsonResponse({ error: 'agent crashed' }, 500),
    })

    await expect(deliver('carry on')).rejects.toThrow('agent crashed')
    expect(sent.filter((r) => r.method === 'GET' && r.path === '/api/v1/runs/r1')).toHaveLength(0)
    expect(posts(sent, '/api/v1/runs/r1/messages')).toHaveLength(1)
  })

  it('counts a landed delivery under its surface, and nothing when the caller opts out (#1473 review)', async () => {
    const counted = await renderDeliver(run('waiting'))
    await counted.deliver('hello')
    expect(trackMessageSent).toHaveBeenCalledWith('existing_session')

    vi.mocked(trackMessageSent).mockClear()
    cleanup()
    const review = await renderDeliver(run('waiting'), {}, undefined, 'review')
    await review.deliver('notes')
    expect(trackMessageSent).toHaveBeenCalledWith('review')

    vi.mocked(trackMessageSent).mockClear()
    cleanup()
    // The footer's one-click Continue: delivered, but never a `message_sent`.
    const footer = await renderDeliver(run('done'), {}, undefined, null)
    await footer.deliver('')
    expect(trackMessageSent).not.toHaveBeenCalled()
  })
})
