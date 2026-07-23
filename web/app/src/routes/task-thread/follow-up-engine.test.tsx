import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ApiRun, HealthResponse, StepState } from '@/api/types'
import { resetToasts, Toaster } from '@/components/ui/toaster'

import { useContinueAction } from './follow-up-engine'

/**
 * The follow-up composer's Continue control (#401): the runner + model pills default to the
 * run's current backend, so an untouched Continue posts nothing extra (backward compat); a pick
 * rides through to `POST /continue`; the runner pill is hidden on a single-backend host.
 *
 * The hook has no button of its own — the composer's send is what fires it — so the harness
 * below supplies one, standing in for that send.
 */

beforeAll(() => {
  // Radix scrolls the active item into view; jsdom has neither.
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  cleanup()
  resetToasts()
  vi.unstubAllGlobals()
})

const HEALTH_MULTI: HealthResponse = {
  version: '0.1.5',
  repoRoot: '/repo',
  repo: { root: '/repo', branch: 'main' },
  defaultRunner: 'claude',
  checks: [
    { name: 'claude', available: true },
    { name: 'codex', available: true },
    { name: 'git', available: true },
  ],
  forge: null,
  // `followups` became a required capability in #471 (merged from main): irrelevant to the
  // Continue pills these tests drive, but the shape must be whole.
  capabilities: { localHandoff: true, followups: true },
}

type Recorded = { method: string; url: string; body?: unknown }
let requests: Recorded[]

function serve(health: HealthResponse = HEALTH_MULTI, defaultModels: Record<string, string> = {}) {
  requests = []
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      const method = init.method ?? 'GET'
      const body = init.body ? (JSON.parse(String(init.body)) as unknown) : undefined
      requests.push({ method, url, body })
      if (url === '/api/health') return json(health)
      if (url === '/api/models?runner=codex') return json({ runner: 'codex', models: [{ id: 'gpt-future', label: 'gpt-future', description: 'Newest' }], source: 'live', stale: false })
      if (url === '/api/config' && method === 'GET')
        return json({
          baseBranch: null,
          defaultRunner: 'claude',
          systemPrompt: null,
          defaultModels,
          maxParallel: 1,
          memoryLimitMb: null,
        })
      if (url === '/api/runs' && method === 'GET') return json([])
      if (url.endsWith('/continue') && method === 'POST') return json({ continued: true })
      return json({}, 200)
    }),
  )
}

const step = (extra: Partial<StepState> = {}): StepState => ({
  id: 'task',
  name: 'Do the task',
  kind: 'agent',
  status: 'done',
  iterations: 1,
  tokensUsed: 0,
  ...extra,
})

const makeRun = (extra: Partial<ApiRun> = {}): ApiRun => ({
  id: 'r1',
  title: 'do the thing',
  workflow: 'quick-task',
  task: 'do the thing',
  status: 'done',
  createdAt: '2026-07-16T00:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  runner: 'claude',
  steps: [step({ sessionId: 'sess-1' })],
  ...extra,
})

/** Stands in for the thread composer: the pills, plus a send that submits `draft`. */
function Harness({ run, draft = '' }: { run: ApiRun; draft?: string }) {
  const action = useContinueAction(run)
  if (!action.available) return null
  return (
    <>
      {action.pills}
      <button type="button" onClick={() => void action.continueWith(draft, [])}>
        Continue
      </button>
    </>
  )
}

function renderAction(record: ApiRun, draft?: string) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <Harness run={record} draft={draft} />
      <Toaster />
    </QueryClientProvider>,
  )
}

const continueBody = () =>
  requests.find((r) => r.url.endsWith('/continue') && r.method === 'POST')?.body

describe('follow-up ContinueAction runner/model selection (#401)', () => {
  it('an untouched Continue omits runner & model — the run keeps its backend', async () => {
    serve()
    renderAction(makeRun())
    fireEvent.click(await screen.findByRole('button', { name: /continue/i }))
    await waitFor(() => expect(continueBody()).toBeDefined())
    expect(continueBody()).toEqual({})
  })

  it('carries the composer draft as the prompt the reopened session starts on', async () => {
    serve()
    renderAction(makeRun(), 'now also update the changelog')
    fireEvent.click(await screen.findByRole('button', { name: /continue/i }))
    await waitFor(() => expect(continueBody()).toBeDefined())
    // Only `text` — the pills were never touched, so the run keeps its backend.
    expect(continueBody()).toEqual({ text: 'now also update the changelog' })
  })

  it('sends the chosen runner + model through to /continue', async () => {
    serve()
    renderAction(makeRun())

    // Two backends detected → the runner pill appears; pick codex.
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Runner' }))
    let options = await screen.findAllByRole('menuitemradio')
    fireEvent.click(options.find((o) => o.textContent?.includes('codex')) as HTMLElement)

    // The model pill now lists codex presets; pin one.
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Model' }))
    options = await screen.findAllByRole('menuitemradio')
    fireEvent.click(options.find((o) => o.textContent?.includes('gpt-future')) as HTMLElement)

    fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    await waitFor(() => expect(continueBody()).toBeDefined())
    expect(continueBody()).toEqual({ runner: 'codex', model: 'gpt-future' })
  })

  it('a legacy run (no persisted runner) shows claude — the server continues it on claude, not defaultRunner', async () => {
    serve({ ...HEALTH_MULTI, defaultRunner: 'codex' })
    renderAction(makeRun({ runner: undefined }))
    const pill = await screen.findByRole('button', { name: 'Runner' })
    expect(pill.textContent).toContain('claude')
  })

  it('a model-only pick on a legacy run can only send a claude model — never a codex one', async () => {
    serve({ ...HEALTH_MULTI, defaultRunner: 'codex' })
    renderAction(makeRun({ runner: undefined }))
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Model' }))
    const options = await screen.findAllByRole('menuitemradio')
    // The menu lists claude presets, so a codex model id cannot even be picked.
    expect(options.some((o) => o.textContent?.includes('gpt-5.1-codex'))).toBe(false)
    fireEvent.click(options.find((o) => o.textContent?.includes('opus')) as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    await waitFor(() => expect(continueBody()).toBeDefined())
    expect(continueBody()).toEqual({ model: 'opus' })
  })

  it("a legacy run's pinned model stays the pill default — keyed under claude, not defaultRunner", async () => {
    serve({ ...HEALTH_MULTI, defaultRunner: 'codex' })
    renderAction(makeRun({ runner: undefined, model: 'opus' }))
    const pill = await screen.findByRole('button', { name: 'Model' })
    expect(pill.textContent).toContain('opus')
  })

  it('hides the runner pill on a single-backend host — the model pill stays', async () => {
    serve({
      ...HEALTH_MULTI,
      checks: [
        { name: 'claude', available: true },
        { name: 'git', available: true },
      ],
    })
    renderAction(makeRun())
    await screen.findByRole('button', { name: 'Model' })
    expect(screen.queryByRole('button', { name: 'Runner' })).toBeNull()
  })
})
