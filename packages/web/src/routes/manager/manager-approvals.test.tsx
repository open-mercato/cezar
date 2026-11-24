import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { applyManagerEvent, managerKeys, refreshManagerApprovalLists } from '@/api/managers'
import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import type { ManagerMessage, ManagerSummary } from '@open-mercato/cezar-api-client'

import { ManagerApprovalsRoute } from './manager-approvals'
import { actionMessage, managerFixture } from './manager-fixtures'
import { ManagerSidebar } from './manager-sidebar'

const job = (seq: number, name = `Job ${seq}`) => actionMessage(seq, { action: { type: 'add-job', name, prompt: 'Check the project', everyMinutes: 60 } })
let managers: ManagerSummary[]
let messages: Record<string, ManagerMessage[]>
let failed: string | undefined
let onDecision: (() => void | Promise<void>) | undefined
let beforeReadReturns: (() => Promise<void>) | undefined
let beforeListReturns: (() => Promise<void>) | undefined
let staleCheck: (() => Promise<void>) | undefined
const requests: string[] = []
const decisions: Array<{ manager: string; action: string; decision: string }> = []

beforeEach(() => {
  managers = [managerFixture({ pendingActions: 2, pendingQuestions: 1 }), managerFixture({ id: 'shop', name: 'Shop', pendingActions: 1 })]
  messages = { global: [job(1), job(60)], shop: [job(2)] }
  requests.length = 0
  decisions.length = 0
  failed = undefined
  onDecision = undefined
  beforeReadReturns = undefined
  beforeListReturns = undefined
  staleCheck = undefined
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost')
    requests.push(url.pathname + url.search)
    if (url.pathname.endsWith('/managers')) {
      const response = failed === 'list' ? Response.json({ error: 'Connection failed' }, { status: 503 }) : Response.json({ managers })
      await beforeListReturns?.()
      return response
    }
    const parts = /\/managers\/([^/]+)\/(messages|actions\/([^/]+)\/decision)/.exec(url.pathname)
    if (!parts) return Response.json({})
    const id = parts[1]!
    if (parts[2] === 'messages') {
      if (failed === id || (failed === 'result' && !url.searchParams.has('pending'))) return Response.json({ error: 'Connection failed' }, { status: 503 })
      // One pending card per page: the oldest action is outside the newest chat page.
      const before = Number(url.searchParams.get('before') ?? Infinity)
      const pending = (messages[id] ?? []).filter((message) => message.seq < before
        && (!url.searchParams.has('pending') || (message.kind === 'action' && message.status === 'pending')))
      const response = Response.json({ messages: pending.slice(-1), hasMore: pending.length > 1 })
      await beforeReadReturns?.()
      return response
    }
    const body = JSON.parse(init!.body as string) as { decision: string; onlyIfStale?: boolean }
    const decision = body.decision
    decisions.push({ manager: id, action: parts[3]!, decision })
    if (body.onlyIfStale) {
      await staleCheck?.()
      return Response.json({ error: 'The pull request is still open.' }, { status: 409 })
    }
    if (failed === 'decision') return Response.json({ error: 'This action changed. Refresh before deciding.' }, { status: 409 })
    messages[id] = messages[id]!.map((message) => message.id === parts[3] ? { ...job(message.seq), status: 'dismissed', result: 'Dismissed' } : message)
    managers = managers.map((manager) => manager.id === id ? { ...manager, pendingActions: messages[id]!.filter((message) => message.kind === 'action' && message.status === 'pending').length } : manager)
    await onDecision?.()
    return Response.json({ ok: true })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

function renderApprovals(entry = '/manager/approvals', seedManagers = true, projects: Array<{ id: string; name: string; repoUrl?: string }> = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.health, { capabilities: { managers: true } })
  if (seedManagers) client.setQueryData(managerKeys.list, { managers })
  client.setQueryData(workspaceQueryKeys.projects, { projects, bootProject: null, projectsDir: '' })
  client.setQueryData(workspaceQueryKeys.runsIndex, { runs: [] })
  client.setQueryData(workspaceQueryKeys.uiState, {})
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[entry]}>
    <ManagerSidebar />
    <Routes>
      <Route path="/manager/approvals" element={<ManagerApprovalsRoute />} />
      <Route path="/manager/:id" element={<h1>Chat</h1>} />
    </Routes>
  </MemoryRouter></QueryClientProvider>)
  return client
}

