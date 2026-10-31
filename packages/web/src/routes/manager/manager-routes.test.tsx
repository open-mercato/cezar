import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { applyManagerEvent, managerKeys, type ManagerEventName } from '@/api/managers'
import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import type { ManagerMessage, ManagerSummary } from '@open-mercato/cezar-api-client'

import { ManagerChatRoute } from './manager-chat'
import { actionMessage, assistantMessage, managerFixture, userMessage } from './manager-fixtures'
import { ManagerIndexRoute } from './manager-index'
import { ManagerNewRoute, applySetupPatch, MANAGER_PRESETS } from './manager-new'

let server: { managers: ManagerSummary[]; messages: ManagerMessage[]; hasMore: boolean }
const calls: Array<{ method: string; path: string; body?: unknown }> = []

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function route(path: string, method: string, body: unknown): Response {
  if (path === '/api/v1/workspace/managers') {
    if (method === 'GET') return json({ managers: server.managers })
    const created = managerFixture({ id: 'made', name: 'Made' })
    server.managers = [created]
    return json(created)
  }
  if (/\/messages\?/.test(path)) return json({ messages: server.messages, hasMore: server.hasMore })
  if (method === 'PATCH') return json({ ...server.managers[0], ...(body as object) })
  return json({ ok: true })
}

function stubServer() {
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body as string) : undefined
    if (input.includes('/workspace/managers')) {
      calls.push({ method, path: input, body })
      return route(input, method, body)
    }
    return json({})
  }))
}

function Location() {
  return <span data-testid="at">{useLocation().pathname}</span>
}

function renderAt(entry: string, seed?: (client: QueryClient) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.health, { capabilities: { managers: true }, defaultRunner: 'claude', bootProject: 'alpha', checks: [] })
  client.setQueryData(workspaceQueryKeys.projects, {
    projects: [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }],
    bootProject: 'alpha',
    projectsDir: '',
  })
  client.setQueryData(workspaceQueryKeys.runsIndex, { runs: [] })
  seed?.(client)
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Location />
        <Routes>
          <Route path="/manager" element={<ManagerIndexRoute />} />
          <Route path="/manager/new" element={<ManagerNewRoute />} />
          <Route path="/manager/:id" element={<ManagerChatRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return client
}

const posted = (suffix: string) => calls.filter((call) => call.method === 'POST' && call.path.endsWith(suffix))
const composer = () => screen.getByRole('textbox') as HTMLTextAreaElement
function send(text: string) {
  fireEvent.change(composer(), { target: { value: text } })
  fireEvent.keyDown(composer(), { key: 'Enter' })
}

