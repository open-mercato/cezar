import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type { RunHistoryState } from '@/api/run-history'
import type { ApiRun, HarnessLedgerResponse, RunEvent } from '@open-mercato/cezar-api-client'

import { ThreadView } from './task-thread'
import { reduceThread } from './thread-state'

const run: ApiRun = {
  id: 'r-boundary',
  title: 'long harness',
  titleSummary: 'Long harness',
  workflow: 'harness-implement-feature',
  task: 'Build a large feature.',
  status: 'running',
  runner: 'claude',
  createdAt: '2026-07-26T09:00:00.000Z',
  tokensUsed: 5_000,
  archived: false,
  steps: [],
  harness: {
    profile: 'multi-optimized',
    workflow: 'harness-implement-feature',
  },
}

const ledger: HarnessLedgerResponse = {
  version: 2,
  workflow: 'harness-implement-feature',
  requestedProfile: 'multi-optimized',
  effectiveProfile: 'multi-optimized',
  phases: [
    {
      id: 'implement',
      name: 'Implement',
      kind: 'agent',
      status: 'running',
      attempts: 1,
      artifacts: {},
    },
  ],
  models: [
    {
      id: 'codex',
      family: 'openai',
      binding: 'gpt-5.6-sol · codex cli',
      roles: ['implementer'],
      readiness: 'ready',
      readinessDetail: 'fresh',
      invocations: 1,
      totalDurationMs: 2_000,
    },
  ],
  councils: [],
  packets: [],
  invocations: [
    {
      id: 'implement-worker',
      phaseId: 'implement',
      role: 'implementer',
      binding: { runner: 'codex', model: 'gpt-5.6-sol' },
      status: 'completed',
      attempt: 1,
      inputSha256: 'input-one',
    },
  ],
  pendingMessages: [],
  stage: { status: 'pending' },
  outcome: { status: 'pending', blockingReasons: [] },
}

interface RequestRecord {
  path: string
  method: string
  body?: unknown
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('harness phase-boundary composer', () => {
  it('stays enabled between sessions and sends text to the durable message endpoint', async () => {
    const requests: RequestRecord[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input)
        const method = init.method ?? 'GET'
        requests.push({
          path,
          method,
          body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
        })
        const body =
          path === '/api/v1/providers/status'
            ? {
                providers: [
                  { provider: 'claude', status: 'connected', enabled: true },
                  { provider: 'codex', status: 'connected', enabled: true },
                  { provider: 'opencode', status: 'not-installed', enabled: true },
                ],
              }
            : method === 'POST' && path === '/api/v1/runs/r-boundary/messages'
              ? { queuedForPhase: true }
              : path === '/api/v1/runs'
                ? [run]
                : {}
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )

    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <ThreadView run={run} thread={reduceThread([])} harnessLedger={ledger} />
        </MemoryRouter>
      </QueryClientProvider>,
    )

    // The horizontal phase rail became one status line (review 2026-07-27): it
    // was 2620px of content in an 820px viewport, so the live phase was always
    // off-screen. The history moved behind its Timeline toggle. Lazily loaded.
    await waitFor(() => {
      expect(document.querySelector('[data-slot="harness-status-bar"]')).not.toBeNull()
      expect(document.querySelector('[data-slot="harness-models-dock"]')).not.toBeNull()
    })
    expect(document.querySelector('[data-slot="harness-phase-rail"]')).toBeNull()
    expect(document.querySelector('[data-slot="harness-timeline-toggle"]')).not.toBeNull()
    expect(
      document
        .querySelector<HTMLDetailsElement>('[data-slot="harness-models-dock"]')
        ?.hasAttribute('open'),
    ).toBe(false)
    expect(document.querySelector('[data-slot="harness-message-hint"]')?.textContent).toMatch(
      /durably queued for the next phase boundary/i,
    )

    const textarea = screen.getByLabelText<HTMLTextAreaElement>('Reply to the agent')
    expect(textarea.disabled).toBe(false)
    expect(textarea.placeholder).toBe('Message the harness — queued safely between phases…')
    fireEvent.change(textarea, { target: { value: 'Preserve the public compatibility alias.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => {
      expect(
        requests.find(
          (request) =>
            request.method === 'POST' &&
            request.path === '/api/v1/runs/r-boundary/messages',
        ),
      ).toEqual({
        path: '/api/v1/runs/r-boundary/messages',
        method: 'POST',
        body: {
          text: 'Preserve the public compatibility alias.',
          images: [],
          idempotencyKey: expect.any(String),
        },
      })
    })
  })

  it('fails closed at review while the durable harness snapshot is unavailable', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )
    const reviewRun: ApiRun = { ...run, status: 'review' }

    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <ThreadView run={reviewRun} thread={reduceThread([])} />
        </MemoryRouter>
      </QueryClientProvider>,
    )