it('leaves the current chat for all managers’ pending cards, including older pages', async () => {
  renderApprovals('/manager/global')
  fireEvent.click(screen.getByRole('link', { name: 'Approvals, 3 pending approvals' }))
  await screen.findByText('Job 1')
  await screen.findByText('Job 2')
  expect(screen.getByText('3 pending approvals across all managers')).toBeTruthy()
  expect(document.querySelectorAll('[data-slot="manager-action"]')).toHaveLength(3)
  expect(requests.some((path) => path.includes('before=60') && path.includes('pending=1'))).toBe(true)
  expect(requests.filter((path) => path.includes('/messages')).every((path) => path.includes('pending=1'))).toBe(true)
  expect(screen.getByRole('link', { name: 'Open chat with Shop' }).getAttribute('href')).toBe('/manager/shop#needs-you')
  expect(screen.getByRole('link', { name: 'Approvals, 3 pending approvals' }).getAttribute('aria-current')).toBe('page')
})

it('paints an action reason’s references as the chat’s chips', async () => {
  managers = [managerFixture({ id: 'shop', name: 'Shop', pendingActions: 1 })]
  messages = { shop: [actionMessage(2, { reason: 'Green after [[pr:alpha/2897]] landed.' })] }
  renderApprovals('/manager/approvals', true, [{ id: 'alpha', name: 'Alpha', repoUrl: 'https://github.com/o/alpha' }])
  const reason = await screen.findByText((_, element) => element?.tagName === 'P' && element.textContent === 'Green after #2897 landed.')
  expect(reason.querySelector('[data-slot="pr-chip"]')?.getAttribute('href')).toBe('https://github.com/o/alpha/pull/2897')
})

it('keeps the zero state on a cold link, including when only questions remain', async () => {
  managers = [managerFixture({ pendingQuestions: 2 })]
  renderApprovals()
  expect(await screen.findByRole('heading', { name: 'No pending approvals' })).toBeTruthy()
  // No approvals read: the only request is the Questions badge's own.
  expect(requests.filter((path) => !path.startsWith('/api/v1/workspace/questions'))).toEqual([])
  expect(screen.getByText('Waiting for 2 answers')).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Approvals, 0 pending approvals' }).getAttribute('aria-current')).toBe('page')
})

it('keeps an empty workspace on approvals rather than redirecting into setup', async () => {
  managers = []
  renderApprovals()
  expect(await screen.findByRole('heading', { name: 'No pending approvals' })).toBeTruthy()
})

it('updates cards and the count from live events, including same-count replacements', async () => {
  const client = renderApprovals()
  await screen.findByText('Job 2')
  messages.shop = [job(3)]
  act(() => applyManagerEvent(client, 'manager-message', JSON.stringify({ managerId: 'shop', message: { ...job(2), status: 'dismissed' } })))
  await screen.findByText('Job 3')
  expect(screen.queryByText('Job 2')).toBeNull()
  managers = managers.filter((manager) => manager.id !== 'shop')
  act(() => applyManagerEvent(client, 'manager-change', JSON.stringify({ id: 'shop', deleted: true })))
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Shop' })).toBeNull())
  expect(screen.getByRole('link', { name: 'Approvals, 2 pending approvals' })).toBeTruthy()
})

it('uses the owning manager’s decision route and preserves focus after the last card leaves', async () => {
  managers = [managerFixture({ id: 'shop', name: 'Shop', pendingActions: 1 })]
  const client = renderApprovals()
  const dismiss = await screen.findByRole('button', { name: 'Dismiss' })
  // The live summary can remove the section before the POST's response arrives.
  onDecision = () => act(() => applyManagerEvent(client, 'manager-change', JSON.stringify({ id: 'shop', manager: managers[0] })))
  dismiss.focus()
  fireEvent.click(dismiss)
  await screen.findByText('Dismissed', { selector: '[data-slot="manager-action-outcome"] span' })
  expect(decisions).toEqual([{ manager: 'shop', action: 'a2', decision: 'dismiss' }])
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Approvals' }))
  expect(client.getQueryData(managerKeys.list)).toMatchObject({ managers: [{ pendingActions: 0 }] })
  fireEvent.click(screen.getByRole('button', { name: 'Clear results' }))
  expect(screen.getByRole('heading', { name: 'No pending approvals' })).toBeTruthy()
})

