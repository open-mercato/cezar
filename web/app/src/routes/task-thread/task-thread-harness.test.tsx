import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ApiRun, HarnessLedgerResponse } from '@/api/types'

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
          path === '/api/providers/status'
            ? {
                providers: [
                  { provider: 'claude', status: 'connected', enabled: true },
                  { provider: 'codex', status: 'connected', enabled: true },
                  { provider: 'opencode', status: 'not-installed', enabled: true },
                ],
              }
            : method === 'POST' && path === '/api/runs/r-boundary/messages'
              ? { queuedForPhase: true }
              : path === '/api/runs'
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
    // off-screen. The history moved behind its Timeline toggle.
    expect(document.querySelector('[data-slot="harness-status-bar"]')).not.toBeNull()
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
            request.path === '/api/runs/r-boundary/messages',
        ),
      ).toEqual({
        path: '/api/runs/r-boundary/messages',
        method: 'POST',
        body: {
          text: 'Preserve the public compatibility alias.',
          images: [],
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
