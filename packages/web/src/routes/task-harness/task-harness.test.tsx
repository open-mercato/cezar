import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ApiRun, HarnessLedgerResponse } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'

import { TaskHarnessReviewRoute } from './task-harness'

class FakeEventSource {
  static instances: FakeEventSource[] = []

  readonly listeners = new Map<string, Array<(event: Event) => void>>()
  readonly url: string
  readyState = 1

  constructor(url: string | URL) {
    this.url = String(url)
    FakeEventSource.instances.push(this)
  }

  addEventListener(name: string, listener: EventListenerOrEventListenerObject): void {
    const handler =
      typeof listener === 'function'
        ? listener
        : (event: Event) => listener.handleEvent(event)
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), handler])
  }

  close(): void {
    this.readyState = 2
  }

  emit(name: string, body: object): void {
    const event = new MessageEvent(name, { data: JSON.stringify(body) })
    for (const listener of this.listeners.get(name) ?? []) listener(event)
  }
}

const run: ApiRun = {
  id: 'r1',
  title: 'build billing',
  titleSummary: 'Build billing',
  workflow: 'cez-harness-implement-feature',
  task: 'Build the billing module.',
  status: 'review',
  createdAt: '2026-07-26T09:00:00.000Z',
  tokensUsed: 42_000,
  archived: false,
  steps: [],
  harness: {
    profile: 'multi',
    workflow: 'cez-harness-implement-feature',
  },
}

function ledger(): HarnessLedgerResponse {
  return {
    version: 2,
    workflow: 'cez-harness-implement-feature',
    requestedProfile: 'multi',
    effectiveProfile: 'multi',
    snapshotSeq: 10,
    phases: [
      {
        id: 'review',
        name: 'Final review',
        kind: 'agent',
        status: 'done',
        attempts: 1,
        artifacts: {},
      },
      {
        id: 'stage',
        name: 'Stage',
        kind: 'op',
        status: 'done',
        attempts: 1,
        artifacts: {},
      },
    ],
    models: [
      {
        id: 'claude',
        family: 'anthropic',
        binding: 'sonnet · host app',
        roles: ['host', 'reviewer'],
        readiness: 'ready',
        readinessDetail: 'fresh',
        invocations: 2,
        totalDurationMs: 4_000,
      },
      {
        id: 'codex',
        family: 'openai',
        binding: 'gpt-5.6-sol · codex cli',
        roles: ['implementer', 'reviewer'],
        readiness: 'ready',
        readinessDetail: 'fresh',
        invocations: 3,
        totalDurationMs: 7_000,
      },
    ],
    councils: [
      {
        round: 2,
        kind: 'implementation',
        verdict: 'request_changes',
        reviewers: [
          {
            id: 'claude',
            status: 'completed',
            verdict: 'request_changes',
            findings: [
              {
                severity: 'major',
                title: 'Compatibility alias is not replay-safe',
                location: 'src/runs/store.ts:412',
              },
            ],
          },
          {
            id: 'codex',
            status: 'completed',
            verdict: 'approve',
            findings: [],
          },
        ],
        findings: [
          {
            severity: 'major',
            title: 'Compatibility alias is not replay-safe',
            location: 'src/runs/store.ts:412',
            by: 'claude',
          },
        ],
      },
    ],
    invocations: [
      {
        id: 'implement',
        phaseId: 'implement',
        role: 'implementer',
        binding: { runner: 'codex', model: 'gpt-5.6-sol' },
        status: 'completed',
        attempt: 1,
        inputSha256: 'input-one',
      },
    ],
    pendingMessages: [],
    stage: {
      status: 'staged',
      stagedPaths: ['src/runs/store.ts'],
    },
    outcome: {
      status: 'contested',
      blockingReasons: ['[major] Compatibility alias is not replay-safe'],
    },
  }
}

