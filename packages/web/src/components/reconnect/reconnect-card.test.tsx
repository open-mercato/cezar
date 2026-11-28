import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentProfile, LoginSession } from '@open-mercato/cezar-api-client'

import { applyAccountReconnectedEvent, applyAgentLoginEvent } from '@/api/agent-login'
import { createQueryClient } from '@/api/query-client'
import { queryKeys, workspaceQueryKeys } from '@/api/queries'

import { ReconnectCard } from './reconnect-card'
import { ReconnectSurfaceContext, type ReconnectSurface } from './surface'

const api = vi.hoisted(() => ({
  startLoginSession: vi.fn(),
  sendLoginSessionInput: vi.fn(),
  cancelLoginSession: vi.fn(),
  getAgentAccountStatus: vi.fn(),
}))
vi.mock('@/api/client', async (importOriginal) => ({ ...(await importOriginal<object>()), ...api }))

const toasts = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/toaster', async (importOriginal) => ({ ...(await importOriginal<object>()), toast: toasts }))

const profile = (id: string, provider: AgentProfile['provider'], label: string, status?: 'connected' | 'disconnected'): AgentProfile => ({
  id, provider, label, configDir: `~/.${provider}-${id}`, path: `/home/u/.${provider}-${id}`, exists: true, looksValid: true,
  isDefault: id === 'default', files: [], ...(status ? { status: { provider, status } } : {}),
})

const session = (over: Partial<LoginSession> = {}): LoginSession => ({
  sessionId: 's1', provider: 'claude', profileId: 'work', method: 'browser', phase: 'waiting', ...over,
})

let client: QueryClient