    expect(
      document.querySelector<HTMLButtonElement>('[data-slot="review-draft-pr"]')?.disabled,
    ).toBe(true)
    expect(
      document.querySelector<HTMLButtonElement>('[data-slot="review-accept"]')?.disabled,
    ).toBe(true)
    expect(screen.getByText(/harness recovery snapshot is unavailable/i)).toBeTruthy()
  })
})

const phase = (id: string, name: string, status: string) => ({
  id, name, kind: 'agent', status, attempts: 1, artifacts: {},
}) as HarnessLedgerResponse['phases'][number]

const at = (seq: number, type: string, payload: Record<string, unknown> = {}): RunEvent => ({
  seq, ts: '2026-07-26T09:30:00.000Z', type, ...payload,
})

const historyWindow = (events: RunEvent[], hasOlder: boolean): RunHistoryState => ({
  visibleEvents: events,
  currentEvents: events,
  isPending: false,
  contextPending: false,
  fallback: false,
  fallbackTruncated: false,
  hasOlder,
  isFetchingOlder: false,
  olderError: undefined,
  loadOlder: async () => {},
  jumpToLatest: async () => {},
  retainedPages: 1,
})

const specRunning: HarnessLedgerResponse = {
  ...ledger,
  phases: [phase('spec', 'Spec', 'running')],
  snapshotSeq: 10,
}

