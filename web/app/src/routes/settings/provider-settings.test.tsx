import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ProviderStatusResponse } from '@/api/types'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { ProviderSettings } from './provider-settings'

const ALL_STATUSES: ProviderStatusResponse = {
  providers: [
    { provider: 'claude', status: 'connected' },
    { provider: 'codex', status: 'disconnected' },
    { provider: 'opencode', status: 'not-installed' },
  ],
}

let requests: Array<{ method: string; url: string; body?: unknown }> = []

function serve({
  status = ALL_STATUSES,
  refreshStatus,
  statusCode = 200,
  connect = { opened: true, command: 'codex login' },
  connectCode = 200,
}: {
  status?: ProviderStatusResponse | { error: string }
  refreshStatus?: ProviderStatusResponse
  statusCode?: number
  connect?: unknown
  connectCode?: number
} = {}) {
  requests = []
  const json = (body: unknown, code = 200) =>
    new Response(JSON.stringify(body), {
      status: code,
      headers: { 'content-type': 'application/json' },
    })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined
      requests.push({ method, url, body })
      if (url.startsWith('/api/providers/status') && method === 'GET') {
        return json(url.endsWith('?refresh=1') && refreshStatus ? refreshStatus : status, statusCode)
      }
      if (url === '/api/providers/connect' && method === 'POST') {
        return json(connect, connectCode)
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
  it('always renders Claude Code, Codex, and OpenCode cards in that order', async () => {
    serve()
    renderSettings()

    await screen.findByText('Connected')
    expect(
      [...document.querySelectorAll('[data-slot="provider-card"]')].map((item) =>
        item.querySelector('h3')?.textContent,
      ),
    ).toEqual(['Claude Code', 'Codex', 'OpenCode'])
  })

  it('presents connected, disconnected, and not-installed states without false actions', async () => {
    serve()
    renderSettings()

    await screen.findByText('Connected')
    expect(within(card('claude')).getByText('Connected').previousElementSibling?.getAttribute('data-tone')).toBe(
      'success',
    )
    expect(within(card('claude')).queryByRole('button', { name: 'Connect' })).toBeNull()

    expect(within(card('codex')).getByText('Not connected').previousElementSibling?.getAttribute('data-tone')).toBe(
      'pending',
    )
    expect(within(card('codex')).getByRole('button', { name: 'Connect' })).toBeTruthy()
    expect(within(card('codex')).getByRole('button', { name: 'Check again' })).toBeTruthy()

    expect(within(card('opencode')).getByText('Not installed')).toBeTruthy()
    expect(within(card('opencode')).getByText(/install OpenCode/i)).toBeTruthy()
    expect(within(card('opencode')).queryByRole('button', { name: 'Connect' })).toBeNull()
  })

  it('describes unknown as a verification failure and never as disconnected', async () => {
    serve({
      status: {
        providers: [
          { provider: 'claude', status: 'connected' },
          { provider: 'codex', status: 'unknown' },
          { provider: 'opencode', status: 'connected' },
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
      url: '/api/providers/connect',
      body: { provider: 'codex' },
    })
    await waitFor(() =>
      expect(requests.filter((request) => request.url === '/api/providers/status')).toHaveLength(2),
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
          { provider: 'claude', status: 'connected' },
          { provider: 'codex', status: 'connected' },
          { provider: 'opencode', status: 'not-installed' },
        ],
      },
    })
    renderSettings()
    fireEvent.click(await within(card('codex')).findByRole('button', { name: 'Connect' }))

    const fallback = await screen.findByRole('region', { name: 'Codex manual sign-in' })
    expect(within(fallback).getByText('codex login --device-auth')).toBeTruthy()
    fireEvent.click(within(card('codex')).getByRole('button', { name: 'Check again' }))

    await within(card('codex')).findByText('Connected')
    expect(screen.queryByRole('region', { name: 'Codex manual sign-in' })).toBeNull()
    expect(screen.queryByText('codex login --device-auth')).toBeNull()
  })

  it('keeps provider settings visible when status loading fails and offers an honest retry', async () => {
    serve({ status: { error: 'provider probe failed' }, statusCode: 500 })
    renderSettings()

    expect(await screen.findByText('Provider status could not be loaded')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(document.querySelectorAll('[data-slot="provider-card"]')).toHaveLength(3)
  })

  it('Check again performs an explicit refreshed status request', async () => {
    serve()
    renderSettings()

    fireEvent.click(await within(card('codex')).findByRole('button', { name: 'Check again' }))
    await waitFor(() =>
      expect(requests.some((request) => request.url === '/api/providers/status?refresh=1')).toBe(true),
    )
  })
})