interface SentRequest {
  path: string
  method: string
  body?: unknown
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function stubApi(snapshot: () => HarnessLedgerResponse = ledger, record: ApiRun = run): SentRequest[] {
  const sent: SentRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const method = init.method ?? 'GET'
      sent.push({
        path,
        method,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      })
      if (method === 'GET' && path === '/api/v1/runs/r1') return json(record)
      if (method === 'GET' && path === '/api/v1/runs/r1/harness') return json(snapshot())
      if (method === 'GET' && path === '/api/v1/runs') return json([run])
      if (method === 'GET' && path === '/api/v1/providers/status') {
        return json({
          providers: [
            { provider: 'claude', status: 'connected', enabled: true },
            { provider: 'codex', status: 'connected', enabled: true },
            { provider: 'opencode', status: 'not-installed', enabled: true },
          ],
        })
      }
      if (method === 'POST' && path === '/api/v1/runs/r1/harness/accept-contested') {
        return json({
          outcome: {
            status: 'contested',
            blockingReasons: ['[major] Compatibility alias is not replay-safe'],
            acceptedAt: '2026-07-26T11:00:00.000Z',
            acceptedBy: 'user',
            acceptanceReason: 'Reviewed the fallback and accepting it for the staged draft.',
          },
        })
      }
      return json({})
    }),
  )
  return sent
}

function renderRoute() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/tasks/r1/review']}>
        <Routes>
          <Route
            path="/tasks/:id/review"
            element={<TaskHarnessReviewRoute />}
          />
        </Routes>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
})

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

