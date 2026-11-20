import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ApiRun, RunStatus, StepState } from '@open-mercato/cezar-api-client'
import { __clearRememberedStatusesForTests } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import { ReferenceChip } from '@/components/reference-chip'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { resolveConflictsPrompt } from '@/routes/task-thread/run-actions'

import { prOwnerRun, prTaskRuns, ResolveConflictsButton, TaskReferenceChip } from './reference-conflict-action'

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

describe('an issue reference that is really a pull request', () => {
  it('paints, links and acts as that pull request — Resolve conflicts included', async () => {
    __clearRememberedStatusesForTests()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input)
        sent.push({ path, method: init.method ?? 'GET', body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined })
        if (path.includes('/ref-status')) {
          return jsonResponse({ available: true, prs: { 2104: 'review-required' }, issues: { 7: 'open' }, conflicts: [2104], recheckAfterMs: null })
        }
        if (path === '/api/v1/providers/status') {
          return jsonResponse({ providers: [{ provider: 'claude', status: 'connected', enabled: true }] })
        }
        return jsonResponse({})
      }),
    )
    render(
      <QueryClientProvider client={createQueryClient()}>
        <ReferenceStatusProvider
          projectId="acme"
          requests={[
            { projectId: 'acme', kind: 'Issue', number: 2104 },
            { projectId: 'acme', kind: 'Issue', number: 7 },
          ]}
        >
          <ReferenceChip
            reference={{ kind: 'Issue', number: 2104, url: 'https://github.com/o/r/issues/2104' }}
            taskTitle="t"
            conflictAction={<ResolveConflictsButton run={run('running')} prNumber={2104} />}
          />
          <ReferenceChip reference={{ kind: 'Issue', number: 7, url: 'https://github.com/o/r/issues/7' }} taskTitle="t" />
        </ReferenceStatusProvider>
      </QueryClientProvider>,
    )
    const chip = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-slot="pr-chip"][data-conflicting="true"]')
      if (!found) throw new Error('no conflicting PR chip yet')
      return found
    })
    expect(chip.getAttribute('href')).toBe('https://github.com/o/r/pull/2104')
    expect(chip.textContent).toBe('#2104')
    // The real issue keeps its own treatment.
    const issue = document.querySelector('[data-slot="issue-chip"]')
    expect(issue?.getAttribute('href')).toBe('https://github.com/o/r/issues/7')
    expect(issue?.getAttribute('data-status')).toBe('open')

    fireEvent.focus(chip)
    await waitFor(() => expect(document.querySelector('[data-slot="reference-status-card"]')?.textContent).toContain('Pull request #2104'))
    fireEvent.click(screen.getByRole('button', { name: 'Resolve conflicts' }))
    await waitFor(() =>
      expect(sent.find((request) => request.method === 'POST')?.body).toMatchObject({ text: resolveConflictsPrompt(2104) }),
    )
  })
})

describe('prOwnerRun', () => {
  const row = (id: string, extra: Record<string, unknown> = {}) => ({
    projectId: 'acme',
    id,
    archived: false,
    createdAt: '2026-08-14T12:00:00.000Z',
    ...extra,
  })

  it('finds the task by any PR it carries, in that project only', () => {
    const runs = [row('other', { projectId: 'zeta', prNumber: 12 }), row('mine', { markerRefs: { pr: 12 } })]
    expect(prOwnerRun(runs, 'acme', 12)?.id).toBe('mine')
    expect(prOwnerRun(runs, 'acme', 13)).toBeUndefined()
  })

  it('prefers the task whose own PR it is, then a live one, then the newest', () => {
    const mentions = row('mentions', {
      pullRequestUrl: 'https://github.com/o/r/pull/30',
      referencedPullRequestUrl: 'https://github.com/o/r/pull/12',
      createdAt: '2026-08-15T00:00:00.000Z',
    })
    const created = row('created', { pullRequestUrl: 'https://github.com/o/r/pull/12' })
    expect(prOwnerRun([mentions, created], 'acme', 12)?.id).toBe('created')
    const archived = row('archived', { prNumber: 12, archived: true, createdAt: '2026-08-16T00:00:00.000Z' })
    expect(prOwnerRun([archived, mentions], 'acme', 12)?.id).toBe('mentions')
    const newer = row('newer', { prNumber: 12, createdAt: '2026-08-20T00:00:00.000Z' })
    expect(prOwnerRun([newer, row('older', { prNumber: 12 })], 'acme', 12)?.id).toBe('newer')
  })

  it('sends a review task declaring the PR behind the task that created it', () => {
    const created = row('created', { pullRequestUrl: 'https://github.com/o/r/pull/12' })
    const reviewer = row('reviewer', { prNumber: 12, markerRefs: { pr: 12 }, createdAt: '2026-08-20T00:00:00.000Z' })
    expect(prOwnerRun([reviewer, created], 'acme', 12)?.id).toBe('created')
    const createdRef = row('created-ref', { prRefs: [{ number: 12, origin: 'created', at: '2026-08-14T12:00:00.000Z' }] })
    expect(prOwnerRun([reviewer, createdRef], 'acme', 12)?.id).toBe('created-ref')
    // With no creator in the index, the declaring task still owns it over one that only shows it.
    const shows = row('shows', { prNumber: 12, createdAt: '2026-08-25T00:00:00.000Z' })
    expect(prOwnerRun([shows, reviewer], 'acme', 12)?.id).toBe('reviewer')
  })

  it('lets no transcript-scraped number from another repository own the PR (#854)', () => {
    const foreign = row('foreign', { prNumber: 12, referencedPrCandidates: ['https://github.com/else/where/pull/12'] })
    expect(prOwnerRun([foreign], 'acme', 12, 'https://github.com/o/r')).toBeUndefined()
    expect(prOwnerRun([foreign], 'acme', 12)?.id).toBe('foreign')
  })
})

