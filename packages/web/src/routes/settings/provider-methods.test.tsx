import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AgentProviderEntry } from '@open-mercato/cezar-api-client'
import { afterEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { ProviderMethods } from './provider-methods'

const claude: AgentProviderEntry = { runner: 'claude', mode: 'one', active: 'subscription', methods: [
  { id: 'subscription', kind: 'subscription', label: 'Claude subscription', state: 'connected' },
  { id: 'openrouter', kind: 'openrouter', label: 'OpenRouter', state: 'connected', origin: 'host' },
  { id: 'custom', kind: 'custom', label: 'Company gateway', state: 'connected', origin: 'file',
    baseUrl: 'https://example.test', keyHint: '…fake', modelCount: 2 },
] }
function mount(agent: AgentProviderEntry, editable = true) {
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/active')) return Response.json(agent)
    if (url.endsWith('/models')) return Response.json({ models: ['example'] })
    return init.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json(agent.methods[2])
  })
  vi.stubGlobal('fetch', fetch)
  render(<QueryClientProvider client={createQueryClient()}><ProviderMethods agent={agent} editable={editable} /></QueryClientProvider>)
  return fetch
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('switches one-mode methods while leaving a host key read-only', async () => {
  const fetch = mount(claude)
  expect(screen.getByRole('radiogroup', { name: 'claude auth methods' })).toBeTruthy()
  expect(screen.getByText(/from host environment/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Edit OpenRouter/ })).toBeNull()
  fireEvent.click(screen.getByRole('radio', { name: 'Run claude on OpenRouter' }))
  await waitFor(() => expect(fetch.mock.calls[0]).toEqual(['/api/v1/agent-providers/claude/active', expect.objectContaining({
    method: 'PUT', body: JSON.stringify({ methodId: 'openrouter' }),
  })]))
})

it('edits a file-managed endpoint without pre-filling its saved key', async () => {
  const fetch = mount(claude)
  expect(screen.getByText(/from providers file/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Edit Company gateway for claude' }))
  const key = screen.getByLabelText<HTMLInputElement>('API key')
  expect(key.type).toBe('password')
  expect(key.value).toBe('')
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Fake gateway' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save provider' }))
  await waitFor(() => expect(screen.queryByLabelText('API key')).toBeNull())
  expect(JSON.parse(String(fetch.mock.calls[0]![1].body))).toEqual({ kind: 'custom', label: 'Fake gateway', baseUrl: 'https://example.test' })
  expect(screen.getByText(/overwrites this edit/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Remove Company gateway for claude' }))
  await waitFor(() => expect(fetch.mock.calls[1]?.[1].method).toBe('DELETE'))
})

it('adds a key and retries a failed any-mode method without selecting a radio', async () => {
  const fetch = mount({ ...claude, runner: 'pi', mode: 'any', methods: [
    { id: 'openrouter', kind: 'openrouter', label: 'OpenRouter', state: 'disconnected' },
    { id: 'custom', kind: 'custom', label: 'Gateway', state: 'error', error: 'Timed out', modelCount: 2 }, claude.methods[0]!,
  ] })
  expect(screen.queryByRole('radio')).toBeNull()
  expect(screen.getByText(/2 models \(stale\)/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(fetch.mock.calls[0]?.[0]).toBe('/api/v1/agent-providers/pi/methods/custom/models'))
  fireEvent.click(screen.getByRole('button', { name: 'Add OpenRouter for pi' }))
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'fake-key' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save provider' }))
  await waitFor(() => expect(fetch.mock.calls[1]?.[0]).toBe('/api/v1/agent-providers/pi/methods/openrouter'))
  expect(JSON.parse(String(fetch.mock.calls[1]![1].body))).toEqual({ kind: 'openrouter', apiKey: 'fake-key' })
})

it('shows status and hints on a hosted cockpit with all provider writes disabled', () => {
  const fetch = mount(claude, false)
  expect(screen.getByText(/…fake/)).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.getAllByRole('radio').every(el => el.hasAttribute('disabled'))).toBe(true)
  expect(fetch).not.toHaveBeenCalled()
})