function stubHarnessFetch(snapshot: HarnessLedgerResponse | undefined): string[] {
  const reads: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const harnessRead = (init.method ?? 'GET') === 'GET' && path.endsWith('/runs/r-boundary/harness')
      if (harnessRead) reads.push(path)
      return new Response(JSON.stringify(harnessRead && snapshot ? snapshot : {}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
  return reads
}

const statusLine = () => document.querySelector('[data-slot="harness-status-bar"]')?.textContent ?? ''

// the thread folds `harness.*` events from a BOUNDED window over a snapshot that is
// read once, so phase state that scrolled out of the window used to revert to the snapshot's.
describe('harness ledger over a bounded transcript window', () => {
  it('keeps the live phase once its harness events scroll out of the window', async () => {
    const reads = stubHarnessFetch(undefined)
    const client = createQueryClient()
    client.setQueryData(queryKeys.runs.harness(run.id), specRunning)
    const view = (history: RunHistoryState) => (
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ThreadView run={run} thread={reduceThread([])} history={history} embedded />
        </MemoryRouter>
      </QueryClientProvider>
    )

    const { rerender } = render(view(historyWindow([
      at(11, 'harness.phase.updated', { phase: phase('spec', 'Spec', 'done') }),
      at(12, 'harness.phase.updated', { phase: phase('implement', 'Implement', 'running') }),
      at(13, 'item.completed'),
    ], true)))
    await waitFor(() => expect(statusLine()).toContain('Implement'))

    // Compaction swapped the tail for the newest page: both phase events are out of the window.
    rerender(view(historyWindow([at(13, 'item.completed'), at(14, 'item.completed')], true)))

    expect(statusLine()).toContain('Implement')
    expect(statusLine()).not.toContain('Spec')
    expect(client.getQueryData<HarnessLedgerResponse>(queryKeys.runs.harness(run.id))?.snapshotSeq).toBe(12)
    expect(reads).toEqual([])
  })

  it('re-reads the snapshot when the window starts past what it accounts for', async () => {
    // A remount after the history query went stale: its newest page starts long after the cached
    // snapshot, and every harness event in between is in neither.
    const reads = stubHarnessFetch({
      ...ledger,
      phases: [phase('spec', 'Spec', 'done'), phase('implement', 'Implement', 'running')],
      snapshotSeq: 501,
    })
    const client = createQueryClient()
    client.setQueryData(queryKeys.runs.harness(run.id), specRunning)

    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ThreadView
            run={run}
            thread={reduceThread([])}
            history={historyWindow([at(500, 'item.completed'), at(501, 'item.completed')], true)}
            embedded
          />
        </MemoryRouter>
      </QueryClientProvider>,
    )

    await waitFor(() => expect(statusLine()).toContain('Implement'))
    expect(reads).toHaveLength(1)
  })
})

// `/tasks/:id` renders the thread inside a workspace column, so the rail must follow
// the column's width — a viewport breakpoint gave a 590px column a 336px rail track.
describe('harness rail layout', () => {
  const viewportVariants = (element: Element) =>
    element.className.split(/\s+/).filter((token) => /^(sm|md|lg|xl|2xl):/.test(token))

  const renderThread = (subject: ApiRun, harnessLedger?: HarnessLedgerResponse) => {
    stubHarnessFetch(undefined)
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <ThreadView run={subject} thread={reduceThread([])} harnessLedger={harnessLedger} embedded />
        </MemoryRouter>
      </QueryClientProvider>,
    )
  }

  it('sizes the rail, its grid track and the Models dock by the run container', async () => {
    renderThread(run, ledger)
    await waitFor(() => {
      expect(document.querySelector('[data-slot="harness-rail"]')).not.toBeNull()
      expect(document.querySelector('[data-slot="harness-models-dock"]')).not.toBeNull()
    })

    const root = document.querySelector('[data-route="task-thread"]')!
    const grid = document.querySelector('[data-slot="run-rail-grid"]')!
    const rail = document.querySelector('[data-slot="harness-rail"]')!
    const dock = document.querySelector('[data-slot="harness-models-dock"]')!.parentElement!
    expect(root.className).toContain('@container/run')
    expect(grid.className).toContain('@5xl/run:grid-cols-[minmax(0,1fr)_336px]')
    expect(rail.className).toContain('@5xl/run:flex')
    expect(dock.className).toContain('@5xl/run:hidden')
    for (const element of [grid, rail, dock]) expect(viewportVariants(element)).toEqual([])
    // The column scroller starts below the workspace's run header: no header offset here.
    expect(rail.className).toContain('top-3')
    expect(rail.className).not.toContain('top-[calc(var(--run-header-h')
  })

  it('preserves transcript, review and history DOM identity when the ledger rail appears', async () => {
    stubHarnessFetch(undefined)
    const client = createQueryClient()
    const subject: ApiRun = { ...run, status: 'review' }
    const thread = reduceThread([at(1, 'item.completed', {
      item: { kind: 'message', id: 'answer', role: 'assistant', text: 'Ready to review' },
    })])
    const view = (snapshot?: HarnessLedgerResponse) => (
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ThreadView run={subject} thread={thread} history={historyWindow([], true)} harnessLedger={snapshot} embedded />
        </MemoryRouter>
      </QueryClientProvider>
    )
    const { rerender } = render(view())
    const transcript = document.querySelector('[data-slot="thread-rows"]')!
    const answer = screen.getByText('Ready to review')
    const review = document.querySelector('[data-slot="review-panel"]')!
    const boundary = document.querySelector('[data-slot="history-boundary"]')!
    const notes = screen.getByLabelText<HTMLTextAreaElement>('Notes for the agent')
    fireEvent.change(notes, { target: { value: 'Keep my review notes' } })

    rerender(view(ledger))
    await waitFor(() => expect(document.querySelector('[data-slot="harness-rail"]')).not.toBeNull())

    expect(document.querySelector('[data-slot="thread-rows"]'), 'transcript DOM node must survive ledger arrival').toBe(transcript)
    expect(screen.getByText('Ready to review')).toBe(answer)
    expect(document.querySelector('[data-slot="review-panel"]')).toBe(review)
    expect(document.querySelector('[data-slot="history-boundary"]')).toBe(boundary)
    expect(screen.getByLabelText<HTMLTextAreaElement>('Notes for the agent').value).toBe('Keep my review notes')
  })

  it('guard: composer drafts and DOM survive rail appearance and disappearance', async () => {
    stubHarnessFetch(undefined)
    const client = createQueryClient()
    const view = (snapshot: HarnessLedgerResponse) => (
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ThreadView run={run} thread={reduceThread([])} harnessLedger={snapshot} embedded />
        </MemoryRouter>
      </QueryClientProvider>
    )
    const emptyLedger = { ...ledger, phases: [], models: [] }
    const { rerender } = render(view(emptyLedger))
    const composer = screen.getByLabelText<HTMLTextAreaElement>('Reply to the agent')
    fireEvent.change(composer, { target: { value: 'Preserve this composer draft' } })
    rerender(view(ledger))
    await waitFor(() => expect(document.querySelector('[data-slot="harness-rail"]')).not.toBeNull())
    rerender(view(emptyLedger))
    expect(screen.getByLabelText('Reply to the agent')).toBe(composer)
    expect(composer.value).toBe('Preserve this composer draft')
    expect(document.querySelector('[data-slot="run-rail-grid"]')).toBeNull()
  })

  it('reserves no rail track while the ledger has nothing to show', () => {
    renderThread(run, { ...ledger, phases: [], models: [] })

    expect(document.querySelector('[data-slot="run-rail-grid"]')).toBeNull()
    expect(document.querySelector('[data-slot="harness-rail"]')).toBeNull()
  })

  it('guard: leaves an ordinary run layout exactly as on main', () => {
    const { harness: _harness, ...ordinary } = run
    renderThread(ordinary)

    expect(document.querySelector('[data-route="task-thread"]')!.className).toBe('flex min-h-full flex-col')
    expect(document.querySelector('[data-slot="run-rail-grid"]')).toBeNull()
    expect(document.querySelector('[data-route="task-thread"] .contents')).toBeNull()
  })
})