it('opens the existing confirmation before approving a card', async () => {
  managers = [managerFixture({ id: 'shop', name: 'Shop', pendingActions: 1 })]
  renderApprovals()
  fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText('Add this job?')).toBeTruthy()
  expect(decisions).toEqual([])
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  expect(decisions).toEqual([])
})

it('shows a failed manager separately and retries without hiding other approvals', async () => {
  failed = 'shop'
  renderApprovals()
  await screen.findByText('Job 1')
  expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t load approvals from Shop.')
  expect(screen.queryByRole('heading', { name: 'No pending approvals' })).toBeNull()
  failed = undefined
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByText('Job 2')).toBeTruthy()
})

it('does not report zero approvals when the workspace list fails to load', async () => {
  failed = 'list'
  renderApprovals('/manager/approvals', false)
  expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t load managers.')
  expect(screen.queryByRole('heading', { name: 'No pending approvals' })).toBeNull()
  expect(screen.getByRole('link', { name: 'Approvals' }).textContent).toBe('Approvals')
})

it.each(['action', 'summary', 'both', 'reconnect'])('keeps a %s event that arrives during the initial approvals read', async (event) => {
  managers = [managerFixture({ pendingActions: 1 })]
  messages = { global: [job(1)] }
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let started = false
  beforeReadReturns = async () => {
    if (started) return
    started = true
    await held
  }
  const client = renderApprovals()
  await waitFor(() => expect(started).toBe(true))
  messages.global = [job(1), job(2)]
  act(() => {
    if (event === 'action' || event === 'both') applyManagerEvent(client, 'manager-message', JSON.stringify({ managerId: 'global', message: job(2) }))
    if (event === 'summary' || event === 'both') applyManagerEvent(client, 'manager-change', JSON.stringify({ id: 'global', manager: managerFixture({ pendingActions: 2 }) }))
    if (event === 'reconnect') void refreshManagerApprovalLists(client)
  })
  await act(async () => { release(); await held })
  expect(await screen.findByText('Job 2')).toBeTruthy()
  expect(requests.filter((path) => path.includes('/messages')).length).toBeGreaterThan(1)
})

it('keeps a running decision and its failed result visible after pending count reaches zero', async () => {
  managers = [managerFixture({ id: 'shop', name: 'Shop', pendingActions: 1, confirm: { 'add-job': false } })]
  const client = renderApprovals()
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const failure = { ...job(2), status: 'failed' as const, result: 'Required checks are failing.' }
  onDecision = async () => {
    act(() => {
      applyManagerEvent(client, 'manager-message', JSON.stringify({ managerId: 'shop', message: { ...job(2), status: 'running' } }))
      applyManagerEvent(client, 'manager-change', JSON.stringify({ id: 'shop', manager: managers[0] }))
    })
    await held
    messages.shop = [failure]
    act(() => applyManagerEvent(client, 'manager-message', JSON.stringify({ managerId: 'shop', message: failure })))
  }
  fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
  try {
    await waitFor(() => expect(document.querySelector('[data-slot="manager-action"][data-status="running"]')).not.toBeNull())
    expect(screen.queryByRole('heading', { name: 'No pending approvals' })).toBeNull()
  } finally { release() }
  expect(await screen.findByText('Required checks are failing.')).toBeTruthy()
  expect(document.querySelector('[data-slot="manager-action"][data-status="failed"]')).not.toBeNull()
  expect(screen.getByText('0 pending approvals across all managers')).toBeTruthy()
  expect(decisions).toHaveLength(1)
})

it('can retry reading a decision result without submitting the decision again', async () => {
  managers = [managerFixture({ id: 'shop', name: 'Shop', pendingActions: 1 })]
  renderApprovals()
  const dismiss = await screen.findByRole('button', { name: 'Dismiss' })
  failed = 'result'
  fireEvent.click(dismiss)
  expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t load the result')
  failed = undefined
  fireEvent.click(screen.getByRole('button', { name: 'Retry result' }))
  expect(await screen.findByText('Dismissed', { selector: '[data-slot="manager-action-outcome"] span' })).toBeTruthy()
  expect(decisions).toHaveLength(1)
})