describe('harness review route', () => {
  it('colors completed council verdicts by the review result', async () => {
    stubApi()
    const { container } = renderRoute()
    await screen.findByRole('heading', { name: 'Build billing' })
    const council = container.querySelector<HTMLElement>('[data-slot="harness-council-table"]')!
    expect(within(council).getByText('request changes').querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone'))
      .toBe('danger')
    expect(within(council).getByText('approve').querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone'))
      .toBe('success')
  })

  it('shows only harness progress on the review tab', async () => {
    stubApi(ledger, {
      ...run, steps: [{ id: 'stage', name: 'Stage', kind: 'check', status: 'done', iterations: 1, tokensUsed: 0 }],
    })
    const { container } = renderRoute()
    await screen.findByRole('heading', { name: 'Build billing' })
    expect(container.querySelector('[data-slot="harness-status-bar"]')).not.toBeNull()
    expect(container.querySelector('[data-slot="workflow-steps"]')).toBeNull()
    expect(container.querySelector('main')).toBeNull()
  })

  // Review round 2: this page never shows the transcript, yet it streamed the whole run from seq 0.
  it('opens the event stream once the ledger is known, from its snapshot', async () => {
    stubApi()
    renderRoute()
    await screen.findByRole('heading', { name: 'Build billing' })
    expect(FakeEventSource.instances.map((source) => source.url)).toEqual(['/api/v1/runs/r1/events?afterSeq=10'])
  })

  // a blocked outcome offered "Accept risk", which the server always refuses.
  it('offers risk acceptance only for a contested outcome', async () => {
    stubApi(() => ({
      ...ledger(),
      outcome: { status: 'blocked', blockingReasons: ['implementation council did not reach quorum'] },
    }))
    renderRoute()
    await screen.findByText('This run is blocked')
    expect(screen.queryByRole('button', { name: 'Accept risk' })).toBeNull()
    expect(screen.queryByLabelText('Reason for accepting contested result')).toBeNull()
  })

  it('keeps a paused council decision reachable without the rail', async () => {
    stubApi(() => ({
      ...ledger(),
      outcome: {
        status: 'blocked',
        blockingReasons: ['implementation council did not reach quorum'],
        pendingDecision: {
          kind: 'council', council: 'implementation', round: 2,
          failed: [{ label: 'codex', reason: 'transport died' }], completedCount: 1, canProceed: true,
        },
      } as HarnessLedgerResponse['outcome'],
    }), { ...run, status: 'failed' })
    const { container } = renderRoute()
    await screen.findByText('This run is blocked')
    const outsideRail = [...container.querySelectorAll('[data-slot="council-decision"]')]
      .filter((card) => !card.closest('[data-slot="harness-rail"]'))
    expect(outsideRail).toHaveLength(1)
    expect(outsideRail[0]!.parentElement?.className).toContain('@5xl/run:hidden')
    const table = container.querySelector<HTMLElement>('[data-slot="harness-council-table"]')!
    expect(within(table).getAllByRole('button').length).toBe(table.querySelectorAll('tbody tr').length)
  })

  it('refreshes the cached ledger after feedback and shows the new first review round', async () => {
    let snapshot = ledger()
    snapshot.councils[0]!.round = 3
    const sent = stubApi(() => snapshot)
    renderRoute()
    await screen.findAllByText('Compatibility alias is not replay-safe')
    snapshot = {
      ...ledger(), snapshotSeq: 11, councils: [],
      stage: { status: 'pending' }, outcome: { status: 'pending', blockingReasons: [] },
    }
    act(() => FakeEventSource.instances[0]?.emit('ui-event', {
      seq: 11, ts: '2026-07-26T10:00:11.000Z', type: 'harness.feedback.applied',
      phaseId: 'implement', messageIds: ['feedback-1'],
    }))
    await waitFor(() => expect(sent.filter((request) => request.path.endsWith('/harness'))).toHaveLength(2))
    await waitFor(() => expect(screen.queryByText('Compatibility alias is not replay-safe')).toBeNull())
    act(() => FakeEventSource.instances[0]?.emit('ui-event', {
      seq: 12, ts: '2026-07-26T10:00:12.000Z', type: 'harness.council.updated',
      council: {
        round: 1, kind: 'implementation', verdict: 'request_changes',
        reviewers: [{ id: 'claude', status: 'completed', verdict: 'request_changes', findings: [
          { severity: 'major', title: 'New feedback needs a regression guard' },
        ] }],
        findings: [{ severity: 'major', title: 'New feedback needs a regression guard', by: 'claude' }],
      },
    }))
    await screen.findAllByText('New feedback needs a regression guard')
    expect(screen.queryByText('Compatibility alias is not replay-safe')).toBeNull()
  })

  it('renders the durable council matrix and preserves findings after explicit risk acceptance', async () => {
    const sent = stubApi()
    renderRoute()

    expect(await screen.findByRole('heading', { name: 'Council' })).not.toBeNull()
    // The driver's default is quorum; the page must not claim every reviewer is required.
    expect(screen.queryByText(/Every configured reviewer is required/)).toBeNull()
    expect(screen.getByText('Compatibility alias is not replay-safe')).not.toBeNull()
    expect(screen.getByText('src/runs/store.ts:412')).not.toBeNull()
    // The run OUTCOME leads now (review 2026-07-27) instead of a round verdict
    // pill sitting above a matrix, with the blocking reasons as a list rather
    // than one semicolon-joined line.
    expect(screen.getByText(/Publishing is blocked/i)).not.toBeNull()
    expect(screen.getByRole('link', { name: 'Review' }).getAttribute('aria-current')).toBe('page')

    const accept = screen.getByRole<HTMLButtonElement>('button', { name: /accept risk/i })
    expect(accept.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Reason for accepting contested result'), {
      target: {
        value: 'Reviewed the fallback and accepting it for the staged draft.',
      },
    })
    expect(accept.disabled).toBe(false)
    fireEvent.click(accept)

    await waitFor(() => {
      expect(
        sent.find(
          (request) =>
            request.method === 'POST' &&
            request.path === '/api/v1/runs/r1/harness/accept-contested',
        ),
      ).toEqual({
        method: 'POST',
        path: '/api/v1/runs/r1/harness/accept-contested',
        body: {
          reason: 'Reviewed the fallback and accepting it for the staged draft.',
        },
      })
    })
    expect(await screen.findByText('Contested result accepted')).not.toBeNull()
    expect(screen.getByText('Compatibility alias is not replay-safe')).not.toBeNull()
  })
})

/**
 * Review-tab findings C2/C6 (2026-07-27).
 */
describe('finding attribution', () => {
  it('never repeats a reviewer in raisedBy', async () => {
    const { reviewerFindings } = await import('./task-harness')
    const merged = reviewerFindings({
      round: 1,
      kind: 'implementation',
      findings: [{ severity: 'minor', title: 'dup', by: 'mimo' }],
      reviewers: [
        { id: 'mimo', status: 'completed', findings: [{ severity: 'minor', title: 'dup' }] },
        { id: 'gpt', status: 'completed', findings: [{ severity: 'minor', title: 'dup' }] },
      ],
    } as never)

    expect(merged).toHaveLength(1)
    expect(merged[0]?.raisedBy.sort()).toEqual(['gpt', 'mimo'])
  })

  it('separates blocking findings from the rest', async () => {
    const { blockingFindings } = await import('./task-harness')
    const rows = [
      { severity: 'blocker', title: 'a', raisedBy: [] },
      { severity: 'major', title: 'b', raisedBy: [] },
      { severity: 'minor', title: 'c', raisedBy: [] },
      { severity: 'nit', title: 'd', raisedBy: [] },
    ] as never

    expect(blockingFindings(rows).map((f) => f.title)).toEqual(['a', 'b'])
  })
})

/**
 * User request 2026-07-27: a reviewer's response has to read as prose, not as
 * the raw JSON artifact the model wrote.
 */
describe('formatReviewResponse', () => {
  it('renders a verdict and its findings in readable form', async () => {
    const { formatReviewResponse } = await import('./reviewer-modal')

    const out = formatReviewResponse(
      JSON.stringify({
        verdict: 'request_changes',
        findings: [
          {
            severity: 'major',
            title: 'Auth check removed',
            location: 'src/a.ts:4',
            evidence: 'the guard no longer runs',
          },
        ],
        notes: ['checked against the diff'],
      }),
    )!

    expect(out).toContain('Verdict: request changes')
    expect(out).toContain('1 finding')
    expect(out).toContain('1. [MAJOR] Auth check removed')
    expect(out).toContain('at src/a.ts:4')
    expect(out).toContain('the guard no longer runs')
    expect(out).toContain('checked against the diff')
    expect(out).not.toContain('\\"')
  })

  it('passes anything that is not a review result through untouched', async () => {
    const { formatReviewResponse } = await import('./reviewer-modal')

    expect(formatReviewResponse('not json at all')).toBe('not json at all')
    expect(formatReviewResponse('{"unrelated":1}')).toBe('{"unrelated":1}')
    expect(formatReviewResponse('[1,2,3]')).toBe('[1,2,3]')
  })

  it('has nothing to say about a missing response', async () => {
    const { formatReviewResponse } = await import('./reviewer-modal')

    expect(formatReviewResponse(null)).toBeNull()
  })

  it('handles a clean approval without inventing findings', async () => {
    const { formatReviewResponse } = await import('./reviewer-modal')

    const out = formatReviewResponse(JSON.stringify({ verdict: 'approve', findings: [] }))!

    expect(out).toContain('Verdict: approve')
    expect(out).toContain('0 findings')
  })
})

/**
 * Per-attempt findings (user feedback 2026-07-29): the modal's FINDINGS section
 * follows the selected attempt, parsed from that attempt's result artifact.
 */
describe('parseReviewFindings', () => {
  it('parses the findings array out of a result artifact', async () => {
    const { parseReviewFindings } = await import('./reviewer-modal')
    expect(
      parseReviewFindings(
        JSON.stringify({
          verdict: 'request_changes',
          findings: [{ severity: 'major', title: 'Race in store', location: 'src/a.ts:4', evidence: 'x' }],
        }),
      ),
    ).toEqual([{ severity: 'major', title: 'Race in store', location: 'src/a.ts:4', evidence: 'x' }])
  })

  it('answers null for prose, non-review JSON, or nothing — the caller falls back', async () => {
    const { parseReviewFindings } = await import('./reviewer-modal')
    expect(parseReviewFindings('not json')).toBeNull()
    expect(parseReviewFindings('{"unrelated":1}')).toBeNull()
    expect(parseReviewFindings(null)).toBeNull()
  })
})
