import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ProviderStatusResponse } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { applyProviderStatusRow } from '@/lib/provider-status'
import { workspaceQueryKeys } from '@/api/queries'
import { ProviderSettings } from './provider-settings'

const ALL_STATUSES: ProviderStatusResponse = {
  providers: [
    { provider: 'claude', status: 'connected', enabled: true },
    { provider: 'codex', status: 'disconnected', enabled: true },
    { provider: 'opencode', status: 'not-installed', enabled: true },
  ],
}

let requests: Array<{ method: string; url: string; body?: unknown }> = []

function json(body: unknown, code = 200) {
  return new Response(JSON.stringify(body), {
    status: code,
    headers: { 'content-type': 'application/json' },
  })
}

function deferredResponse() {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function serve({
  status = ALL_STATUSES,
  refreshStatus,
  statusCode = 200,
  refreshStatusCode,
  connect = { opened: true, command: 'codex login' },
  connectCode = 200,
  enabledResponses = [],
  retry = status,
  retryCode = 200,
}: {
  status?: unknown
  refreshStatus?: unknown
  statusCode?: number
  refreshStatusCode?: number
  connect?: unknown
  connectCode?: number
  enabledResponses?: Array<Response | Promise<Response>>
  retry?: unknown
  retryCode?: number
} = {}) {
  requests = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined
      requests.push({ method, url, body })
      if (url.startsWith('/api/v1/providers/status') && method === 'GET') {
        const refreshing = url.endsWith('?refresh=1')
        return json(
          refreshing && refreshStatus !== undefined ? refreshStatus : status,
          refreshing ? (refreshStatusCode ?? statusCode) : statusCode,
        )
      }
      if (url === '/api/v1/providers/connect' && method === 'POST') {
        return json(connect, connectCode)
      }
      if (/^\/api\/v1\/providers\/(claude|codex|opencode|pi)\/enabled$/.test(url) && method === 'PUT') {
        return enabledResponses.shift() ?? json(status)
      }
      if (/^\/api\/v1\/providers\/(claude|codex|opencode|pi)\/retry$/.test(url) && method === 'POST') {
        return json(retry, retryCode)
      }
      return new Promise<never>(() => {})
    }),
  )
}

function renderSettings() {
  const client = createQueryClient()
  client.setDefaultOptions({
    queries: { ...client.getDefaultOptions().queries, retry: false },
  })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ProviderSettings />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return client
}

