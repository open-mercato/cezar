import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { GithubLoginState, GithubOwnersResponse } from '@open-mercato/cezar-api-client'
import { ConnectGithubDialog, PublishGithubDialog } from '@/components/first-run'

/**
 * Connect GitHub and Publish to GitHub (spec 2026-10-26-first-run-onboarding, "Sign in does the
 * work"), driven through a stubbed `fetch`. What these pin down is the device flow from the
 * user's side: the code is shown and copyable, the dialog follows the login to its end, every
 * failure says what to do next, and nothing reacts to a login that is not this dialog's own.
 */

const toastMock = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/toaster', () => ({ toast: toastMock }))
vi.mock('@/api/global-events', () => ({ onWorkspaceEvent: () => () => undefined }))

const fetchMock = vi.fn<typeof fetch>()
const calls: string[] = []

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  toastMock.mockReset()
  calls.length = 0
  vi.unstubAllGlobals()
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const PENDING: GithubLoginState = { status: 'pending', code: 'C4AD-605F', url: 'https://github.com/login/device' }

function serve(opts: {
  start?: () => Response
  reads?: GithubLoginState[]
  owners?: GithubOwnersResponse[]
  localHandoff?: boolean
}) {
  const reads = [...(opts.reads ?? [PENDING])]
  const owners = [...(opts.owners ?? [{ available: false, reason: 'gh is not authenticated' }])]
  fetchMock.mockImplementation(async (input, init) => {
    const url = new URL(String(input), 'http://localhost')
    const method = String(init?.method ?? 'GET')
    calls.push(`${method} ${url.pathname}`)
    if (url.pathname === '/api/v1/github/login' && method === 'POST') return opts.start ? opts.start() : json(PENDING)
    if (url.pathname === '/api/v1/github/login' && method === 'GET') return json(reads.length > 1 ? reads.shift() : reads[0])
    if (url.pathname === '/api/v1/github/login' && method === 'DELETE') return json({ status: 'idle' })
    if (url.pathname === '/api/v1/projects/github-owners') return json(owners.length > 1 ? owners.shift() : owners[0])
    if (url.pathname === '/api/v1/health') return json({ capabilities: { localHandoff: opts.localHandoff ?? true } })
    return json({ error: `unexpected ${method} ${url.pathname}` }, 404)
  })
}

function renderConnect() {
  const onOpenChange = vi.fn()
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <ConnectGithubDialog onOpenChange={onOpenChange} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { onOpenChange }
}

describe('Connect GitHub', () => {
  it('starts the login itself and shows the one-time code, copyable, with GitHub one click away', async () => {
    serve({})
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    renderConnect()

    expect(await screen.findByTestId('github-login-code')).toHaveProperty('textContent', 'C4AD-605F')
    expect(screen.getByText('Enter this code on GitHub. It opened in your browser.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open GitHub' }).getAttribute('href')).toBe('https://github.com/login/device')
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('C4AD-605F'))
    expect(toastMock).toHaveBeenCalledWith('Copied')
  })

  it('reads nothing before its own login has started, so an earlier login cannot close it', async () => {
    serve({ reads: [PENDING] })
    renderConnect()
    await screen.findByTestId('github-login-code')
    const loginCalls = calls.filter((call) => call.endsWith('/github/login'))
    expect(loginCalls[0]).toBe('POST /api/v1/github/login')
  })

  it('closes itself when GitHub approves, and says which account', async () => {
    serve({ reads: [{ status: 'done', login: 'octo' }] })
    const { onOpenChange } = renderConnect()
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(toastMock).toHaveBeenCalledWith('GitHub connected as octo')
  })

  it('without the GitHub CLI, links its install page and tries again on request', async () => {
    serve({ start: () => json({ error: 'gh CLI not found', notFound: true }, 503) })
    renderConnect()
    expect(await screen.findByRole('link', { name: 'Install the GitHub CLI' })).toBeTruthy()
    expect(screen.getByText('The GitHub CLI is not installed.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(calls.filter((call) => call === 'POST /api/v1/github/login')).toHaveLength(2))
  })

  it('shows why a login failed — an expired code, no network — and starts a new one on Try again', async () => {
    serve({ reads: [{ status: 'failed', error: 'The code expired. Try again for a new one.' }] })
    renderConnect()
    expect((await screen.findByRole('alert')).textContent).toBe('The code expired. Try again for a new one.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(calls.filter((call) => call === 'POST /api/v1/github/login')).toHaveLength(2))
  })

  it('reports a failure gh hit before any code, from the start request itself', async () => {
    serve({ start: () => json({ error: 'GitHub could not be reached. Check your connection and try again.' }, 500) })
    renderConnect()
    expect((await screen.findByRole('alert')).textContent).toBe('GitHub could not be reached. Check your connection and try again.')
  })

  it('Cancel stops the login on the server and closes', async () => {
    serve({})
    const { onOpenChange } = renderConnect()
    await screen.findByTestId('github-login-code')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    await waitFor(() => expect(calls).toContain('DELETE /api/v1/github/login'))
  })

  it('in a hosted cockpit shows why the server will not sign its own gh in', async () => {
    serve({ start: () => json({ error: 'Sign in to GitHub on the machine hosting cezar: run gh auth login there.' }, 409) })
    renderConnect()
    expect((await screen.findByRole('alert')).textContent).toBe('Sign in to GitHub on the machine hosting cezar: run gh auth login there.')
  })

  it('still says what to do when copying is not allowed', async () => {
    serve({})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) } })
    renderConnect()
    await screen.findByTestId('github-login-code')
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('Select the code and copy it'))
  })
})

describe('Publish to GitHub', () => {
  function renderPublish() {
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <PublishGithubDialog folder="notes app" onOpenChange={vi.fn()} />
        </MemoryRouter>
      </QueryClientProvider>,
    )
  }

  it('signs gh in first when it is not, then offers the accounts and the repository name', async () => {
    serve({
      reads: [{ status: 'done', login: 'octo' }],
      owners: [{ available: false, reason: 'gh is not authenticated' }, { available: true, owners: [{ login: 'octo', personal: true }] }],
    })
    renderPublish()
    expect(await screen.findByRole('radiogroup', { name: 'Owner' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'octo' }).getAttribute('aria-checked')).toBe('true')
    expect((screen.getByLabelText('Repository name') as HTMLInputElement).value).toBe('notes-app')
    expect(calls).toContain('POST /api/v1/github/login')
  })

  it('says why when gh is signed in but GitHub still lists no account', async () => {
    serve({
      reads: [{ status: 'done' }],
      owners: [{ available: false, reason: 'gh is not authenticated' }, { available: false, reason: 'GitHub API rate limit exceeded' }],
    })
    renderPublish()
    expect((await screen.findByRole('alert')).textContent).toBe('GitHub API rate limit exceeded')
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy()
  })

  it('does not start a login when gh is already signed in', async () => {
    serve({ owners: [{ available: true, owners: [{ login: 'octo', personal: true }] }] })
    renderPublish()
    await screen.findByRole('radiogroup', { name: 'Owner' })
    expect(calls).not.toContain('POST /api/v1/github/login')
  })
})
