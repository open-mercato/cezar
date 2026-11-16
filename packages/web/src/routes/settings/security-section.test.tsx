import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type { SecurityLanStatus } from '@open-mercato/cezar-api-client'
import { ThemeProvider } from '@/components/theme-provider'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { AppRoutes } from '@/routes'

let requests: Array<{ method: string; url: string; body?: unknown }> = []

function serve(
  overrides: Partial<SecurityLanStatus> = {},
  options: { putError?: string; putStatus?: number } = {},
) {
  requests = []
  const state: SecurityLanStatus = {
    available: true,
    editable: true,
    lanAccess: false,
    active: false,
    authConfigured: false,
    username: null,
    port: 4321,
    tlsEnabled: false,
    lanIp: null,
    lanUrls: [],
    certFingerprint: null,
    error: null,
    ...overrides,
  }

  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    })

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
      requests.push({ method, url, body })

      if (url === '/api/v1/security/lan' && method === 'GET') {
        return json(state)
      }
      if (url === '/api/v1/security/lan' && method === 'PUT') {
        if (options.putError) {
          return json({ error: options.putError }, options.putStatus ?? 400)
        }
        if (body && typeof body.lanAccess === 'boolean') {
          state.lanAccess = body.lanAccess
          if (body.lanAccess) {
            state.active = true
            state.authConfigured = true
            state.lanUrls = ['https://192.168.1.10:4321']
            state.certFingerprint = 'AA:BB:CC:DD:EE:FF'
          } else {
            state.active = false
          }
        }
        if (body && typeof body.username === 'string') {
          state.username = body.username
        }
        return json(state)
      }
      return new Promise<never>(() => {})
    }),
  )
}

function renderSecurity() {
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, { bootProject: 'boot' })
  client.setQueryData(workspaceQueryKeys.projects, {
    projects: [],
    bootProject: 'boot',
    projectsDir: '~/cezar/projects',
  })
  render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={['/settings/global/security']}>
          <AppRoutes />
          <Toaster />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  )
}

const puts = () => requests.filter((r) => r.method === 'PUT' && r.url === '/api/v1/security/lan')

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