function card(provider: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-slot="provider-card"][data-provider="${provider}"]`)
  if (!found) throw new Error(`provider card ${provider} did not render`)
  return found
}

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

describe('ProviderSettings', () => {
  it('always renders Claude Code, Codex, OpenCode, and pi cards in that order', async () => {
    serve()
    renderSettings()

    await within(card('claude')).findByText('Credentials found')
    expect(
      [...document.querySelectorAll('[data-slot="provider-card"]')].map((item) =>
        item.querySelector('h3')?.textContent,
      ),
    ).toEqual(['Claude Code', 'Codex', 'OpenCode', 'pi'])
  })

  it('presents discovery truth, enablement, and runtime recovery without hiding diagnostics', async () => {
    serve({
      status: {
        providers: [
          { provider: 'claude', status: 'connected', enabled: true },
          { provider: 'codex', status: 'connected', enabled: false },
          {
            provider: 'opencode',
            status: 'disconnected',
            enabled: true,
            authFailureId: 'open-1',
            hint: 'Authentication was rejected during a run. Reconnect, then try again.',
          },
        ],
      },
      refreshStatus: {
        providers: [
          { provider: 'claude', status: 'connected', enabled: true },
          { provider: 'codex', status: 'connected', enabled: false },
          {
            provider: 'opencode',
            status: 'disconnected',
            enabled: true,
            authFailureId: 'open-1',
            hint: 'Authentication was rejected during a run. Reconnect, then try again.',
          },
        ],
      },
    })
    renderSettings()

    await within(card('claude')).findByText('Credentials found')
    expect(within(card('claude')).getByText('Credentials found').previousElementSibling?.getAttribute('data-tone')).toBe(
      'success',
    )
    expect(within(card('claude')).queryByRole('button', { name: 'Connect' })).toBeNull()
    expect(screen.getByRole('switch', { name: 'Use Claude Code' })).toBeTruthy()

    expect(within(card('codex')).getByText('Credentials found').previousElementSibling?.getAttribute('data-tone')).toBe('success')
    expect(within(card('codex')).getByText('Disabled')).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Use Codex' })).toBeTruthy()

    expect(within(card('opencode')).getByRole('button', { name: 'Connect' })).toBeTruthy()
    expect(within(card('opencode')).getByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(within(card('opencode')).getByText(/cezar cannot validate.*task/i)).toBeTruthy()
    fireEvent.click(within(card('opencode')).getByRole('button', { name: 'Check again' }))
    await within(card('opencode')).findByText('Not connected')
    expect(within(card('opencode')).getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('describes unknown as a verification failure and never as disconnected', async () => {
    serve({
      status: {
        providers: [
          { provider: 'claude', status: 'connected', enabled: true },
          { provider: 'codex', status: 'unknown', enabled: true },
          { provider: 'opencode', status: 'connected', enabled: true },
        ],
      },
    })
    renderSettings()

    await within(card('codex')).findByText('Could not verify')
    expect(within(card('codex')).getByText(/verification failed/i)).toBeTruthy()
    expect(within(card('codex')).getByRole('button', { name: 'Check again' })).toBeTruthy()
    expect(within(card('codex')).queryByText('Not connected')).toBeNull()
    expect(within(card('codex')).queryByRole('button', { name: 'Connect' })).toBeNull()
  })

  it('connects with only the provider id, then explains the terminal flow and refreshes status', async () => {
    serve()
    renderSettings()
    const connect = await within(card('codex')).findByRole('button', { name: 'Connect' })

    fireEvent.click(connect)

    await waitFor(() =>
      expect(document.querySelector('[data-slot="toast"]')?.textContent).toContain(
        'Finish signing in in the terminal, then check again.',
      ),
    )
    expect(requests.find((request) => request.method === 'POST')).toEqual({
      method: 'POST',
      url: '/api/v1/providers/connect',
      body: { provider: 'codex' },
    })
    await waitFor(() =>
      expect(requests.filter((request) => request.url === '/api/v1/providers/status')).toHaveLength(2),
    )
  })

  it('shows and copies the server command exactly when terminal launch is unavailable', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    serve({
      connectCode: 409,
      connect: { error: 'No terminal emulator was found.', command: 'codex login --device-auth' },
    })
    renderSettings()
    fireEvent.click(await within(card('codex')).findByRole('button', { name: 'Connect' }))

    const fallback = await screen.findByRole('region', { name: 'Codex manual sign-in' })
    expect(within(fallback).getByText('No terminal emulator was found.')).toBeTruthy()
    expect(within(fallback).getByText('codex login --device-auth').tagName).toBe('CODE')
    fireEvent.click(within(fallback).getByRole('button', { name: 'Copy command' }))
    expect(writeText).toHaveBeenCalledOnce()
    expect(writeText).toHaveBeenCalledWith('codex login --device-auth')
  })

  it('removes a manual command once Check again verifies the provider is connected', async () => {
    serve({
      connectCode: 409,
      connect: { error: 'Run this command manually.', command: 'codex login --device-auth' },
      refreshStatus: {
        providers: [
          { provider: 'claude', status: 'connected', enabled: true },
          { provider: 'codex', status: 'connected', enabled: true },
          { provider: 'opencode', status: 'not-installed', enabled: true },
        ],
      },
    })
    renderSettings()
    fireEvent.click(await within(card('codex')).findByRole('button', { name: 'Connect' }))

    const fallback = await screen.findByRole('region', { name: 'Codex manual sign-in' })
    expect(within(fallback).getByText('codex login --device-auth')).toBeTruthy()
    fireEvent.click(within(card('codex')).getByRole('button', { name: 'Check again' }))

    await within(card('codex')).findByText('Credentials found')
    expect(screen.queryByRole('region', { name: 'Codex manual sign-in' })).toBeNull()
    expect(screen.queryByText('codex login --device-auth')).toBeNull()
  })

  it('keeps provider settings visible when status loading fails and offers an honest retry', async () => {
    serve({ status: { error: 'provider probe failed' }, statusCode: 500 })
    renderSettings()

    expect(await screen.findByText('Provider status could not be loaded')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(document.querySelectorAll('[data-slot="provider-card"]')).toHaveLength(4)
  })

  it('treats a malformed successful response as a safe verification error', async () => {
    const secret = 'unexpected-provider-payload'
    serve({ status: { providers: [null, { provider: 'future', status: secret }] } })
    renderSettings()

    expect(await screen.findByText('Provider status could not be loaded')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(document.querySelectorAll('[data-slot="provider-card"]')).toHaveLength(4)
    expect(screen.queryByText(secret)).toBeNull()
  })

  it('Check again performs an explicit refreshed status request', async () => {
    serve()
    renderSettings()

    fireEvent.click(await within(card('codex')).findByRole('button', { name: 'Check again' }))
    await waitFor(() =>
      expect(requests.some((request) => request.url === '/api/v1/providers/status?refresh=1')).toBe(true),
    )
  })

  it('surfaces a failed Check again without replacing the cached provider state', async () => {
    serve({
      refreshStatus: { error: 'Provider refresh failed.' },
      refreshStatusCode: 500,
    })
    renderSettings()

    const codexCard = card('codex')
    fireEvent.click(await within(codexCard).findByRole('button', { name: 'Check again' }))
    await waitFor(() =>
      expect(requests.some((request) => request.url === '/api/v1/providers/status?refresh=1')).toBe(true),
    )

    expect(within(codexCard).getByText('Not connected')).toBeTruthy()
    expect(within(codexCard).queryByText('Connected')).toBeNull()
    expect(within(codexCard).getByRole('button', { name: 'Connect' })).toBeTruthy()
    const failure = await screen.findByText('Provider refresh failed.')
    expect(failure.closest('[data-slot="toast"]')?.getAttribute('data-tone')).toBe('danger')
  })

  it('updates enablement immediately and restores the confirmed state when a write fails', async () => {
    const failure = deferredResponse()
    serve({ enabledResponses: [failure.promise] })
    renderSettings()

    const toggle = await screen.findByRole('switch', { name: 'Use Claude Code' })
    await within(card('claude')).findByText('Credentials found')
    fireEvent.click(toggle)
    expect(await within(card('claude')).findByText('Disabled')).toBeTruthy()
    expect(requests).toContainEqual({
      method: 'PUT',
      url: '/api/v1/providers/claude/enabled',
      body: { enabled: false },
    })

    await act(() => failure.resolve(json({ error: 'Provider preference could not be saved.' }, 500)))
    await waitFor(() => expect(within(card('claude')).queryByText('Disabled')).toBeNull())
    expect(await screen.findByText('Provider preference could not be saved.')).toBeTruthy()
  })

  it('serializes rapid enablement toggles', async () => {
    const first = deferredResponse()
    const second = deferredResponse()
    serve({ enabledResponses: [first.promise, second.promise] })
    renderSettings()

    const toggle = await screen.findByRole('switch', { name: 'Use Claude Code' })
    await within(card('claude')).findByText('Credentials found')
    fireEvent.click(toggle)
    await within(card('claude')).findByText('Disabled')
    fireEvent.click(toggle)
    await waitFor(() => expect(requests.filter((request) => request.url.endsWith('/enabled'))).toHaveLength(1))

    await act(() => first.resolve(json({
      providers: [
        { provider: 'claude', status: 'connected', enabled: false },
        { provider: 'codex', status: 'disconnected', enabled: true },
        { provider: 'opencode', status: 'not-installed', enabled: true },
      ],
    })))
    await waitFor(() => expect(requests.filter((request) => request.url.endsWith('/enabled'))).toHaveLength(2))
    expect(requests.filter((request) => request.url.endsWith('/enabled')).map((request) => request.body)).toEqual([
      { enabled: false },
      { enabled: true },
    ])
    await act(() => second.resolve(json(ALL_STATUSES)))
  })

  it('does not let an earlier failed write roll back a later confirmed toggle', async () => {
    const first = deferredResponse()
    const second = deferredResponse()
    serve({ enabledResponses: [first.promise, second.promise] })
    renderSettings()

    const toggle = await screen.findByRole('switch', { name: 'Use Claude Code' })
    await within(card('claude')).findByText('Credentials found')
    fireEvent.click(toggle)
    await within(card('claude')).findByText('Disabled')
    fireEvent.click(toggle)
    await act(() => first.resolve(json({ error: 'first write failed' }, 500)))
    await waitFor(() => expect(requests.filter((request) => request.url.endsWith('/enabled'))).toHaveLength(2))
    await act(() => second.resolve(json(ALL_STATUSES)))

    await waitFor(() => expect(within(card('claude')).queryByText('Disabled')).toBeNull())
    expect(screen.queryByText('first write failed')).toBeNull()
  })

  it('rolls back and reports a failed Claude write despite a later Codex write', async () => {
    const claudeFailure = deferredResponse()
    const codexSuccess = deferredResponse()
    serve({ enabledResponses: [claudeFailure.promise, codexSuccess.promise] })
    renderSettings()

    await screen.findByRole('switch', { name: 'Use Claude Code' })
    fireEvent.click(screen.getByRole('switch', { name: 'Use Claude Code' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Use Codex' }))

    await act(() => claudeFailure.resolve(json({ error: 'Claude preference failed.' }, 500)))
    await within(card('claude')).findByText('Credentials found')
    expect(await screen.findByText('Claude preference failed.')).toBeTruthy()

    await act(() => codexSuccess.resolve(json({
      providers: [
        { provider: 'claude', status: 'connected', enabled: true },
        { provider: 'codex', status: 'disconnected', enabled: false },
        { provider: 'opencode', status: 'not-installed', enabled: true },
      ],
    })))
    await within(card('codex')).findByText('Disabled')
  })

  it('serializes cross-provider writes and retains both confirmed preferences', async () => {
    const first = deferredResponse()
    const second = deferredResponse()
    serve({ enabledResponses: [first.promise, second.promise] })
    renderSettings()

    await screen.findByRole('switch', { name: 'Use Claude Code' })
    fireEvent.click(screen.getByRole('switch', { name: 'Use Claude Code' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Use Codex' }))

    await waitFor(() => expect(requests.filter((request) => request.url.endsWith('/enabled'))).toHaveLength(1))
    expect(requests.at(-1)).toMatchObject({ url: '/api/v1/providers/claude/enabled', body: { enabled: false } })

    await act(() => first.resolve(json({
      providers: [
        { provider: 'claude', status: 'connected', enabled: false },
        { provider: 'codex', status: 'disconnected', enabled: true },
        { provider: 'opencode', status: 'not-installed', enabled: true },
      ],
    })))
    await waitFor(() => expect(requests.filter((request) => request.url.endsWith('/enabled'))).toHaveLength(2))
    expect(requests.at(-1)).toMatchObject({ url: '/api/v1/providers/codex/enabled', body: { enabled: false } })

    await act(() => second.resolve(json({
      providers: [
        { provider: 'claude', status: 'connected', enabled: false },
        { provider: 'codex', status: 'disconnected', enabled: false },
        { provider: 'opencode', status: 'not-installed', enabled: true },
      ],
    })))
    await within(card('claude')).findByText('Disabled')
    await within(card('codex')).findByText('Disabled')
  })

  it('preserves a successful retry when a pending enablement write fails', async () => {
    const failure = deferredResponse()
    const incidentStatus = {
      providers: [
        {
          provider: 'claude' as const,
          status: 'disconnected' as const,
          enabled: true,
          authFailureId: 'incident-1',
          hint: 'Authentication was rejected during a run. Reconnect, then try again.',
        },
        { provider: 'codex' as const, status: 'disconnected' as const, enabled: true },
        { provider: 'opencode' as const, status: 'not-installed' as const, enabled: true },
      ],
    }
    serve({
      status: incidentStatus,
      enabledResponses: [failure.promise],
      retry: {
        providers: [
          { provider: 'claude', status: 'connected', enabled: true },
          { provider: 'codex', status: 'disconnected', enabled: true },
          { provider: 'opencode', status: 'not-installed', enabled: true },
        ],
      },
    })
    renderSettings()

    const toggle = await screen.findByRole('switch', { name: 'Use Claude Code' })
    fireEvent.click(toggle)
    await within(card('claude')).findByText('Disabled')
    fireEvent.click(within(card('claude')).getByRole('button', { name: 'Try again' }))
    await within(card('claude')).findByText('Credentials found')

    await act(() => failure.resolve(json({ error: 'Provider preference could not be saved.' }, 500)))
    await within(card('claude')).findByText('Credentials found')
    expect(within(card('claude')).queryByText('Disabled')).toBeNull()
    expect(within(card('claude')).queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('preserves a newer runtime incident from the provider-status cache when a toggle fails', async () => {
    const failure = deferredResponse()
    serve({ enabledResponses: [failure.promise] })
    const client = renderSettings()

    const toggle = await screen.findByRole('switch', { name: 'Use Claude Code' })
    await within(card('claude')).findByText('Credentials found')
    fireEvent.click(toggle)
    await within(card('claude')).findByText('Disabled')
    act(() => {
      client.setQueryData<ProviderStatusResponse>(workspaceQueryKeys.providerStatus, (current) =>
        applyProviderStatusRow(current, {
          provider: 'claude',
          status: 'disconnected',
          hint: 'Authentication was rejected during a run. Reconnect, then try again.',
          authFailureId: 'incident-2',
        }),
      )
    })
    await within(card('claude')).findByRole('button', { name: 'Try again' })

    await act(() => failure.resolve(json({ error: 'Provider preference could not be saved.' }, 500)))
    await within(card('claude')).findByText('Not connected')
    expect(within(card('claude')).getByText(/Reconnect, then try again/)).toBeTruthy()
    expect(within(card('claude')).queryByText('Disabled')).toBeNull()
    expect(client.getQueryData<ProviderStatusResponse>(workspaceQueryKeys.providerStatus)?.providers[0]).toMatchObject({
      enabled: true,
      authFailureId: 'incident-2',
    })
  })

  it('retries only the visible runtime incident and replaces the cached status', async () => {
    const incidentStatus = {
      providers: [
        { provider: 'claude', status: 'connected', enabled: true },
        { provider: 'codex', status: 'disconnected', enabled: true },
        { provider: 'opencode', status: 'disconnected', enabled: false, authFailureId: 'open-1' },
      ],
    }
    serve({
      status: incidentStatus,
      retry: {
        providers: [
          { provider: 'claude', status: 'connected', enabled: true },
          { provider: 'codex', status: 'disconnected', enabled: true },
          { provider: 'opencode', status: 'connected', enabled: false },
        ],
      },
    })
    renderSettings()

    fireEvent.click(await within(card('opencode')).findByRole('button', { name: 'Try again' }))
    await waitFor(() =>
      expect(requests).toContainEqual({
        method: 'POST',
        url: '/api/v1/providers/opencode/retry',
        body: { authFailureId: 'open-1' },
      }),
    )
    expect(await within(card('opencode')).findByText('Credentials found')).toBeTruthy()
    expect(within(card('opencode')).getByText('Disabled')).toBeTruthy()
  })

  it('keeps a stale retry incident visible and reports the server error', async () => {
    const incidentStatus = {
      providers: [
        { provider: 'claude', status: 'connected', enabled: true },
        { provider: 'codex', status: 'disconnected', enabled: true, authFailureId: 'newer-incident' },
        { provider: 'opencode', status: 'not-installed', enabled: true },
      ],
    }
    serve({ status: incidentStatus, retry: { error: 'That incident is no longer current.' }, retryCode: 409 })
    renderSettings()

    fireEvent.click(await within(card('codex')).findByRole('button', { name: 'Try again' }))
    expect(await within(card('codex')).findByText('Not connected')).toBeTruthy()
    expect(within(card('codex')).getByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(await screen.findByText('That incident is no longer current.')).toBeTruthy()
  })
})
