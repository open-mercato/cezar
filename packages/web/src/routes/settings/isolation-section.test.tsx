import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { IsolationSection } from './isolation-section'

const ISOLATION = {
  runtime: { ready: true, provider: 'podman', installed: true, machineRunning: true, reason: '' },
  enabled: true,
  effective: true,
  image: 'localhost/cezar-agent/base:latest',
  hasContainerfile: false,
  suggestions: [],
  resources: { shmSize: '1g' },
  credentials: { catalog: [], enabled: {}, custom: [], own: { enabled: {}, custom: [] } },
}

function json(body: unknown, code = 200) {
  return new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
}

let saves: unknown[] = []
let answerSave: ((response: Response) => void) | undefined

function serve() {
  saves = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.endsWith('/isolation') && method === 'GET') return json(ISOLATION)
      if (url.endsWith('/vault/status')) {
        return json({ installed: true, authenticated: true, reason: '', address: 'https://vault.test', mounts: ['kv'] })
      }
      if (url.includes('/vault/browse')) return json({ mount: 'kv', path: '', entries: [], fields: ['api_token'] })
      if (url.endsWith('/config') && method === 'PUT') {
        saves.push(JSON.parse(String(init?.body)))
        // The save answers only after its follow-up work, as it did with a dozen running task
        // containers to update: the page must not wait for it to show what was picked.
        return new Promise<Response>((resolve) => { answerSave = resolve })
      }
      return new Promise<never>(() => {})
    }),
  )
}

afterEach(() => {
  cleanup()
  resetToasts()
  vi.unstubAllGlobals()
  answerSave = undefined
})

function renderSection() {
  const client = createQueryClient()
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <IsolationSection />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

async function pickApiToken() {
  fireEvent.click(await screen.findByRole('button', { name: 'Add a secret…' }))
  fireEvent.click(await screen.findByRole('button', { name: 'api_token' }))
  fireEvent.click(screen.getByRole('button', { name: 'Add' }))
}

describe('Settings → Isolation: adding a Vault secret', () => {
  it('lists the secret as soon as Add is pressed, before the save has answered', async () => {
    serve()
    renderSection()
    await pickApiToken()

    const row = await screen.findByText('API_TOKEN')
    expect(within(row.closest('[data-slot="secret-row"]') as HTMLElement).getByText('vault://kv/#api_token')).toBeTruthy()
    expect(saves).toEqual([
      { sandbox: { credentials: { custom: [{ id: 'kv/#api_token', env: ['API_TOKEN'], valueFrom: 'vault://kv/#api_token' }] } } },
    ])
    expect(answerSave).toBeDefined()
  })

  it('takes the secret back off the list when the save fails', async () => {
    serve()
    renderSection()
    await pickApiToken()
    await screen.findByText('API_TOKEN')

    answerSave?.(json({ error: 'config is read-only' }, 500))
    await waitFor(() => expect(screen.queryByText('API_TOKEN')).toBeNull())
    expect(await screen.findByText(/config is read-only/)).toBeTruthy()
  })
})