describe('prTaskRuns', () => {
  const row = (id: string, extra: Record<string, unknown> = {}) => ({ projectId: 'acme', id, archived: false, createdAt: '2026-08-14T12:00:00.000Z', ...extra })

  it('lists every task carrying the PR in the owner order, the creator first', () => {
    const runs = [
      row('shows', { prNumber: 12, createdAt: '2026-08-30T00:00:00.000Z' }),
      row('reviewer-old', { markerRefs: { pr: 12 }, createdAt: '2026-08-15T00:00:00.000Z' }),
      row('elsewhere', { projectId: 'zeta', pullRequestUrl: 'https://github.com/o/r/pull/12' }),
      row('reviewer-new', { markerRefs: { pr: 12 }, createdAt: '2026-08-20T00:00:00.000Z' }),
      row('creator', { pullRequestUrl: 'https://github.com/o/r/pull/12' }),
      row('unrelated', { prNumber: 13 }),
    ]
    expect(prTaskRuns(runs, 'acme', 12).map((run) => run.id)).toEqual(['creator', 'reviewer-new', 'reviewer-old', 'shows'])
    expect(prOwnerRun(runs, 'acme', 12)?.id).toBe('creator')
    expect(prTaskRuns(runs, 'acme', 99)).toEqual([])
  })
})

describe('TaskReferenceChip', () => {
  it('keeps the supplied primary and groups additional PR associations behind +N', async () => {
    render(
      <TaskReferenceChip
        run={
          run('done', {
            pullRequestUrl: 'https://github.com/o/r/pull/10',
            referencedPullRequestUrl: 'https://github.com/o/r/pull/9',
            markerRefs: { pr: 9 },
          })
        }
        reference={{ kind: 'PR', number: 10, url: 'https://github.com/o/r/pull/10' }}
      />,
    )
    // One chip on the row, the rest one click away — the task header's grouping.
    expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
      'https://github.com/o/r/pull/10',
    ])
    const overflow = screen.getByRole('button', { name: /Show all 2 references/ })
    expect(overflow.textContent).toBe('+1')
    fireEvent.click(overflow)
    await waitFor(() =>
      expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
        'https://github.com/o/r/pull/10',
        'https://github.com/o/r/pull/10',
        'https://github.com/o/r/pull/9',
      ]),
    )
  })

  it('moves a conflicting PR out from behind +N so its Resolve conflicts stays on the row', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input)
        sent.push({ path, method: init.method ?? 'GET', body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined })
        if (path.includes('/ref-status')) {
          return jsonResponse({ available: true, prs: { 9: 'ready', 10: 'ready' }, issues: {}, conflicts: [9], recheckAfterMs: null })
        }
        if (path === '/api/v1/providers/status') {
          return jsonResponse({ providers: [{ provider: 'claude', status: 'connected', enabled: true }] })
        }
        return jsonResponse({})
      }),
    )
    render(
      <QueryClientProvider client={createQueryClient()}>
        <ReferenceStatusProvider
          projectId="acme"
          requests={[
            { projectId: 'acme', kind: 'PR', number: 10 },
            { projectId: 'acme', kind: 'PR', number: 9 },
          ]}
        >
          <TaskReferenceChip
            run={run('running', {
              pullRequestUrl: 'https://github.com/o/r/pull/10',
              referencedPullRequestUrl: 'https://github.com/o/r/pull/9',
              markerRefs: { pr: 9 },
            })}
            reference={{ kind: 'PR', number: 10, url: 'https://github.com/o/r/pull/10' }}
          />
        </ReferenceStatusProvider>
      </QueryClientProvider>,
    )
    const chip = await waitFor(() => {
      const found = document.querySelector('[data-slot="pr-chip"][data-conflicting="true"]')
      if (!found) throw new Error('no conflicting chip yet')
      return found as HTMLElement
    })
    // #9 leads the row, ahead of the task's own #10.
    expect(chip.getAttribute('href')).toBe('https://github.com/o/r/pull/9')
    fireEvent.focus(chip)
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: 'Resolve conflicts' })))
    await waitFor(() =>
      expect(sent.find((request) => request.method === 'POST')?.body).toMatchObject({
        text: resolveConflictsPrompt(9),
      }),
    )
  })
})
