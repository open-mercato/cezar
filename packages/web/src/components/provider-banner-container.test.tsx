import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { workspaceQueryKeys } from '@/api/queries'
import type { ProviderStatusResponse, WorkspaceUiState } from '@open-mercato/cezar-api-client'
import { ProviderBannerContainer } from '@/components/provider-banner-container'
import { resetToasts, Toaster } from '@/components/ui/toaster'

const fetchMock = vi.fn<typeof fetch>()

const INCIDENTS: ProviderStatusResponse = {
  providers: [
    { provider: 'claude', status: 'disconnected', enabled: true, authFailureId: 'claude-1' },
    { provider: 'codex', status: 'connected', enabled: true },
    { provider: 'opencode', status: 'disconnected', enabled: true, authFailureId: 'open-1' },
  ],
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function seed(
  client: QueryClient,
  uiState: WorkspaceUiState = {},
  providers: ProviderStatusResponse = INCIDENTS,
): void {
  client.setQueryData(workspaceQueryKeys.providerStatus, providers)
  client.setQueryData(workspaceQueryKeys.uiState, uiState)
}

function renderContainer(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/p/cezar/']}>
        <ProviderBannerContainer />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('ProviderBannerContainer', () => {
  it('persists dismissals optimistically and keeps them hidden after remount', async () => {
    const client = createQueryClient()
    seed(client, { appearance: { accent: 'violet' } })
    fetchMock.mockResolvedValue(json({
      appearance: { accent: 'violet' },
      dismissedProviderAuthFailures: {
        claude: 'claude-1',
        opencode: 'open-1',
      },
    }))
    const view = renderContainer(client)

    fireEvent.click(screen.getByRole('button', {
      name: 'Dismiss provider authentication alert',
    }))

    expect(client.getQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState)).toMatchObject({
      appearance: { accent: 'violet' },
      dismissedProviderAuthFailures: {
        claude: 'claude-1',
        opencode: 'open-1',
      },
    })
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/v1/workspace/ui-state',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({
            dismissedProviderAuthFailures: {
              claude: 'claude-1',
              opencode: 'open-1',
            },
          }),
        }),
      ),
    )
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())

    const persisted = client.getQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState)
    view.unmount()
    const reloadedClient = createQueryClient()
    seed(reloadedClient, persisted)
    renderContainer(reloadedClient)

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('restores the previous cache and reports a failed dismissal', async () => {
    const client = createQueryClient()
    const previous: WorkspaceUiState = { appearance: { accent: 'lime' } }
    seed(client, previous)
    let answerPut: ((response: Response) => void) | undefined
    const putResponse = new Promise<Response>((resolve) => {
      answerPut = resolve
    })
    fetchMock.mockImplementation(async (_input, init) => {
      if (init?.method === 'PUT') return putResponse
      return json(previous)
    })
    renderContainer(client)

    fireEvent.click(screen.getByRole('button', {
      name: 'Dismiss provider authentication alert',
    }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())

    answerPut?.(json({ error: 'could not save auth dismissals' }, 500))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Claude Code, OpenCode')
    expect(client.getQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState)).toEqual(previous)
    const error = screen.getByRole('status')
    expect(error.textContent).toBe('could not save auth dismissals')
    expect(error.getAttribute('data-tone')).toBe('danger')
  })

  it('restores the last server-confirmed cache when two queued dismissals fail', async () => {
    const client = createQueryClient()
    const confirmed: WorkspaceUiState = { appearance: { accent: 'lime' } }
    seed(client, confirmed, {
      providers: [
        { provider: 'claude', status: 'disconnected', enabled: true, authFailureId: 'claude-1' },
        { provider: 'codex', status: 'connected', enabled: true },
        { provider: 'opencode', status: 'disconnected', enabled: true },
      ],
    })
    const answerPuts: Array<(response: Response) => void> = []
    fetchMock.mockImplementation(async (_input, init) => {
      if (init?.method === 'PUT') {
        return new Promise<Response>((resolve) => answerPuts.push(resolve))
      }
      return json({ error: 'could not reconcile auth dismissals' }, 500)
    })
    renderContainer(client)

    fireEvent.click(screen.getByRole('button', {
      name: 'Dismiss provider authentication alert',
    }))
    await waitFor(() => expect(answerPuts).toHaveLength(1))

    act(() => {
      client.setQueryData<ProviderStatusResponse>(workspaceQueryKeys.providerStatus, {
        providers: [
          { provider: 'claude', status: 'disconnected', enabled: true, authFailureId: 'claude-1' },
          { provider: 'codex', status: 'connected', enabled: true },
          { provider: 'opencode', status: 'disconnected', enabled: true, authFailureId: 'open-1' },
        ],
      })
    })
    const secondAlert = await screen.findByRole('alert')
    expect(secondAlert.textContent).toContain(
      'Provider authentication failed during a task: OpenCode.',
    )
    fireEvent.click(screen.getByRole('button', {
      name: 'Dismiss provider authentication alert',
    }))

    expect(answerPuts).toHaveLength(1)
    answerPuts[0]?.(json({ error: 'first dismissal failed' }, 500))
    await waitFor(() => expect(answerPuts).toHaveLength(2))
    answerPuts[1]?.(json({ error: 'second dismissal failed' }, 500))

    const restoredAlert = await screen.findByRole('alert')
    await waitFor(() =>
      expect(restoredAlert.textContent).toContain(
        'Provider authentication failed during a task: Claude Code, OpenCode.',
      ),
    )
    expect(client.getQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState)).toEqual(confirmed)
  })

  it('shows incidents while workspace UI state is unavailable or malformed', () => {
    const unavailableClient = createQueryClient()
    unavailableClient.setQueryData(workspaceQueryKeys.providerStatus, INCIDENTS)
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}))
    const first = renderContainer(unavailableClient)

    expect(screen.getByRole('alert')).toBeTruthy()

    first.unmount()
    const malformedClient = createQueryClient()
    seed(malformedClient, {
      dismissedProviderAuthFailures: ['claude-1'],
    } as unknown as WorkspaceUiState)
    renderContainer(malformedClient)

    expect(screen.getByRole('alert')).toBeTruthy()
  })
})
