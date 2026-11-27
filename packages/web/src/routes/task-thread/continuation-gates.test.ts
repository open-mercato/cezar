import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ApiRun } from '@open-mercato/cezar-api-client'

import { useActiveProviderAvailability, useExistingProviderAvailability } from './active-provider'
import { useContinuationProvider } from './continuation-provider'

/**
 * #719 — the loading posture of the closed-run gates: optimistic while provider status loads
 * (the live-run gate's posture; the server's `/continue` is the boundary), blocked once it
 * answers, and never a guessed runner override while the answer is unknown.
 */

const run = { id: 'r1', title: 't', workflow: 'quick-task', task: 't', status: 'review', runner: 'codex',
  createdAt: '2026-07-24T00:00:00.000Z', tokensUsed: 0, archived: false, steps: [] } as ApiRun

const providers = (codex: 'connected' | 'disconnected') => ({
  providers: [
    { provider: 'claude', status: 'connected', enabled: true },
    { provider: 'codex', status: codex, enabled: true },
  ],
})

/** Provider status held open until `settle` is called. */
function stubStatus() {
  let settle!: (response: Response) => void
  const held = new Promise<Response>((resolve) => { settle = resolve })
  vi.stubGlobal('fetch', vi.fn(async (url) => String(url).endsWith('/providers/status')
    ? held : Response.json({}, { status: 404 })))
  return (body: unknown, status = 200) =>
    settle(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
}

function renderGates(record = run) {
  const client = createQueryClient()
  return renderHook(
    () => ({ continuation: useContinuationProvider(record), ask: useExistingProviderAvailability(record), live: useActiveProviderAvailability(record) }),
    { wrapper: ({ children }) => createElement(QueryClientProvider, { client }, children) },
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('closed-run provider gates while status loads (#719)', () => {
  it('first paint: Continue and the ask answer are usable and send no runner override', () => {
    stubStatus()
    const { result } = renderGates()
    expect(result.current.continuation).toMatchObject({ canContinue: true, providerPending: true, runnerOverride: undefined })
    expect(result.current.ask).toEqual({ provider: 'codex', usable: true })
  })

  it('resolved with the recorded runner connected: still usable, still no override', async () => {
    const settle = stubStatus()
    const { result } = renderGates()
    settle(providers('connected'))
    await waitFor(() => expect(result.current.continuation.providerPending).toBe(false))
    expect(result.current.continuation).toMatchObject({ canContinue: true, runnerOverride: undefined })
    expect(result.current.ask.usable).toBe(true)
  })

  it('resolved with the recorded runner gone: the ask blocks, Continue falls back explicitly', async () => {
    const settle = stubStatus()
    const { result } = renderGates()
    settle(providers('disconnected'))
    await waitFor(() => expect(result.current.ask.usable).toBe(false))
    expect(result.current.ask.reason).toContain('Codex credentials are unavailable')
    expect(result.current.continuation).toMatchObject({ canContinue: true, runnerOverride: 'claude' })
  })

  it('a failed status query blocks both', async () => {
    const settle = stubStatus()
    const { result } = renderGates()
    settle({ error: 'boom' }, 404)
    await waitFor(() => expect(result.current.continuation.canContinue).toBe(false))
    expect(result.current.continuation.reason).toBe('Provider authentication could not be verified.')
    expect(result.current.ask).toMatchObject({ usable: false, reason: 'Provider authentication could not be verified.' })
  })
})

it.each(['connected', 'disconnected'] as const)('keeps the recorded gateway on Continue, Ask and live delivery when the gateway is %s', async (state) => {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (String(url).endsWith('/providers/status')) return Response.json(providers('disconnected'))
    if (String(url).endsWith('/agent-providers')) return Response.json({ editable: true, agents: [
      { runner: 'codex', mode: 'one', active: 'subscription', configured: true,
        methods: [{ id: 'custom', kind: 'custom', label: 'Recorded gateway', state }] },
    ] })
    return Response.json({}, { status: 404 })
  }))
  const { result } = renderGates({ ...run, steps: [
    { id: 'run', name: 'Run', status: 'done', kind: 'agent', iterations: 1, tokensUsed: 0, backend: 'codex', agentMethod: 'custom' },
  ] })
  await waitFor(() => expect(result.current.continuation.providerPending).toBe(false))
  expect(result.current.continuation).toMatchObject({ runner: 'codex', canContinue: true, runnerOverride: undefined })
  expect(result.current.ask.usable).toBe(true)
  expect(result.current.live.usable).toBe(true)
})

it.each([{ enabled: false, status: 'connected' }, { enabled: true, status: 'not-installed' }] as const)(
  'cannot replay a gateway when the CLI is disabled or missing (%j)', async row => {
    const settle = stubStatus()
    const { result } = renderGates({ ...run, agentMethod: 'custom' })
    settle({ providers: [{ ...row, provider: 'codex' }] })
    await waitFor(() => expect(result.current.continuation.providerPending).toBe(false))
    expect(result.current.continuation.canContinue).toBe(false)
    expect(result.current.ask.usable).toBe(false)
    expect(result.current.live.usable).toBe(false)
  },
)

it('checks the run project’s subscription account from a cross-project view', async () => {
  vi.stubGlobal('fetch', vi.fn(async url => {
    const path = String(url)
    if (path.endsWith('/providers/status')) return Response.json(providers('disconnected'))
    if (path.endsWith('/p/other/repo')) return Response.json({ info: { root: '/other' } })
    if (path.endsWith('/workspace/agent-profiles')) return Response.json({
      profiles: [{ provider: 'codex', id: 'work', label: 'Work', isDefault: false, status: { provider: 'codex', status: 'connected' } }],
      selections: { '/other': { codex: 'work' } },
    })
    if (path.endsWith('/agent-providers')) return Response.json({ editable: false, agents: [{
      runner: 'codex', mode: 'one', active: 'subscription', configured: true,
      methods: [{ id: 'subscription', kind: 'subscription', label: 'Subscription', state: 'disconnected' }],
    }] })
    return Response.json({}, { status: 404 })
  }))
  const client = createQueryClient()
  const { result } = renderHook(() => useExistingProviderAvailability(run, 'other'), {
    wrapper: ({ children }) => createElement(QueryClientProvider, { client }, children),
  })
  await waitFor(() => {
    expect(client.getQueryState(['other', 'repo'])?.status).toBe('success')
    expect(client.isFetching()).toBe(0)
    expect(result.current.usable).toBe(true)
  })
})