describe('Global settings → Security', () => {
  it('hosted (available: false) renders the notice and no form', async () => {
    serve({ available: false })
    renderSecurity()

    expect(
      await screen.findByText(/LAN access is not available on a hosted cockpit/),
    ).toBeTruthy()
    expect(screen.queryByRole('switch', { name: 'Allow LAN access' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save & apply' })).toBeNull()
  })

  it('non-editable renders read-only status and notice without form', async () => {
    serve({
      available: true,
      editable: false,
      lanAccess: true,
      active: true,
      lanUrls: ['https://192.168.1.50:4321'],
      certFingerprint: '11:22:33:44:55:66',
    })
    renderSecurity()

    expect(
      await screen.findByText('LAN access can only be changed from the machine running cezar.'),
    ).toBeTruthy()
    expect(screen.getByText(/Active —/)).toBeTruthy()
    expect(screen.getByText('https://192.168.1.50:4321')).toBeTruthy()
    expect(screen.getByText('11:22:33:44:55:66')).toBeTruthy()

    expect(screen.queryByRole('switch', { name: 'Allow LAN access' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save & apply' })).toBeNull()
  })

  it('enabling without credentials shows validation errors and does not call putSecurityLan', async () => {
    serve({
      available: true,
      editable: true,
      lanAccess: false,
      authConfigured: false,
      username: null,
    })
    renderSecurity()

    const toggle = await screen.findByRole('switch', { name: 'Allow LAN access' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    expect(screen.getByText(/The cockpit uses a self-signed certificate/)).toBeTruthy()

    const saveButton = screen.getByRole('button', { name: 'Save & apply' })
    fireEvent.click(saveButton)

    expect(await screen.findByText('Username is required')).toBeTruthy()
    expect(screen.getByText('Password is required')).toBeTruthy()
    expect(puts()).toHaveLength(0)
  })

  it('surfaces short password error and does not call putSecurityLan', async () => {
    serve({
      available: true,
      editable: true,
      lanAccess: false,
      authConfigured: false,
      username: null,
    })
    renderSecurity()

    const toggle = await screen.findByRole('switch', { name: 'Allow LAN access' })
    fireEvent.click(toggle)

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'alice' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'short' } })

    fireEvent.click(screen.getByRole('button', { name: 'Save & apply' }))

    expect(await screen.findByText('Password must be at least 8 characters')).toBeTruthy()
    expect(puts()).toHaveLength(0)
  })

  it('surfaces username containing ":" error', async () => {
    serve({
      available: true,
      editable: true,
      lanAccess: false,
      authConfigured: false,
      username: null,
    })
    renderSecurity()

    const toggle = await screen.findByRole('switch', { name: 'Allow LAN access' })
    fireEvent.click(toggle)

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'alice:admin' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'validpassword' } })

    fireEvent.click(screen.getByRole('button', { name: 'Save & apply' }))

    expect(await screen.findByText('Username must not contain ":"')).toBeTruthy()
    expect(puts()).toHaveLength(0)
  })

  it('a valid save calls putSecurityLan with exactly the expected body and shows active URLs/fingerprint', async () => {
    serve({
      available: true,
      editable: true,
      lanAccess: false,
      authConfigured: false,
      username: null,
    })
    renderSecurity()

    const toggle = await screen.findByRole('switch', { name: 'Allow LAN access' })
    fireEvent.click(toggle)

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'admin' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secretpass123' } })

    fireEvent.click(screen.getByRole('button', { name: 'Save & apply' }))

    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({
      lanAccess: true,
      username: 'admin',
      password: 'secretpass123',
    })

    expect(await screen.findByText('https://192.168.1.10:4321')).toBeTruthy()
    expect(screen.getByText('AA:BB:CC:DD:EE:FF')).toBeTruthy()
    expect(screen.getByText(/Active —/)).toBeTruthy()
    expect(screen.getByText('LAN access settings saved')).toBeTruthy()

    // Password field should be cleared
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('')
  })

  it('only sends username when changed or when sending password; only sends password when typed', async () => {
    serve({
      available: true,
      editable: true,
      lanAccess: true,
      active: true,
      authConfigured: true,
      username: 'admin',
      lanUrls: ['https://192.168.1.10:4321'],
    })
    renderSecurity()

    const toggle = await screen.findByRole('switch', { name: 'Allow LAN access' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    // Turning off without touching credentials only sends lanAccess: false
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    fireEvent.click(screen.getByRole('button', { name: 'Save & apply' }))

    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ lanAccess: false })
  })

  it('changing username without new password only sends lanAccess and username', async () => {
    serve({
      available: true,
      editable: true,
      lanAccess: true,
      active: true,
      authConfigured: true,
      username: 'admin',
      lanUrls: ['https://192.168.1.10:4321'],
    })
    renderSecurity()

    await screen.findByRole('switch', { name: 'Allow LAN access' })
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'bob' } })

    fireEvent.click(screen.getByRole('button', { name: 'Save & apply' }))

    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ lanAccess: true, username: 'bob' })
  })

  it('server error is surfaced through toast', async () => {
    serve(
      {
        available: true,
        editable: true,
        lanAccess: true,
        active: true,
        authConfigured: true,
        username: 'admin',
      },
      {
        putError: 'LAN access can only be changed from the machine running cezar.',
        putStatus: 409,
      },
    )
    renderSecurity()

    await screen.findByRole('switch', { name: 'Allow LAN access' })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'newpassword123' } })

    fireEvent.click(screen.getByRole('button', { name: 'Save & apply' }))

    expect(
      await screen.findByText('LAN access can only be changed from the machine running cezar.'),
    ).toBeTruthy()
  })

  it('renders status when off or error', async () => {
    serve({
      available: true,
      editable: true,
      lanAccess: false,
      active: false,
    })
    renderSecurity()

    expect(
      await screen.findByText('Only this machine can reach the cockpit (127.0.0.1).'),
    ).toBeTruthy()
  })

  it('renders status when lanAccess requested but not active', async () => {
    serve({
      available: true,
      editable: true,
      lanAccess: true,
      active: false,
      error: 'port 4321 already bound',
    })
    renderSecurity()

    expect(await screen.findByText('port 4321 already bound')).toBeTruthy()
  })
})
