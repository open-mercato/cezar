import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { applyManagerEvent, managerKeys } from '@/api/managers'
import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import type { ManagerMessage, ManagerSummary } from '@open-mercato/cezar-api-client'

import { ManagerApprovalsRoute } from './manager-approvals'
import { actionMessage, managerFixture } from './manager-fixtures'
import { ManagerSidebar } from './manager-sidebar'

const job = (seq: number, name = `Job ${seq}`) => actionMessage(seq, { action: { type: 'add-job', name, prompt: 'Check the project', everyMinutes: 60 } })
let managers: ManagerSummary[]
let messages: Record<string, ManagerMessage[]>
let failed: string | undefined
let onDecision: (() => void) | undefined
const requests: string[] = []
const decisions: Array<{ manager: string; action: string; decision: string }> = []

beforeEach(() => {
  managers = [managerFixture({ pendingActions: 2, pendingQuestions: 1 }), managerFixture({ id: 'shop', name: 'Shop', pendingActions: 1 })]
  messages = { global: [job(1), job(60)], shop: [job(2)] }
  requests.length = 0
  decisions.length = 0
  failed = undefined
  onDecision = undefined
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost')
    requests.push(url.pathname + url.search)
    if (url.pathname.endsWith('/managers')) return failed === 'list' ? Response.json({ error: 'Connection failed' }, { status: 503 }) : Response.json({ managers })
    const parts = /\/managers\/([^/]+)\/(messages|actions\/([^/]+)\/decision)/.exec(url.pathname)
    if (!parts) return Response.json({})
    const id = parts[1]!
    if (parts[2] === 'messages') {
      if (failed === id) return Response.json({ error: 'Connection failed' }, { status: 503 })
      // One pending card per page: the oldest action is outside the newest chat page.
      const before = Number(url.searchParams.get('before') ?? Infinity)
      const pending = (messages[id] ?? []).filter((message) => message.seq < before)
      return Response.json({ messages: pending.slice(-1), hasMore: pending.length > 1 })
    }
    const decision = JSON.parse(init!.body as string).decision as string
    decisions.push({ manager: id, action: parts[3]!, decision })
    messages[id] = messages[id]!.filter((message) => message.id !== parts[3])
    managers = managers.map((manager) => manager.id === id ? { ...manager, pendingActions: messages[id]!.length } : manager)
    onDecision?.()
    return Response.json({ ok: true })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function renderApprovals(entry = '/manager/approvals', seedManagers = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.health, { capabilities: { managers: true } })
  if (seedManagers) client.setQueryData(managerKeys.list, { managers })
  client.setQueryData(workspaceQueryKeys.projects, { projects: [], bootProject: null, projectsDir: '' })
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

it('keeps the zero state on a cold link, including when only questions remain', async () => {
  managers = [managerFixture({ pendingQuestions: 2 })]
  renderApprovals()
  expect(await screen.findByRole('heading', { name: 'No pending approvals' })).toBeTruthy()
  expect(requests).toEqual([])
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
  await screen.findByRole('heading', { name: 'No pending approvals' })
  expect(decisions).toEqual([{ manager: 'shop', action: 'a2', decision: 'dismiss' }])
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Approvals' }))
  expect(client.getQueryData(managerKeys.list)).toMatchObject({ managers: [{ pendingActions: 0 }] })
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