function renderCard(props: Partial<Parameters<typeof ReconnectCard>[0]> = {}, surface?: ReconnectSurface) {
  const card = <ReconnectCard provider="claude" profileId="work" place="task" {...props} />
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        {surface ? <ReconnectSurfaceContext.Provider value={surface}>{card}</ReconnectSurfaceContext.Provider> : card}
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const seedSession = (value: LoginSession) => act(async () => {
  client.setQueryData(workspaceQueryKeys.agentLogin(value.provider, value.profileId), value)
  await new Promise((resolve) => setTimeout(resolve, 0))
})

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
  client = createQueryClient()
  client.setQueryData(queryKeys.health, { capabilities: { localHandoff: true } })
  client.setQueryData(workspaceQueryKeys.agentProfiles, {
    editable: true, profileCapableProviders: [], selections: {}, defaults: {},
    profiles: [
      profile('default', 'claude', 'Default', 'disconnected'),
      profile('work', 'claude', 'Work', 'disconnected'),
      profile('personal', 'claude', 'Personal', 'connected'),
    ],
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('ReconnectCard — expired', () => {
  it('names the account and starts its login without opening a tab (spec 2026-11-24)', async () => {
    const open = vi.fn()
    vi.stubGlobal('open', open)
    api.startLoginSession.mockResolvedValue(session({ phase: 'starting' }))
    renderCard()

    expect(screen.getByRole('group', { name: 'Claude Code · Work is signed out' }).textContent).toContain('Login expired')
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect Work' }))
    await waitFor(() => expect(api.startLoginSession).toHaveBeenCalledWith({ provider: 'claude', profileId: 'work' }))

    act(() => applyAgentLoginEvent(client, session({ url: 'https://claude.ai/oauth/authorize?x=1' })))
    await waitFor(() => expect(screen.getByText('https://claude.ai/oauth/authorize?x=1')).toBeTruthy())
    expect(open).not.toHaveBeenCalled()
  })

  it('never opens a tab on a remote cockpit, and sends no profile for the default login', async () => {
    const open = vi.fn()
    vi.stubGlobal('open', open)
    client.setQueryData(queryKeys.health, { capabilities: { localHandoff: false } })
    api.startLoginSession.mockResolvedValue(session({ profileId: 'default', method: 'paste' }))
    renderCard({ profileId: 'default' })
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect Default' }))
    await waitFor(() => expect(api.startLoginSession).toHaveBeenCalledWith({ provider: 'claude' }))
    expect(open).not.toHaveBeenCalled()
  })

  it('shows a refused start with the server command', async () => {
    const { ApiError } = await import('@/api/client')
    api.startLoginSession.mockRejectedValue(new ApiError(409, 'Sign-in from a hosted cockpit is off', { command: 'claude auth login' }))
    client.setQueryData(queryKeys.health, { capabilities: { localHandoff: false } })
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect Work' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain("Sign-in to Claude Code · Work didn't finish")
    expect(alert.textContent).toContain('Sign-in from a hosted cockpit is off')
    expect(alert.textContent).toContain('claude auth login')
  })

  it('More options: check again, settings link and the last-resort command', async () => {
    api.getAgentAccountStatus.mockResolvedValue({ status: { provider: 'claude', status: 'disconnected' } })
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'More options' }))
    expect(screen.getByRole('link', { name: 'Open Settings → Agent accounts' }).getAttribute('href')).toBe('/settings/global/accounts')
    expect(screen.getByText('CLAUDE_CONFIG_DIR=~/.claude-work claude auth login')).toBeTruthy()
    // Claude stores no pasted key: no key path offered.
    expect(screen.queryByRole('button', { name: /API key/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Already signed in? Check again' }))
    await waitFor(() => expect(api.getAgentAccountStatus).toHaveBeenCalledWith('work', { recheck: true }))
    await waitFor(() => expect(toasts).toHaveBeenCalledWith(expect.stringContaining('still signed out')))
  })
})

describe('ReconnectCard — switch account', () => {
  it('offers the healthy account first and greys the signed-out ones', async () => {
    const switchTo = vi.fn(() => Promise.resolve())
    renderCard({}, { kind: 'task', switchTo })
    fireEvent.click(screen.getByRole('button', { name: 'Use Personal instead' }))
    expect(switchTo).toHaveBeenCalledWith('personal')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Use Personal instead' }).hasAttribute('disabled')).toBe(false))
  })

  it('has no switch action without a surface that can switch', () => {
    renderCard()
    expect(screen.queryByRole('button', { name: /instead/ })).toBeNull()
  })
})

describe('ReconnectCard — signing in', () => {
  it('device: big code, Copy code, countdown and the page host', async () => {
    renderCard()
    await seedSession(session({ method: 'device', url: 'https://github.com/login/device', userCode: 'WDJB-MJHT', expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() }))
    expect(screen.getByLabelText('One-time code').textContent).toBe('WDJB-MJHT')
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Open github\.com/ })).toBeTruthy()
    expect(document.querySelector('[data-slot="reconnect-countdown"]')?.textContent).toMatch(/^1[45]:\d\d$/)
  })

  it('link: the URL with Copy link', async () => {
    renderCard({ provider: 'cursor', profileId: 'default' })
    await seedSession(session({ provider: 'cursor', profileId: 'default', method: 'link', url: 'https://cursor.com/loginDeepControl?c=1' }))
    expect(screen.getByText('https://cursor.com/loginDeepControl?c=1')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy()
  })

  it('browser: the link to copy, never an opened tab, and Cancel ends the session', async () => {
    api.cancelLoginSession.mockResolvedValue(session({ phase: 'cancelled' }))
    api.startLoginSession.mockResolvedValue(session({ phase: 'starting' }))
    const opened = vi.spyOn(window, 'open').mockReturnValue(null)
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect Work' }))
    await seedSession(session({ url: 'https://claude.ai/oauth' }))
    expect(screen.getByText('https://claude.ai/oauth')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Open in default browser/ })).toBeTruthy()
    expect(opened).not.toHaveBeenCalled()
    opened.mockRestore()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(api.cancelLoginSession).toHaveBeenCalledWith('s1'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reconnect Work' })).toBeTruthy())
  })

  it('paste: the code goes to the route and stays nowhere else', async () => {
    api.sendLoginSessionInput.mockResolvedValue(session({ method: 'paste', phase: 'verifying' }))
    renderCard()
    await seedSession(session({ method: 'paste', phase: 'needs-input', url: 'https://claude.ai/oauth' }))
    const input = screen.getByLabelText('One-time code') as HTMLInputElement
    expect(input.type).toBe('password')
    expect(input.autocomplete).toBe('off')
    fireEvent.change(input, { target: { value: 'secret-code-123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(input.value).toBe('')
    await waitFor(() => expect(api.sendLoginSessionInput).toHaveBeenCalledWith('s1', { code: 'secret-code-123' }))
    const cached = JSON.stringify([
      client.getQueryCache().getAll().map((query) => query.state.data),
      client.getMutationCache().getAll().map((mutation) => mutation.state.variables),
    ])
    expect(cached).not.toContain('secret-code-123')
    await waitFor(() => expect(screen.getByText('Verifying the account')).toBeTruthy())
  })

  it('key on OpenCode: provider select from keyProviders, sent with the key', async () => {
    api.sendLoginSessionInput.mockResolvedValue(session({ provider: 'opencode', profileId: 'default', method: 'key', phase: 'verifying' }))
    renderCard({ provider: 'opencode', profileId: 'default' })
    await seedSession(session({ provider: 'opencode', profileId: 'default', method: 'key', phase: 'needs-input', keyProviders: ['anthropic', 'openai'] }))
    Element.prototype.scrollIntoView = vi.fn() // Radix Select in jsdom
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Provider' }), { key: 'ArrowDown' })
    fireEvent.click(await screen.findByRole('option', { name: 'openai' }))
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save & sign in' }))
    await waitFor(() => expect(api.sendLoginSessionInput).toHaveBeenCalledWith('s1', { apiKey: 'sk-test', keyProvider: 'openai' }))
  })

  it('key on Codex has no provider select; a key session for another agent has no field at all', async () => {
    const codex = renderCard({ provider: 'codex', profileId: 'default' })
    await seedSession(session({ provider: 'codex', profileId: 'default', method: 'key', phase: 'needs-input' }))
    expect(screen.getByLabelText('API key')).toBeTruthy()
    expect(screen.queryByLabelText('Provider')).toBeNull()
    codex.unmount()
    renderCard()
    await seedSession(session({ method: 'key', phase: 'needs-input' }))
    expect(screen.queryByLabelText('API key')).toBeNull()
  })

  it('terminal, local: Open again restarts, I\'ve signed in re-checks', async () => {
    api.startLoginSession.mockResolvedValue(session({ provider: 'pi', profileId: 'default', method: 'terminal' }))
    api.getAgentAccountStatus.mockResolvedValue({ status: { provider: 'pi', status: 'connected' } })
    renderCard({ provider: 'pi', profileId: 'default' })
    await seedSession(session({ provider: 'pi', profileId: 'default', method: 'terminal' }))
    expect(screen.getByText(/signs in only in its own window/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open again' }))
    await waitFor(() => expect(api.startLoginSession).toHaveBeenCalledWith({ provider: 'pi' }))
    fireEvent.click(screen.getByRole('button', { name: "I've signed in" }))
    await waitFor(() => expect(api.getAgentAccountStatus).toHaveBeenCalledWith('default:pi', { recheck: true }))
  })

  it('terminal, remote: the command and Check', async () => {
    client.setQueryData(queryKeys.health, { capabilities: { localHandoff: false } })
    renderCard({ provider: 'gemini', profileId: 'default' })
    await seedSession(session({ provider: 'gemini', profileId: 'default', method: 'terminal', command: 'gemini' }))
    expect(screen.getByText(/can only sign in on the computer running cezar/)).toBeTruthy()
    expect(screen.getByRole('button', { name: "I've signed in · Check" })).toBeTruthy()
  })

  it('opens a bottom sheet on a narrow viewport', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(max-width: 767px)', media: query, addEventListener() {}, removeEventListener() {} }))
    renderCard()
    await seedSession(session({ method: 'device', url: 'https://github.com/login/device', userCode: 'AAAA-BBBB' }))
    // Started elsewhere (another card for this account): this one does not stack a second sheet.
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show sign-in' }))
    const sheet = await screen.findByRole('dialog')
    expect(sheet.getAttribute('data-slot')).toBe('reconnect-sheet')
    expect(sheet.textContent).toContain('AAAA-BBBB')
    expect(screen.getByRole('button', { name: /Copy code & open github\.com/ })).toBeTruthy()
  })
})

describe('ReconnectCard — outcomes', () => {
  it('signed in: lists what resumes', async () => {
    renderCard()
    await seedSession(session({
      phase: 'connected',
      resumed: { runs: [{ projectId: 'acme', runId: 'r2', title: 'Bump vite' }], managers: [{ managerId: 'm1', title: 'Triage' }] },
    }))
    expect(screen.getByRole('status').textContent).toContain('Claude Code · Work is signed in again')
    expect(screen.getByRole('link', { name: 'Task “Bump vite”' }).getAttribute('href')).toBe('/p/acme/tasks/r2')
    expect(screen.getByRole('link', { name: 'Manager “Triage”' }).getAttribute('href')).toBe('/manager/m1')
  })

  it('signed in: "Also resuming" leaves out the card\'s own manager', async () => {
    renderCard({ place: 'manager' }, { kind: 'manager', ownId: 'm1' })
    await seedSession(session({
      phase: 'connected',
      resumed: { runs: [{ projectId: 'acme', runId: 'r2', title: 'Bump vite' }], managers: [{ managerId: 'm1', title: 'Triage' }] },
    }))
    expect(screen.getByRole('link', { name: 'Task “Bump vite”' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Manager “Triage”' })).toBeNull()
  })

  it.each([
    ['expired', 'device', 'The code expired before it was approved.'],
    ['rejected', 'key', 'The key was rejected by the provider.'],
    ['account-mismatch', 'browser', 'Signed in as another account than Work used'],
    ['timeout', 'terminal', 'No sign-in was detected yet.'],
  ] as const)('failed (%s): a fixed reason and Try again', async (reason, method, copy) => {
    renderCard()
    await seedSession(session({ phase: 'failed', method, reason }))
    expect(screen.getByRole('alert').textContent).toContain(copy)
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })
})

describe('SSE patching', () => {
  it('agent-login keeps the newest live session and ignores a stale finished one', () => {
    applyAgentLoginEvent(client, session({ sessionId: 'new', phase: 'waiting' }))
    applyAgentLoginEvent(client, session({ sessionId: 'old', phase: 'failed' }))
    expect(client.getQueryData<LoginSession>(workspaceQueryKeys.agentLogin('claude', 'work'))?.sessionId).toBe('new')
    applyAgentLoginEvent(client, { not: 'a session' })
    expect(client.getQueryData<LoginSession>(workspaceQueryKeys.agentLogin('claude', 'work'))?.sessionId).toBe('new')
  })

  it('account-reconnected records the news, refetches what drew the card and toasts', () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    applyAccountReconnectedEvent(client, {
      provider: 'claude', profileId: 'work',
      resumed: { runs: [{ projectId: 'acme', runId: 'r2', title: 'Bump vite' }], managers: [] },
    })
    expect(client.getQueryData(workspaceQueryKeys.accountReconnected('claude', 'work'))).toMatchObject({ resumed: { runs: [{ runId: 'r2' }] } })
    const keys = invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey))
    expect(keys).toContain(JSON.stringify(workspaceQueryKeys.providerStatus))
    expect(keys).toContain(JSON.stringify(workspaceQueryKeys.agentProfiles))
    expect(keys).toContain(JSON.stringify(queryKeys.runs.all))
    expect(toasts).toHaveBeenCalledWith('Claude Code · Work is back — resumed 1', { action: { label: 'Review', href: '/p/acme/tasks/r2' } })
  })
})
