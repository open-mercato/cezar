import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ApiRun, HarnessLedgerResponse } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'

import { TaskHarnessPacketsRoute, TaskHarnessReviewRoute } from './task-harness'

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
    profile: 'high-assurance',
    workflow: 'cez-harness-implement-feature',
  },
}

function ledger(): HarnessLedgerResponse {
  return {
    version: 2,
    workflow: 'cez-harness-implement-feature',
    requestedProfile: 'high-assurance',
    effectiveProfile: 'high-assurance',
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
    packets: [
      {
        id: 'pk-1',
        originalId: 'pk-1',
        title: 'Replay guard',
        state: 'implementing',
        risk: 'high',
        paths: ['src/runs/store.ts'],
      },
    ],
    invocations: [
      {
        id: 'packet-pk-1',
        phaseId: 'packet-pk-1',
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

function stubApi(): SentRequest[] {
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
      if (method === 'GET' && path === '/api/runs/r1') return json(run)
      if (method === 'GET' && path === '/api/runs/r1/harness') return json(ledger())
      if (method === 'GET' && path === '/api/runs') return json([run])
      if (method === 'GET' && path === '/api/providers/status') {
        return json({
          providers: [
            { provider: 'claude', status: 'connected', enabled: true },
            { provider: 'codex', status: 'connected', enabled: true },
            { provider: 'opencode', status: 'not-installed', enabled: true },
          ],
        })
      }
      if (method === 'POST' && path === '/api/runs/r1/harness/accept-contested') {
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

function renderRoute(kind: 'review' | 'packets') {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[`/tasks/r1/${kind}`]}>
        <Routes>
          <Route
            path="/tasks/:id/review"
            element={<TaskHarnessReviewRoute />}
          />
          <Route
            path="/tasks/:id/packets"
            element={<TaskHarnessPacketsRoute />}
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
  it('renders the durable council matrix and preserves findings after explicit risk acceptance', async () => {
    const sent = stubApi()
    renderRoute('review')

    expect(await screen.findByRole('heading', { name: 'Council review' })).not.toBeNull()
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
            request.path === '/api/runs/r1/harness/accept-contested',
        ),
      ).toEqual({
        method: 'POST',
        path: '/api/runs/r1/harness/accept-contested',
        body: {
          reason: 'Reviewed the fallback and accepting it for the staged draft.',
        },
      })
    })
    expect(await screen.findByText('Contested result accepted')).not.toBeNull()
    expect(screen.getByText('Compatibility alias is not replay-safe')).not.toBeNull()
  })
})

describe('high-assurance packet route', () => {
  it('reconstructs from the ledger and applies a newer recovery packet event in place', async () => {
    stubApi()
    renderRoute('packets')

    expect(await screen.findByRole('heading', { name: 'Replay guard' })).not.toBeNull()
    expect(screen.getByText('implementing')).not.toBeNull()
    expect(screen.getByText('src/runs/store.ts')).not.toBeNull()
    expect(screen.getByRole('link', { name: 'Packets' }).getAttribute('aria-current')).toBe('page')
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.instances[0]?.url).toBe('/api/runs/r1/events')

    act(() => {
      FakeEventSource.instances[0]?.emit('ui-event', {
        seq: 11,
        ts: '2026-07-26T10:00:11.000Z',
        type: 'harness.packet.updated',
        packet: {
          id: 'pk-1-resume-2',
          originalId: 'pk-1',
          effectiveId: 'pk-1-resume-2',
          title: 'Replay guard',
          state: 'gated',
          risk: 'high',
          attempt: 2,
          paths: ['src/runs/store.ts'],
        },
      })
    })

    await waitFor(() => expect(screen.getByText('gated')).not.toBeNull())
    expect(screen.getByText(/recovery attempt 2/i)).not.toBeNull()
    expect(screen.getAllByRole('heading', { name: 'Replay guard' })).toHaveLength(1)
    expect(screen.getByText(/Leases released · evidence bound to diff/i)).not.toBeNull()
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
      // The council-level copy already carries `by`; the per-reviewer pass then
      // contributed the same finding again, which used to append the id twice.
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
    const { formatReviewResponse } = await import('./task-harness')

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
    // The escaped-JSON wall is exactly what this exists to avoid.
    expect(out).not.toContain('\\"')
  })

  it('passes anything that is not a review result through untouched', async () => {
    const { formatReviewResponse } = await import('./task-harness')

    expect(formatReviewResponse('not json at all')).toBe('not json at all')
    expect(formatReviewResponse('{"unrelated":1}')).toBe('{"unrelated":1}')
    expect(formatReviewResponse('[1,2,3]')).toBe('[1,2,3]')
  })

  it('has nothing to say about a missing response', async () => {
    const { formatReviewResponse } = await import('./task-harness')

    expect(formatReviewResponse(null)).toBeNull()
  })

  it('handles a clean approval without inventing findings', async () => {
    const { formatReviewResponse } = await import('./task-harness')

    const out = formatReviewResponse(JSON.stringify({ verdict: 'approve', findings: [] }))!

    expect(out).toContain('Verdict: approve')
    expect(out).toContain('0 findings')
  })
})