it('keeps a refused decision pending with its guard error visible', async () => {
  managers = [managerFixture({ id: 'shop', name: 'Shop', pendingActions: 1 })]
  renderApprovals()
  const dismiss = await screen.findByRole('button', { name: 'Dismiss' })
  failed = 'decision'
  dismiss.focus()
  fireEvent.click(dismiss)
  expect((await screen.findByRole('alert')).textContent).toContain('This action changed. Refresh before deciding.')
  expect(document.querySelector('[data-slot="manager-action"][data-status="pending"]')).not.toBeNull()
  expect(screen.queryByRole('heading', { name: 'No pending approvals' })).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Approvals' }))
})

it('leaves focus inside an open merge card when its background stale check answers "still open"', async () => {
  managers = [managerFixture({ id: 'shop', name: 'Shop', pendingActions: 1 })]
  messages = { shop: [actionMessage(3, { action: { type: 'merge-pr', projectId: 'alpha', number: 12, title: 'Fix the thing', method: 'squash' } })] }
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  staleCheck = () => held
  renderApprovals()
  const approve = await screen.findByRole('button', { name: 'Approve' })
  await waitFor(() => expect(decisions).toEqual([{ manager: 'shop', action: messages.shop![0]!.id, decision: 'dismiss' }]))
  // The keyboard user tabs into the card while the merge-state check is still in flight.
  approve.focus()
  await act(async () => { release(); await held })
  await waitFor(() => expect(requests.filter((path) => path.includes('/decision'))).toHaveLength(1))
  expect(document.activeElement).toBe(approve)
  expect(document.querySelector('[data-slot="manager-action"][data-status="pending"]')).not.toBeNull()
})

it.each(['action', 'summary', 'both'])('reconciles a %s frame racing an unseeded first manager list without inventing a partial list', async (event) => {
  managers = [managerFixture()]
  messages = { global: [], shop: [job(1)] }
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let started = false
  beforeListReturns = async () => {
    if (started) return
    started = true
    await held
  }
  const client = renderApprovals('/manager/approvals', false)
  await waitFor(() => expect(started).toBe(true))
  const added = managerFixture({ id: 'shop', name: 'Shop', pendingActions: 1 })
  managers = [...managers, added]
  act(() => {
    if (event !== 'summary') applyManagerEvent(client, 'manager-message', JSON.stringify({ managerId: 'shop', message: job(1) }))
    if (event !== 'action') applyManagerEvent(client, 'manager-change', JSON.stringify({ id: 'shop', manager: added }))
  })
  expect(client.getQueryData(managerKeys.list)).toBeUndefined()
  await act(async () => { release(); await held })
  expect(await screen.findByText('Job 1')).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Managers · 2' })).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Approvals, 1 pending approval' })).toBeTruthy()
  expect(client.getQueryData(managerKeys.list)).toMatchObject({ managers: [{ id: 'global' }, { id: 'shop', pendingActions: 1 }] })
  expect(requests.filter((path) => path.endsWith('/managers'))).toHaveLength(2)
})

it('does not let a manager-list refresh resurrect a manager deleted by a racing frame', async () => {
  const client = renderApprovals()
  await screen.findByText('Job 2')
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let started = false
  beforeListReturns = async () => {
    if (started) return
    started = true
    await held
  }
  let refreshing!: Promise<void>
  act(() => { refreshing = client.refetchQueries({ queryKey: managerKeys.list }) })
  await waitFor(() => expect(started).toBe(true))
  managers = managers.filter((manager) => manager.id !== 'shop')
  act(() => applyManagerEvent(client, 'manager-change', JSON.stringify({ id: 'shop', deleted: true })))
  await act(async () => { release(); await refreshing })
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Managers · 1' })).toBeTruthy())
  expect(screen.queryByRole('region', { name: 'Shop' })).toBeNull()
  expect(requests.filter((path) => path.endsWith('/managers'))).toHaveLength(2)
})

