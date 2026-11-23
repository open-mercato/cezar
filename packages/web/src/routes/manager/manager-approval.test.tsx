import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { managerKeys } from '@/api/managers'
import { workspaceQueryKeys } from '@/api/queries'
import type { ManagerActionRequest, ManagerConfirm, ManagerMessage } from '@open-mercato/cezar-api-client'

import { ActionCard, forgetStaleChecks, useDismissStaleMerges, type DecideAction } from './manager-approval'
import { actionMessage } from './manager-fixtures'

const merge: ManagerActionRequest = { type: 'merge-pr', projectId: 'alpha', number: 12, title: 'Fix the thing', method: 'squash', headSha: '3fa9c1d2e4b5a69788' }
const job: ManagerActionRequest = { type: 'add-job', name: 'Nightly', prompt: 'Summarise every open pull request.', everyMinutes: 60 }
const call: ManagerActionRequest = { type: 'connector-call', connector: 'claude_ai_Gmail', connectorName: 'claude.ai Gmail', tool: 'send_message', args: { to: 'a@example.com', subject: 'Hi' } }
const automation: ManagerActionRequest = { type: 'enable-automation', projectId: 'alpha', automationId: 'auto-1', name: 'Triage', revision: 4, summary: '{"prompt":"triage"}' }

function renderCard(
  message: ReturnType<typeof actionMessage>,
  onDecide: DecideAction = vi.fn(async () => ({ ok: true })),
  managerConfirm?: ManagerConfirm,
  own?: ManagerConfirm,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(workspaceQueryKeys.projects, {
    projects: [{ id: 'alpha', name: 'Meblohand', repoUrl: 'https://github.com/o/alpha' }],
    bootProject: 'alpha',
    projectsDir: '',
  })
  if (managerConfirm) client.setQueryData(workspaceQueryKeys.uiState, { managerConfirm })
  client.setQueryData(managerKeys.list, { managers: [{ id: 'm1', ...(own ? { confirm: own } : {}) }] })
  const ui = (next: typeof message) => (
    <QueryClientProvider client={client}><ActionCard origin={{ id: 'm1', name: 'Mira' }} message={next} onDecide={onDecide} /></QueryClientProvider>
  )
  const { rerender } = render(ui(message))
  return { onDecide, rerender: (next: typeof message) => rerender(ui(next)) }
}

const approve = () => fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

