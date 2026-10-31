import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { AiGatewayView, AiGatewaysResponse } from '@open-mercato/cezar-api-client'
import { AiGatewaysSection } from './ai-gateways-section'

let requests: Array<{ method: string; url: string; body?: unknown }> = []

const auth = { protocols: { 'openai-responses': 'bearer' as const }, catalog: 'bearer' as const }

function view(overrides: Partial<AiGatewayView> & Pick<AiGatewayView, 'id' | 'name'>): AiGatewayView {
  return {
    baseUrl: 'https://openrouter.ai/api/v1',
    protocols: ['openai-responses'],
    auth,
    enabled: false,
    hasApiKey: false,
    routingRevision: 'rev',
    ...overrides,
  }
}

function serve(initial: AiGatewaysResponse) {
  requests = []
  const state = structuredClone(initial)
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    requests.push({ method, url, body })
    if (!url.includes('/api/v1/ai-gateways')) return json({ error: 'unexpected' }, 404)
    if (method === 'GET') return json(state)
    if (method === 'POST') {
      const created = view({ id: '11111111-1111-4111-8111-111111111111', name: String(body?.name), baseUrl: String(body?.baseUrl), enabled: body?.enabled === true, hasApiKey: body?.apiKey !== undefined, protocols: body?.protocols as AiGatewayView['protocols'], auth: body?.auth as AiGatewayView['auth'] })
      state.gateways.push(created)
      return json(created)
    }
    if (method === 'PATCH') {
      const id = url.split('/').pop()
      const current = state.gateways.find((gateway) => gateway.id === id)
      if (!current) return json({ error: 'That AI gateway was not found.' }, 404)
      Object.assign(current, body)
      if (body?.apiKey !== undefined) current.hasApiKey = true
      delete current.pendingWrite
      return json(current)
    }
    if (method === 'DELETE') {
      const id = url.split('/').pop()
      state.gateways = state.gateways.filter((gateway) => gateway.id !== id)
      state.unavailable = state.unavailable.filter((row) => row.id !== id)
      return json({ removed: true })
    }
    return json({ error: 'no' }, 400)
  }))
}

function renderSection() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <AiGatewaysSection />
    </QueryClientProvider>,
  )
}

describe('General settings → AI Gateways', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    HTMLElement.prototype.hasPointerCapture = () => false
    HTMLElement.prototype.setPointerCapture = () => {}
    HTMLElement.prototype.releasePointerCapture = () => {}
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('shows an empty list when nothing is saved', async () => {
    serve({ gateways: [], unavailable: [], keyBackend: 'file' })
    renderSection()
    expect(await screen.findByText('No AI gateways yet.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add gateway' })).toBeTruthy()
  })

  it('lists gateways and turns one off without sending the key', async () => {
    serve({
      gateways: [
        view({ id: '550e8400-e29b-41d4-a716-446655440000', name: 'OpenRouter', provisioningKey: 'openrouter' }),
        view({ id: '550e8400-e29b-41d4-a716-446655440001', name: 'Sandbox', baseUrl: 'https://gateway.example/v1', enabled: true, hasApiKey: true }),
      ],
      unavailable: [],
      keyBackend: 'file',
    })
    renderSection()
    expect(await screen.findByText('OpenRouter')).toBeTruthy()
    expect(screen.getByText('API key saved')).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: 'Sandbox on' }))
    await waitFor(() => expect(requests.some((request) => request.method === 'PATCH')).toBe(true))
    const patch = requests.find((request) => request.method === 'PATCH')
    expect(patch?.body).toEqual({ enabled: false })
    expect(JSON.stringify(patch?.body)).not.toContain('sk-')
  })

  it('adds a gateway, strips a trailing slash, and omits a blank replacement key', async () => {
    serve({
      gateways: [view({ id: '550e8400-e29b-41d4-a716-446655440001', name: 'Sandbox', hasApiKey: true, baseUrl: 'https://gateway.example/v1' })],
      unavailable: [],
      keyBackend: 'file',
    })
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Sandbox' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' Renamed ' } })
    fireEvent.change(screen.getByLabelText('Replacement API key'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save gateway' }))
    await waitFor(() => expect(requests.some((request) => request.method === 'PATCH' && (request.body as { name?: string }).name === 'Renamed')).toBe(true))
    const patch = requests.find((request) => request.method === 'PATCH')
    expect(patch?.body).not.toHaveProperty('apiKey')

    fireEvent.click(await screen.findByRole('button', { name: 'Add gateway' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Other' } })
    fireEvent.change(screen.getByLabelText('API base URL'), { target: { value: 'https://other.example/v1/' } })
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-kept-out-of-the-page' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save gateway' }))
    await waitFor(() => expect(requests.some((request) => request.method === 'POST')).toBe(true))
    const post = requests.find((request) => request.method === 'POST')
    expect(post?.body).toMatchObject({ name: 'Other', baseUrl: 'https://other.example/v1', apiKey: 'sk-kept-out-of-the-page' })
    expect(screen.queryByDisplayValue('sk-kept-out-of-the-page')).toBeNull()
  })

  it('keeps a pending gateway unusable until the key is saved again', async () => {
    serve({
      gateways: [view({ id: '550e8400-e29b-41d4-a716-446655440001', name: 'Sandbox', pendingWrite: true, hasApiKey: false })],
      unavailable: [{ id: '550e8400-e29b-41d4-a716-446655440002' }],
      keyBackend: 'file',
      registryError: 'AI gateway settings could not be read.',
    })
    renderSection()
    expect(await screen.findByText('Update interrupted — save the API key again or remove this gateway.')).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Sandbox on' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('alert').textContent).toMatch(/could not be read/)
    fireEvent.click(screen.getByRole('button', { name: 'Edit Sandbox' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save gateway' }))
    expect(screen.getAllByText('Update interrupted — save the API key again or remove this gateway.').length).toBeGreaterThan(1)
    expect(requests.some((request) => request.method === 'PATCH')).toBe(false)
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByLabelText('Name')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Remove unreadable gateway' }))
    await waitFor(() => expect(requests.some((request) => request.method === 'DELETE')).toBe(true))
  })
})