it('also reconciles a summary received during the follow-up manager-list read', async () => {
  managers = [managerFixture()]
  messages = { global: [] }
  let releaseFirst!: () => void
  let releaseSecond!: () => void
  const first = new Promise<void>((resolve) => { releaseFirst = resolve })
  const second = new Promise<void>((resolve) => { releaseSecond = resolve })
  let reads = 0
  beforeListReturns = async () => {
    reads += 1
    if (reads === 1) await first
    if (reads === 2) await second
  }
  const client = renderApprovals('/manager/approvals', false)
  await waitFor(() => expect(reads).toBe(1))
  managers = [managerFixture({ pendingActions: 1 })]
  messages.global = [job(1)]
  act(() => applyManagerEvent(client, 'manager-change', JSON.stringify({ id: 'global', manager: managers[0] })))
  await act(async () => { releaseFirst(); await first })
  await waitFor(() => expect(reads).toBe(2))
  managers = [managerFixture({ pendingActions: 2 })]
  messages.global = [job(1), job(2)]
  act(() => applyManagerEvent(client, 'manager-change', JSON.stringify({ id: 'global', manager: managers[0] })))
  await act(async () => { releaseSecond(); await second })
  await waitFor(() => expect(reads).toBe(3))
  expect(await screen.findByRole('link', { name: 'Approvals, 2 pending approvals' })).toBeTruthy()
  expect(await screen.findByText('Job 2')).toBeTruthy()
})

const sectionNames = () => [...document.querySelectorAll('[data-slot="approval-group"]')].map((section) => section.getAttribute('aria-label'))
const actionIds = () => [...document.querySelectorAll('[data-slot="manager-action"]')].map((card) => card.getAttribute('data-action-id'))

it('keeps a decided card in its slot even when its manager’s activity re-sorts the list', async () => {
  managers = [managerFixture({ pendingActions: 1, lastActivityAt: '2026-11-02T00:00:00.000Z' }), managerFixture({ id: 'shop', name: 'Shop', pendingActions: 2, lastActivityAt: '2026-11-01T00:00:00.000Z' })]
  messages = { global: [job(1)], shop: [job(2), job(3)] }
  const client = renderApprovals()
  await screen.findByText('Job 3')
  await screen.findByText('Job 2')
  expect([sectionNames(), actionIds()]).toEqual([['Global Manager', 'Shop'], ['a1', 'a2', 'a3']])
  // The decision's note makes Shop the newest manager: re-sorting moved the card out from under the reader.
  onDecision = () => {
    managers = managers.map((manager) => manager.id === 'shop' ? { ...manager, lastActivityAt: '2026-11-03T00:00:00.000Z' } : manager)
    act(() => applyManagerEvent(client, 'manager-change', JSON.stringify({ id: 'shop', manager: managers.find((manager) => manager.id === 'shop') })))
  }
  fireEvent.click(within(document.querySelector<HTMLElement>('[data-action-id="a2"]')!).getByRole('button', { name: 'Dismiss' }))
  await screen.findByText('Dismissed', { selector: '[data-slot="manager-action-outcome"] span' })
  expect([sectionNames(), actionIds()]).toEqual([['Global Manager', 'Shop'], ['a1', 'a2', 'a3']])
})

it('drops the count and the badge on the click, while the decided card stays', async () => {
  managers = [managerFixture({ id: 'shop', name: 'Shop', pendingActions: 1 })]
  renderApprovals()
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  onDecision = () => held
  fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
  try {
    expect(await screen.findByText('0 pending approvals across all managers')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Approvals, 0 pending approvals' })).toBeTruthy()
    expect(document.querySelector('[data-slot="manager-action"][data-status="running"]')).not.toBeNull()
    expect(within(document.querySelector<HTMLElement>('[data-slot="manager-action"]')!).getAllByText('Working on it').length).toBeGreaterThan(0)
    expect(screen.queryByRole('heading', { name: 'No pending approvals' })).toBeNull()
  } finally { release() }
  await screen.findByText('Dismissed', { selector: '[data-slot="manager-action-outcome"] span' })
  expect(screen.getByRole('link', { name: 'Approvals, 0 pending approvals' })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'No pending approvals' })).toBeNull()
})