beforeEach(() => {
  server = { managers: [managerFixture()], messages: [], hasMore: false }
  calls.length = 0
  stubServer()
  // jsdom has neither; the chat scrolls and the popovers measure.
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('/manager', () => {
  it('opens first-run setup when there is no manager', async () => {
    server.managers = []
    renderAt('/manager')
    expect(await screen.findByRole('heading', { name: 'Setup Your first manager' })).toBeTruthy()
  })

  it('opens the most recent manager on a desktop', async () => {
    server.managers = [
      managerFixture({ id: 'old', lastActivityAt: '2026-10-01T00:00:00Z' }),
      managerFixture({ id: 'recent', lastActivityAt: '2026-10-31T00:00:00Z' }),
    ]
    renderAt('/manager')
    await waitFor(() => expect(screen.getByTestId('at').textContent).toBe('/manager/recent'))
  })

  it('lists managers as a screen of its own on a phone', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
    renderAt('/manager')
    await waitFor(() => expect(document.querySelector('[data-route="manager-list"]')).not.toBeNull())
    expect(screen.getByTestId('at').textContent).toBe('/manager')
    expect(screen.getByRole('link', { name: 'New manager' })).toBeTruthy()
  })
})

describe('/manager/new', () => {
  it('fills the box from a preset, creates, sends the prompt first and opens the chat', async () => {
    server.managers = []
    renderAt('/manager/new')
    await screen.findByRole('heading', { name: 'Setup Your first manager' })
    fireEvent.click(screen.getByRole('button', { name: MANAGER_PRESETS[0].label }))
    expect(composer().value).toBe(MANAGER_PRESETS[0].prompt)
    fireEvent.click(screen.getByRole('button', { name: 'Create manager' }))
    await waitFor(() => expect(screen.getByTestId('at').textContent).toBe('/manager/made'))
    expect(posted('/workspace/managers')[0]?.body).toEqual({
      instructions: MANAGER_PRESETS[0].prompt,
      projects: 'all',
      effort: 'medium',
    })
    expect(posted('/made/messages')[0]?.body).toEqual({ text: MANAGER_PRESETS[0].prompt })
  })

  it('reads as a second manager once one exists', async () => {
    renderAt('/manager/new')
    expect(await screen.findByRole('heading', { name: 'New manager' })).toBeTruthy()
  })

  it('folds picker patches, null meaning back to the default', () => {
    const setup = { projects: 'all' as const, model: 'm', effort: 'high' as const }
    expect(applySetupPatch(setup, { model: null, effort: 'low', projects: ['a'] })).toEqual({ projects: ['a'], effort: 'low' })
  })
})

describe('/manager/:id', () => {
  const seedChat = () => {
    server.messages = [userMessage(1), assistantMessage(2, { text: 'Reply body', commands: [{ id: 'c', tool: 'Bash', summary: 'gh pr list' }] })]
  }

  it('shows the header, the transcript and the footer', async () => {
    seedChat()
    renderAt('/manager/global')
    expect(await screen.findByRole('heading', { name: 'Global Manager' })).toBeTruthy()
    expect(await screen.findByText('jak progres prac')).toBeTruthy()
    expect(await screen.findByRole('button', { name: 'Ran 1 command' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Connected projects' }).textContent).toContain('All projects access')
    expect(screen.getByRole('button', { name: 'Watch check cadence' }).textContent).toContain('Chron: 15 min')
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Attach files' })).toBeNull()
  })

  it('sends a message', async () => {
    renderAt('/manager/global')
    await screen.findByRole('heading', { name: 'Global Manager' })
    send('hello there')
    await waitFor(() => expect(posted('/global/messages')[0]?.body).toEqual({ text: 'hello there' }))
  })

  it('expands a prompt command and routes /check and /stop', async () => {
    renderAt('/manager/global')
    await screen.findByRole('heading', { name: 'Global Manager' })
    send('/status')
    await waitFor(() => expect(posted('/global/messages')[0]?.body).toEqual({ text: 'Give me a short status of my connected projects.' }))
    await waitFor(() => expect(composer().value).toBe(''))
    send('/check')
    await waitFor(() => expect(posted('/global/check')).toHaveLength(1))
    await waitFor(() => expect(composer().value).toBe(''))
    send('/stop')
    await waitFor(() => expect(posted('/global/stop')).toHaveLength(1))
    expect(posted('/global/messages')).toHaveLength(1)
  })

  it('offers the commands in the / menu, not skills', async () => {
    renderAt('/manager/global')
    await screen.findByRole('heading', { name: 'Global Manager' })
    fireEvent.change(composer(), { target: { value: '/att' } })
    const item = await waitFor(() => {
      const found = document.querySelector('[data-slot="composer-menu-item"]')
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    expect(item.textContent).toContain('/attention')
  })

  it('shows Stop and the spinner while working, and posts the stop', async () => {
    server.managers = [managerFixture({ status: 'working' })]
    renderAt('/manager/global')
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }))
    expect(screen.getByRole('status', { name: 'Working' })).toBeTruthy()
    await waitFor(() => expect(posted('/global/stop')).toHaveLength(1))
  })

  it('approves through the decision route, never as a chat message', async () => {
    server.messages = [actionMessage(3)]
    renderAt('/manager/global')
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    await waitFor(() => {
      expect(posted('/global/actions/a3/decision')[0]?.body).toEqual({ decision: 'approve' })
    })
    expect(posted('/global/messages')).toHaveLength(0)
  })

  it('clears unread on open, and optimistically', async () => {
    server.managers = [managerFixture({ unread: 2 })]
    const client = renderAt('/manager/global')
    await waitFor(() => expect(posted('/global/read')).toHaveLength(1))
    expect(client.getQueryData<{ managers: ManagerSummary[] }>(managerKeys.list)?.managers[0]?.unread).toBe(0)
  })

  it('patches a live reply in from the stream without a refetch', async () => {
    server.messages = [userMessage(1)]
    const client = renderAt('/manager/global')
    await screen.findByText('jak progres prac')
    const frame = (name: ManagerEventName, payload: unknown) => applyManagerEvent(client, name, JSON.stringify(payload))
    frame('manager-message', { managerId: 'global', message: assistantMessage(2, { text: 'Stre', streaming: true }) })
    expect(await screen.findByText('Stre')).toBeTruthy()
    frame('manager-message', { managerId: 'global', message: assistantMessage(2, { text: 'Streamed', streaming: true }) })
    expect(await screen.findByText('Streamed')).toBeTruthy()
    expect(calls.filter((call) => call.path.includes('/messages?'))).toHaveLength(1)
  })

  it('pages older history with the oldest seq it holds', async () => {
    server.messages = [userMessage(40), userMessage(41, 'newest')]
    server.hasMore = true
    renderAt('/manager/global')
    const more = await screen.findByRole('button', { name: 'Load earlier messages' })
    server.messages = [userMessage(39, 'older')]
    server.hasMore = false
    fireEvent.click(more)
    expect(await screen.findByText('older')).toBeTruthy()
    expect(calls.some((call) => call.path.includes('before=40'))).toBe(true)
    expect(screen.queryByRole('button', { name: 'Load earlier messages' })).toBeNull()
  })

  it('says a manager is gone rather than loading forever', async () => {
    renderAt('/manager/nobody')
    expect(await screen.findByRole('heading', { name: 'This manager no longer exists' })).toBeTruthy()
  })

  it('reports an unavailable server through the shared state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'Managers are off' }, 409)))
    renderAt('/manager/global')
    expect(await screen.findByRole('heading', { name: 'Managers are unavailable' })).toBeTruthy()
    expect(screen.getByText('Managers are off')).toBeTruthy()
  })

  it('renames and deletes from the gear, deleting only after confirmation', async () => {
    renderAt('/manager/global')
    fireEvent.click(await screen.findByRole('button', { name: 'Manager settings' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete…' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('Delete Global Manager?')
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(calls.some((call) => call.method === 'DELETE' && call.path.endsWith('/global'))).toBe(true))
  })

  it('checks now from the gear', async () => {
    renderAt('/manager/global')
    fireEvent.click(await screen.findByRole('button', { name: 'Manager settings' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Check now' }))
    await waitFor(() => expect(posted('/global/check')).toHaveLength(1))
  })
})
