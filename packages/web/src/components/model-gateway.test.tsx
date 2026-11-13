import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProjectScopeContext } from '@/api/project-scope-context'
import { createQueryClient } from '@/api/query-client'
import { ModelGatewayPanel } from '@/components/model-gateway'

/** The model gateway form (spec 2026-11-10-model-gateway): what is sent, and that the key is never shown back. */

const fetchMock = vi.fn<typeof fetch>()
const presets = [
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/settings/keys' },
  { id: 'custom', name: 'Custom (OpenAI-compatible)' },
]
let gateway: Record<string, unknown> | null = null
let puts: unknown[] = []
let putError: string | null = null
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockImplementation(async (input, init) => {
    const url = new URL(String(input), 'http://localhost')
    const method = init?.method ?? 'GET'
    if (url.pathname === '/api/v1/workspace/model-gateway') {
      if (method === 'PUT') {
        if (putError) return json({ error: putError }, 400)
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        puts.push(body)
        gateway = body.preset === 'openrouter'
          ? { preset: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', models: [], updatedAt: 'now' }
          : { preset: 'custom', name: body.name, baseUrl: body.baseUrl, models: (body.models as string[] | undefined) ?? ['acme-coder', 'acme-large'], updatedAt: 'now' }
      }
      if (method === 'DELETE') gateway = null
      return json({ presets, gateway })
    }
    if (url.pathname === '/api/v1/providers/status') return json({ providers: [] })
    return json({ error: 'not stubbed' }, 404)
  })
})

afterEach(() => {
  gateway = null
  puts = []
  putError = null
  cleanup()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

const renderPanel = (onSaved = vi.fn()) => {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <ProjectScopeContext.Provider value={{ projectId: null, apiBase: '/api/v1' }}>
        <ModelGatewayPanel onSaved={onSaved} />
      </ProjectScopeContext.Provider>
    </QueryClientProvider>,
  )
  return onSaved
}

describe('ModelGatewayPanel', () => {
  it('saves an OpenRouter key alone, then shows the gateway but never the key', async () => {
    const onSaved = renderPanel()
    fireEvent.change(await screen.findByLabelText('API key'), { target: { value: 'sk-or-v1-secret' } })
    expect(screen.getByRole('link', { name: /Create a key on OpenRouter/ }).getAttribute('href')).toBe('https://openrouter.ai/settings/keys')
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }))
    await waitFor(() => expect(puts).toEqual([{ preset: 'openrouter', apiKey: 'sk-or-v1-secret' }]))
    expect(await screen.findByText(/Every OpenRouter model/)).toBeTruthy()
    expect(document.body.textContent).not.toContain('sk-or-v1-secret')
    expect(onSaved).toHaveBeenCalled()
  })

  it('sends a custom gateway with its address, and the model ids only when given', async () => {
    renderPanel()
    fireEvent.click(await screen.findByRole('radio', { name: 'Custom (OpenAI-compatible)' }))
    const save = screen.getByRole('button', { name: 'Save key' }) as HTMLButtonElement
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'acme-secret' } })
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Acme AI' } })
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://api.acme.example/v1' } })
    expect(screen.getByText('Leave empty to read them from https://api.acme.example/v1/models.')).toBeTruthy()
    fireEvent.click(save)
    await waitFor(() => expect(puts).toEqual([{ preset: 'custom', name: 'Acme AI', baseUrl: 'https://api.acme.example/v1', apiKey: 'acme-secret' }]))
    expect(await screen.findByText(/api\.acme\.example · 2 models/)).toBeTruthy()
  })

  it('says why a key was refused and keeps the form', async () => {
    putError = 'OpenRouter rejected this key.'
    renderPanel()
    fireEvent.change(await screen.findByLabelText('API key'), { target: { value: 'bad-key-123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }))
    expect((await screen.findByRole('alert')).textContent).toContain('rejected this key')
    expect(screen.getByLabelText('API key')).toBeTruthy()
  })

  it('removes a stored gateway', async () => {
    gateway = { preset: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', models: [], updatedAt: 'now' }
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    expect(await screen.findByRole('button', { name: 'Save key' })).toBeTruthy()
  })
})