it('lingers a finished card, with its failure reason, for 30 seconds and then shows the empty state', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  managers = [managerFixture({ id: 'shop', name: 'Shop', pendingActions: 1, confirm: { 'merge-pr': false } })]
  messages = { shop: [actionMessage(2)] }
  onDecision = () => { messages.shop = [actionMessage(2, { status: 'failed', result: 'Required checks are failing.' })] }
  renderApprovals()
  fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
  expect(await screen.findByText('Required checks are failing.')).toBeTruthy()
  expect(document.querySelector('[data-slot="manager-action"][data-status="failed"]')).not.toBeNull()
  await act(async () => { vi.advanceTimersByTime(29_000) })
  expect(screen.getByText('Required checks are failing.')).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'No pending approvals' })).toBeNull()
  await act(async () => { vi.advanceTimersByTime(1_100) })
  expect(document.querySelector('[data-slot="manager-action"]')).toBeNull()
  expect(screen.getByRole('heading', { name: 'No pending approvals' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Clear results' })).toBeNull()
})

it('holds a finished card while the pointer is over the list or the reader just scrolled, then collapses it', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  managers = [managerFixture({ id: 'shop', name: 'Shop', pendingActions: 1, confirm: { 'merge-pr': false } })]
  messages = { shop: [actionMessage(2)] }
  onDecision = () => { messages.shop = [actionMessage(2, { status: 'failed', result: 'Required checks are failing.' })] }
  renderApprovals()
  fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
  expect(await screen.findByText('Required checks are failing.')).toBeTruthy()
  const list = document.querySelector<HTMLElement>('[data-slot="approvals-list"]')!
  fireEvent.pointerEnter(list)
  await act(async () => { await vi.advanceTimersByTimeAsync(40_000) })
  expect(screen.getByText('Required checks are failing.')).toBeTruthy()
  fireEvent.pointerLeave(list)
  fireEvent.scroll(window)
  await act(async () => { await vi.advanceTimersByTimeAsync(2_500) })
  expect(screen.getByText('Required checks are failing.')).toBeTruthy()
  await act(async () => { await vi.advanceTimersByTimeAsync(600) })
  expect(document.querySelector('[data-slot="approval-slot"][data-leaving]')).not.toBeNull()
  await act(async () => { await vi.advanceTimersByTimeAsync(400) })
  expect(document.querySelector('[data-slot="manager-action"]')).toBeNull()
  expect(screen.getByRole('heading', { name: 'No pending approvals' })).toBeTruthy()
})

it('does not bring finished cards back when the reader leaves and returns', async () => {
  managers = [managerFixture({ id: 'shop', name: 'Shop', pendingActions: 2 })]
  messages = { shop: [job(2), job(3)] }
  renderApprovals()
  const card = (await screen.findByText('Job 2')).closest<HTMLElement>('[data-slot="manager-action"]')!
  fireEvent.click(within(card).getByRole('button', { name: 'Dismiss' }))
  await screen.findByText('Dismissed', { selector: '[data-slot="manager-action-outcome"] span' })
  fireEvent.click(screen.getByRole('link', { name: 'Open chat with Shop' }))
  await screen.findByRole('heading', { name: 'Chat' })
  fireEvent.click(screen.getByRole('link', { name: 'Approvals, 1 pending approval' }))
  await screen.findByText('Job 3')
  expect(screen.queryByText('Job 2')).toBeNull()
  expect(screen.queryByText('Dismissed', { selector: '[data-slot="manager-action-outcome"] span' })).toBeNull()
})

it('keeps an inactive manager\'s approvals answerable and counted, flagged and greyed (spec 2026-11-19-manager-deactivate)', async () => {
  managers = managers.map((manager) => (manager.id === 'shop' ? { ...manager, inactive: { since: '2026-11-18T23:40:00Z' } } : manager))
  renderApprovals()
  const shop = await screen.findByRole('region', { name: 'Shop' })
  expect(within(shop).getByText('Manager · inactive')).toBeTruthy()
  expect(within(shop).getByText('Manager inactive — it hears your decision when reactivated')).toBeTruthy()
  expect(shop.querySelector('[data-slot="manager-avatar-inactive"]')).not.toBeNull()
  expect(within(screen.getByRole('region', { name: 'Global Manager' })).queryByText(/Manager inactive/)).toBeNull()
  expect(screen.getByRole('link', { name: 'Approvals, 3 pending approvals' })).toBeTruthy()
  await within(shop).findByText('Job 2')
})