describe('ActionCard per-manager confirmation', () => {
  afterEach(cleanup)

  it("lets a manager's own answer win over the global one, type by type", async () => {
    const { onDecide } = renderCard(actionMessage(1, { action: call }), undefined, { 'connector-call': true }, { 'connector-call': false })
    approve()
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith('a1', 'approve'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('falls back to the global answer for a type the manager does not name', () => {
    renderCard(actionMessage(1, { action: call }), undefined, { 'connector-call': true }, { 'merge-pr': false })
    approve()
    expect(screen.getByRole('dialog', { name: 'Make this call?' })).toBeTruthy()
  })
})

beforeEach(() => {
  // Pending forever: the ui-state query stays loading unless a test seeds it.
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ActionCard', () => {
  it('fills the column with two equal 40 px buttons on a phone, natural width on a desktop', () => {
    renderCard(actionMessage(1))
    const card = screen.getByRole('region', { name: 'Merge #12 — Fix the thing' })
    expect(card.className).toContain('w-full')
    expect(card.className).not.toContain('max-w-lg')
    for (const name of ['Reject', 'Approve']) {
      expect(within(card).getByRole('button', { name }).className).toMatch(/\bmax-md:h-10\b.*\bmax-md:flex-1\b/)
    }
    expect(within(card).getByRole('button', { name: 'Approve' }).getAttribute('data-variant')).toBe('primary')
  })

  it('is one card shape: a titled header with the status at the right, the pinned facts, the actions', () => {
    renderCard(actionMessage(1, { action: merge }))
    const card = screen.getByRole('region', { name: 'Merge #12 — Fix the thing' })
    expect(card.getAttribute('data-tone')).toBe('info')
    expect(card.querySelector('[data-slot="manager-card-header"]')?.textContent).toBe('Merge pull requestWaiting for you')
    const facts = [...card.querySelectorAll('dt')].map((term) => term.textContent)
    expect(facts).toEqual(['Project', 'Pull request', 'Method', 'Head'])
    expect(card.querySelector('[data-slot="pr-chip"]')?.textContent).toContain('#12')
    expect(card.textContent).toContain('3fa9c1d2e4b5 · pinned, a new push refuses')
    expect(card.querySelector('[data-slot="manager-card-actions"]')?.textContent).toBe('ApproveRejectDismiss')
    cleanup()
    renderCard(actionMessage(1, { status: 'done', result: 'Merged #12' }))
    const done = screen.getByRole('region', { name: 'Merge #12 — Fix the thing' })
    expect(done.getAttribute('data-tone')).toBe('plain')
    expect(done.querySelector('[data-slot="manager-card-actions"]')).toBeNull()
  })

  it("makes the merge card's PR chip the chat's link: href, new tab, the arrow and a 44 px touch target", () => {
    renderCard(actionMessage(1, { action: merge }))
    const card = screen.getByRole('region', { name: 'Merge #12 — Fix the thing' })
    const chip = within(card).getByRole('link', { name: 'Open the pull request for #12, Fix the thing' })
    expect(chip.getAttribute('data-slot')).toBe('pr-chip')
    expect(chip.getAttribute('href')).toBe('https://github.com/o/alpha/pull/12')
    expect(chip.getAttribute('target')).toBe('_blank')
    expect(chip.querySelector('svg.lucide-arrow-up-right')).not.toBeNull()
    expect(chip.className).toMatch(/\bpointer-coarse:after:-inset-3\b/)
    // Focus opens the status card, as on every other chip.
    fireEvent.focus(chip)
    expect(screen.getByRole('tooltip').textContent).toContain('Pull request #12')
  })

  it('keeps the chip a link on a merge card with no title', () => {
    renderCard(actionMessage(1, { action: { type: 'merge-pr', projectId: 'alpha', number: 7 } }))
    expect(screen.getByRole('link', { name: 'Open the pull request for #7, Meblohand' }).getAttribute('href')).toBe('https://github.com/o/alpha/pull/7')
  })

  it('shows a ring when it takes keyboard focus after a decision or a pill jump', () => {
    renderCard(actionMessage(1))
    expect(screen.getByRole('region', { name: 'Merge #12 — Fix the thing' }).className).toContain('focus-visible:ring-[3px]')
  })

  it('rejects at once, with no confirmation', () => {
    const { onDecide } = renderCard(actionMessage(1))
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect(onDecide).toHaveBeenCalledWith('a1', 'reject')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('restates a merge: project, PR, title, method, head and link', () => {
    const { onDecide } = renderCard(actionMessage(1, { action: merge }))
    approve()
    expect(onDecide).not.toHaveBeenCalled()
    const sheet = within(screen.getByRole('dialog', { name: 'Merge this pull request?' }))
    expect(sheet.getByText('Meblohand')).toBeTruthy()
    expect(sheet.getByText('Fix the thing')).toBeTruthy()
    expect(sheet.getByText('squash')).toBeTruthy()
    expect(sheet.getByText('3fa9c1d2e4b5')).toBeTruthy()
    expect(sheet.getByRole('link', { name: '#12' }).getAttribute('href')).toBe('https://github.com/o/alpha/pull/12')
    fireEvent.click(sheet.getByRole('button', { name: 'Merge' }))
    expect(onDecide).toHaveBeenCalledWith('a1', 'approve')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('says what an unpinned merge does instead of leaving the row out', () => {
    renderCard(actionMessage(1, { action: { type: 'merge-pr', projectId: 'gone', number: 12 } }))
    approve()
    const sheet = within(screen.getByRole('dialog'))
    expect(sheet.getByText('gone')).toBeTruthy()
    expect(sheet.getByText('Repository default')).toBeTruthy()
    expect(sheet.getByText('Latest at merge')).toBeTruthy()
    expect(sheet.queryByRole('link')).toBeNull()
  })

  it('restates an automation: name, revision and the whole summary', () => {
    renderCard(actionMessage(1, { action: automation }))
    approve()
    const sheet = within(screen.getByRole('dialog', { name: 'Enable this automation?' }))
    expect(sheet.getByText('Triage')).toBeTruthy()
    expect(sheet.getByText('4')).toBeTruthy()
    expect(sheet.getByText('{"prompt":"triage"}')).toBeTruthy()
  })

  it('restates a job: name, interval and the whole prompt', () => {
    renderCard(actionMessage(1, { action: job }))
    approve()
    const sheet = within(screen.getByRole('dialog', { name: 'Add this job?' }))
    expect(sheet.getByText('Nightly')).toBeTruthy()
    expect(sheet.getByText('Every 60 min')).toBeTruthy()
    expect(document.querySelector('[data-slot="manager-action-full"]')?.textContent).toBe(job.prompt)
  })

  it('restates a connector call: connector, tool, one argument per line on the card, the full JSON in the sheet', async () => {
    const { onDecide } = renderCard(actionMessage(1, { action: call, reason: 'Reply to the client' }))
    const card = screen.getByRole('region', { name: 'claude.ai Gmail: send_message' })
    // Named once, in the Connector fact: the header only says what kind of card this is.
    expect(within(card).getAllByText('claude.ai Gmail')).toHaveLength(1)
    expect(within(card).getByText('Connector call')).toBeTruthy()
    expect(within(card).getByText('Reply to the client')).toBeTruthy()
    const args = JSON.stringify({ to: 'a@example.com', subject: 'Hi' }, null, 2)
    expect(document.querySelector('[data-slot="manager-action-detail"]')?.textContent).toBe('to: "a@example.com"\nsubject: "Hi"')
    approve()
    const sheet = within(screen.getByRole('dialog', { name: 'Make this call?' }))
    expect(sheet.getByText('send_message')).toBeTruthy()
    const full = document.querySelector('[data-slot="manager-action-full"]')!
    expect(full.textContent).toBe(args)
    expect(full.className).toContain('font-mono')
    fireEvent.click(sheet.getByRole('button', { name: 'Make call' }))
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith('a1', 'approve'))
  })

  it('shows a connector call\'s result once done', () => {
    renderCard(actionMessage(1, { action: call, status: 'done', result: 'Sent.' }))
    expect(screen.getByText('Sent.')).toBeTruthy()
  })

  it('closes on Cancel without deciding', () => {
    const { onDecide } = renderCard(actionMessage(1))
    approve()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onDecide).not.toHaveBeenCalled()
  })

  it('clamps the detail to three lines with no nested scroller', () => {
    renderCard(actionMessage(1, { action: job }))
    const detail = document.querySelector('[data-slot="manager-action-detail"]')!
    expect(detail.className).toContain('line-clamp-3')
    expect(detail.className).not.toMatch(/overflow-auto|max-h-/)
  })

  it('keeps a clamped prompt readable with the step switched off, and once decided', () => {
    const { onDecide } = renderCard(actionMessage(1, { action: job }), undefined, { 'add-job': false })
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }))
    expect(document.querySelector('[data-slot="manager-action-full"]')?.textContent).toBe(job.prompt)
    expect(onDecide).not.toHaveBeenCalled()
    cleanup()
    renderCard(actionMessage(1, { action: job, status: 'done', result: 'Added job Nightly' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }))
    expect(document.querySelector('[data-slot="manager-action-full"]')?.textContent).toBe(job.prompt)
    expect(screen.queryByRole('button', { name: 'Add job' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
  })

  it('drops the confirm button when the action is decided under an open sheet', () => {
    const { rerender } = renderCard(actionMessage(1, { action: job }))
    approve()
    expect(screen.getByRole('button', { name: 'Add job' })).toBeTruthy()
    rerender(actionMessage(1, { action: job, status: 'done' }))
    expect(screen.queryByRole('button', { name: 'Add job' })).toBeNull()
  })

  it('locks only itself while its decision is in flight, against a double tap too', async () => {
    let settle = () => {}
    const onDecide = vi.fn(() => new Promise<void>((resolve) => { settle = resolve }))
    renderCard(actionMessage(1), onDecide)
    const reject = screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement
    fireEvent.click(reject)
    fireEvent.click(reject)
    expect(onDecide).toHaveBeenCalledTimes(1)
    expect(reject.disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true)
    settle()
    await waitFor(() => expect(reject.disabled).toBe(false))
  })

  it('writes a refusal on the card, and clears it on the next try', async () => {
    const onDecide = vi.fn<DecideAction>().mockRejectedValueOnce(new Error('this action is already running')).mockReturnValue(new Promise(() => {}))
    renderCard(actionMessage(1), onDecide)
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect((await screen.findByRole('alert')).textContent).toContain('this action is already running')
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('replaces the buttons with the outcome once decided', () => {
    renderCard(actionMessage(1, { status: 'done', result: 'Merged #12' }))
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.getByText('Merged #12')).toBeTruthy()
  })

  it('falls back to the status when no result was written', () => {
    renderCard(actionMessage(1, { status: 'rejected' }))
    expect(document.querySelector('[data-slot="manager-card-status"]')?.textContent).toBe('Rejected')
    // Said once to a screen reader through the outcome region, not drawn a second time.
    const outcome = document.querySelector('[data-slot="manager-action-outcome"]')!
    expect(outcome.textContent).toBe('Rejected')
    expect(outcome.firstElementChild?.className).toContain('sr-only')
  })

  it('announces the outcome through a status region that was there before it', () => {
    const { rerender } = renderCard(actionMessage(1))
    const region = screen.getByRole('status')
    expect(region.textContent).toBe('')
    rerender(actionMessage(1, { status: 'done', result: 'Merged #12' }))
    expect(screen.getByRole('status')).toBe(region)
    expect(region.textContent).toBe('Merged #12')
  })

  it('keeps keyboard focus on the card when its buttons go away', async () => {
    const { rerender } = renderCard(actionMessage(1))
    const card = screen.getByRole('region', { name: 'Merge #12 — Fix the thing' })
    const reject = screen.getByRole('button', { name: 'Reject' })
    reject.focus()
    fireEvent.click(reject)
    await waitFor(() => expect(document.activeElement).toBe(card))
    rerender(actionMessage(1, { status: 'rejected' }))
    expect(document.activeElement).toBe(card)
  })

  it('leaves focus alone when the reader moved on before the decision landed', async () => {
    let settle = () => {}
    const onDecide = vi.fn(() => new Promise<void>((resolve) => { settle = resolve }))
    renderCard(actionMessage(1), onDecide)
    const elsewhere = document.body.appendChild(document.createElement('input'))
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    elsewhere.focus()
    settle()
    await waitFor(() => expect(onDecide).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(document.activeElement).toBe(elsewhere)
    elsewhere.remove()
  })

  it.each(['Cancel', 'Escape'])('returns focus to Approve on %s, even after a tap that focused nothing', async (how) => {
    renderCard(actionMessage(1))
    const approveButton = screen.getByRole('button', { name: 'Approve' })
    ;(document.activeElement as HTMLElement | null)?.blur()
    approve()
    const sheet = screen.getByRole('dialog')
    if (how === 'Cancel') fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }))
    else fireEvent.keyDown(sheet, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(approveButton))
  })

  it('returns focus to Show all when that opened the sheet', async () => {
    renderCard(actionMessage(1, { action: job }))
    const showAll = screen.getByRole('button', { name: 'Show all' })
    showAll.focus()
    fireEvent.click(showAll)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(showAll))
  })

  it('returns focus to the card after confirming in the sheet', async () => {
    const { onDecide } = renderCard(actionMessage(1))
    const card = screen.getByRole('region', { name: 'Merge #12 — Fix the thing' })
    screen.getByRole('button', { name: 'Approve' }).focus()
    approve()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Merge' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(onDecide).toHaveBeenCalledWith('a1', 'approve')
    await waitFor(() => expect(document.activeElement).toBe(card))
  })
})

describe('the confirmation setting', () => {
  it('confirms by default: the setting never loaded', () => {
    const { onDecide } = renderCard(actionMessage(1))
    approve()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(onDecide).not.toHaveBeenCalled()
  })

  it('confirms on an empty setting and on another type being off', () => {
    const { onDecide } = renderCard(actionMessage(1), undefined, {})
    approve()
    expect(screen.getByRole('dialog')).toBeTruthy()
    cleanup()
    renderCard(actionMessage(1), onDecide, { 'add-job': false })
    approve()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(onDecide).not.toHaveBeenCalled()
  })

  it('confirms an unknown future type, even one stored as off', () => {
    const action = { type: 'delete-branch', projectId: 'alpha' } as unknown as ManagerActionRequest
    const { onDecide } = renderCard(actionMessage(1, { action }), undefined, { 'delete-branch': false })
    approve()
    expect(screen.getByRole('dialog', { name: 'Approve this action?' })).toBeTruthy()
    expect(onDecide).not.toHaveBeenCalled()
  })

  it('sends directly once switched off, with the card and its tap still there', () => {
    const { onDecide } = renderCard(actionMessage(1), undefined, { 'merge-pr': false })
    expect(onDecide).not.toHaveBeenCalled()
    approve()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onDecide).toHaveBeenCalledWith('a1', 'approve')
  })
})

describe('Dismiss', () => {
  it('offers Dismiss on a waiting card, which decides nothing and shows the card as Dismissed', async () => {
    const { onDecide, rerender } = renderCard(actionMessage(1))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith('a1', 'dismiss'))
    rerender(actionMessage(1, { status: 'dismissed', result: '#12 was already merged' }))
    const card = screen.getByRole('region', { name: 'Merge #12 — Fix the thing' })
    expect(card.querySelector('[data-slot="manager-card-status"]')?.textContent).toBe('Dismissed')
    expect(within(card).queryByRole('button', { name: 'Dismiss' })).toBeNull()
    expect(within(card).getByText('#12 was already merged')).toBeTruthy()
  })
})

describe('useDismissStaleMerges', () => {
  afterEach(forgetStaleChecks)

  function Probe({ messages, onDecide }: { messages: ManagerMessage[]; onDecide: DecideAction }) {
    useDismissStaleMerges(messages, onDecide)
    return null
  }

  it('asks once per waiting merge card, only if its PR is no longer open, and swallows the 409', async () => {
    const onDecide = vi.fn<DecideAction>(async () => { throw new Error('this proposal is still current') })
    const messages = [
      actionMessage(1),
      actionMessage(2, { status: 'done' }),
      actionMessage(3, { action: job }),
    ]
    const { rerender } = render(<Probe messages={messages} onDecide={onDecide} />)
    rerender(<Probe messages={[...messages]} onDecide={onDecide} />)
    await waitFor(() => expect(onDecide).toHaveBeenCalledTimes(1))
    expect(onDecide).toHaveBeenCalledWith('a1', 'dismiss', { onlyIfStale: true })
  })

  it('asks once per waiting enable card too, so an outdated one closes without a watch check', async () => {
    const onDecide = vi.fn<DecideAction>(async () => ({ ok: true }))
    const messages = [actionMessage(1, { action: automation }), actionMessage(2, { action: automation, status: 'dismissed' })]
    const { rerender } = render(<Probe messages={messages} onDecide={onDecide} />)
    rerender(<Probe messages={[...messages]} onDecide={onDecide} />)
    await waitFor(() => expect(onDecide).toHaveBeenCalledTimes(1))
    expect(onDecide).toHaveBeenCalledWith('a1', 'dismiss', { onlyIfStale: true })
  })
})

describe('ActionCard when its PR merges while the chat is open', () => {
  afterEach(forgetStaleChecks)

  /** The chip's own poll, on a short server cadence; `state` is what GitHub says at each ask. */
  function stubRefStatus(state: () => string, number = 12) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input)
      if (!url.includes('/github/ref-status')) return new Promise(() => {})
      return Response.json({ available: true, prs: { [number]: state() }, issues: {}, conflicts: [], recheckAfterMs: 20 })
    }))
  }

  it('re-sends the onlyIfStale dismiss once, when the chip reports the PR merged', async () => {
    let state = 'ready'
    stubRefStatus(() => state)
    const { onDecide } = renderCard(actionMessage(1, { action: merge }))
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(1))
    expect(onDecide).not.toHaveBeenCalled()
    state = 'merged'
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith('a1', 'dismiss', { onlyIfStale: true }))
    const calls = vi.mocked(fetch).mock.calls.length
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(calls + 1))
    expect(onDecide).toHaveBeenCalledTimes(1)
  })

  it('asks for a closed PR too, and never for one still open', async () => {
    stubRefStatus(() => 'closed')
    const { onDecide } = renderCard(actionMessage(1, { action: merge }))
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith('a1', 'dismiss', { onlyIfStale: true }))
    cleanup()
    // Another PR: the tab remembers what it learned about #12.
    stubRefStatus(() => 'checks-pending', 13)
    const open = renderCard(actionMessage(2, { action: { ...merge, number: 13 } }))
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(2))
    expect(open.onDecide).not.toHaveBeenCalled()
  })
})

