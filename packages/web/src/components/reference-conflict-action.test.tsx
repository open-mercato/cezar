import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ApiRun, RunStatus, StepState } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { resolveConflictsPrompt } from '@/routes/task-thread/run-actions'

import { ResolveConflictsButton } from './reference-conflict-action'

/**
 * The one button every surface hands a conflicting chip.
 *
 * Rendered bare here — outside a chip, which `useCloseReferenceCard` tolerates on purpose — so
 * the cases are about DELIVERY: which seam the prompt travels on, and what the user is told when
 * it cannot travel at all. The chip's side of the bargain (mount it only when the panel opens,
 * let it close the panel) is pinned in `reference-chip.test.tsx`, and the whole path from a
 * conflicting forge answer to a POST is pinned in `run-header.test.tsx`.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

interface SentRequest {
  path: string
  method: string
  body: unknown
}

let sent: SentRequest[] = []

beforeEach(() => {
  sent = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const method = init.method ?? 'GET'
      sent.push({ path, method, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined })
      if (path === '/api/v1/providers/status') {
        return jsonResponse({ providers: [{ provider: 'claude', status: 'connected', enabled: true }] })
      }
      return jsonResponse({})
    }),
  )
})

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

const step = (extra: Partial<StepState> = {}): StepState => ({
  id: 'task',
  name: 'Do the task',
  kind: 'agent',
  status: 'done',
  iterations: 1,
  tokensUsed: 0,
  ...extra,
})

const run = (status: RunStatus, extra: Partial<ApiRun> = {}): ApiRun => ({
  id: 'r1',
  title: 'Fix the thing',
  workflow: 'quick-task',
  task: 'Fix the thing.',
  status,
  createdAt: '2026-08-14T12:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  steps: [step({ sessionId: 'sess-1' })],
  ...extra,
})

function renderButton(record: ApiRun) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ResolveConflictsButton run={record} prNumber={864} />
      <Toaster />
    </QueryClientProvider>,
  )
}

const button = () => screen.getByRole('button', { name: /Resolve conflicts|Sending/ })
const posted = () => sent.find((request) => request.method === 'POST')

describe('ResolveConflictsButton', () => {
  it('sends the numbered prompt into the live session', async () => {
    renderButton(run('running'))
    fireEvent.click(button())

    await waitFor(() => expect(posted()?.path).toContain('/messages'))
    expect(posted()?.body).toMatchObject({ text: resolveConflictsPrompt(864) })
    // Said where the user pressed: three of the four surfaces that offer this button do not show
    // the transcript the prompt lands in, so the panel closing cannot be the only signal.
    await waitFor(() => expect(screen.getByText(/Sent to the task — resolving conflicts in PR #864/)).not.toBeNull())
  })

  it('reopens a finished task rather than refusing to speak to it', async () => {
    // The common case, and the reason this does not just POST /messages: a conflicting pull
    // request usually hangs off a task that has already parked at review. The prompt becomes the
    // opening text of the continue, so the fix starts in the same conversation.
    renderButton(run('review'))
    // A resume runs on the run's OWN provider, so the button stays shut until provider discovery
    // has answered — it cannot promise to reopen an engine it has not confirmed is there.
    await waitFor(() => expect(button().hasAttribute('disabled')).toBe(false))
    fireEvent.click(button())

    await waitFor(() => expect(posted()?.path).toContain('/continue'))
    expect(posted()?.body).toMatchObject({ text: resolveConflictsPrompt(864) })
    // And it SAYS the task was reopened: that is a state change the user did not ask for in so
    // many words, and it would otherwise show up only as a status pill quietly going green.
    await waitFor(() => expect(screen.getByText(/Task reopened — resolving conflicts in PR #864/)).not.toBeNull())
  })

  it('says why instead of pretending, when there is no session to reach', async () => {
    // A closed run that never recorded a session has nothing to reopen. A button that looked
    // pressable and then quietly did nothing would be worse than one that explains itself.
    renderButton(run('done', { steps: [step()] }))

    expect(button().hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(/no agent session was recorded/)).not.toBeNull()
    fireEvent.click(button())
    expect(posted()).toBeUndefined()
  })

  it('surfaces a refusal where the user pressed, because the panel is gone by then', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input)
        if (path === '/api/v1/providers/status') {
          return jsonResponse({ providers: [{ provider: 'claude', status: 'connected', enabled: true }] })
        }
        if ((init.method ?? 'GET') === 'POST') return jsonResponse({ error: 'session closed' }, 409)
        return jsonResponse({})
      }),
    )
    renderButton(run('running', { steps: [step()] }))
    fireEvent.click(button())

    await waitFor(() => expect(screen.getByText(/session closed/)).not.toBeNull())
  })
})