describe('ActionCard tasks behind the PR', () => {
  const task = (id: string, extra: Record<string, unknown> = {}) => ({
    projectId: 'alpha', id, title: `Task ${id}`, status: 'review', archived: false, workflow: 'quick-task',
    createdAt: '2026-10-31T09:00:00Z', lastActivityAt: '2026-10-31T09:00:00Z', ...extra,
  })
  const creator = task('creator', { pullRequestUrl: 'https://github.com/o/alpha/pull/12' })

  function TaskPage() {
    const location = useLocation()
    return <p data-slot="task-page">{location.pathname} {JSON.stringify(location.state)}</p>
  }

  function renderWithRuns(runs: unknown[], status: 'pending' | 'done' | 'rejected' = 'pending') {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(workspaceQueryKeys.projects, { projects: [{ id: 'alpha', name: 'Meblohand', repoUrl: 'https://github.com/o/alpha' }], bootProject: 'alpha', projectsDir: '' })
    client.setQueryData(managerKeys.list, { managers: [{ id: 'm1' }] })
    client.setQueryData(workspaceQueryKeys.runsIndex, { runs })
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/manager/m1']}>
          <Routes>
            <Route path="/manager/:id" element={<ActionCard origin={{ id: 'm1', name: 'Mira' }} message={actionMessage(1, { action: merge, status })} onDecide={vi.fn(async () => ({ ok: true }))} />} />
            <Route path="/p/:projectId/tasks/:runId" element={<TaskPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
  }

  const tasksRow = () => document.querySelector<HTMLElement>('[data-slot="manager-action-tasks"]')

  it('names the one task right under Pull request, and opening it carries the manager along (#2220)', () => {
    renderWithRuns([creator])
    const label = screen.getByText('Task')
    expect(label.parentElement?.previousElementSibling?.textContent).toContain('Pull request')
    const chip = within(tasksRow()!).getByRole('link')
    expect(chip.textContent).toContain('Task creator')
    expect(chip.textContent).toContain('Meblohand')
    expect(chip.querySelector('[data-slot="status-dot"]')).toBeTruthy()
    fireEvent.click(chip)
    const page = document.querySelector('[data-slot="task-page"]')
    expect(page?.textContent).toContain('/p/alpha/tasks/creator')
    expect(page?.textContent).toContain('"manager":{"id":"m1","name":"Mira"}')
  })

  it('lists the creator first, then the rest, three at most and +N', () => {
    renderWithRuns([
      task('r1', { markerRefs: { pr: 12 }, createdAt: '2026-10-31T10:00:00Z' }),
      task('r2', { markerRefs: { pr: 12 }, createdAt: '2026-10-31T11:00:00Z' }),
      task('r3', { prNumber: 12 }),
      creator,
      task('r4', { prNumber: 12, projectId: 'zeta' }),
    ])
    expect(screen.getByText('Tasks')).toBeTruthy()
    const links = within(tasksRow()!).getAllByRole('link')
    expect(links.map((link) => link.getAttribute('data-run'))).toEqual(['creator', 'r2', 'r1'])
    expect(document.querySelector('[data-slot="manager-action-tasks-more"]')?.textContent).toBe('+1 more task')
  })

  it('keeps the row once decided, merged or refused', () => {
    renderWithRuns([creator], 'done')
    expect(within(tasksRow()!).getByRole('link')).toBeTruthy()
    cleanup()
    renderWithRuns([creator], 'rejected')
    expect(within(tasksRow()!).getByRole('link')).toBeTruthy()
  })

  it('draws no row when no task carries the PR', () => {
    renderWithRuns([task('other', { prNumber: 99 })])
    expect(tasksRow()).toBeNull()
    expect(screen.queryByText(/^Tasks?$/)).toBeNull()
  })
})
