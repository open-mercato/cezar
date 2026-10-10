import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setApiScope } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { CheckEnvSection } from './check-env-section'

afterEach(() => { cleanup(); setApiScope(null); vi.unstubAllGlobals() })

function setup(names: string[] = ['OPENAI_API_KEY', 'STAGING_TOKEN'], putStatus = 204) {
  const calls: { method: string; url: string; body?: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, url: String(input), body: typeof init?.body === 'string' ? init.body : undefined })
    if (method === 'GET') return new Response(JSON.stringify({ names }), { status: 200 })
    if (method === 'PUT' && putStatus !== 204) return new Response(JSON.stringify({ error: 'storage failed' }), { status: putStatus })
    return new Response(null, { status: 204 })
  }))
  render(<QueryClientProvider client={createQueryClient()}><CheckEnvSection /></QueryClientProvider>)
  return calls
}

describe('Check credentials settings', () => {
  it('lists stored names and renders no value', async () => {
    setup()
    await screen.findByText('OPENAI_API_KEY')
    expect(screen.getByText('STAGING_TOKEN')).toBeTruthy()
    expect(screen.queryByDisplayValue(/.+/)).toBeNull()
    expect(screen.getByLabelText('Value').getAttribute('type')).toBe('password')
  })

  it('adds a credential with PUT and clears the inputs', async () => {
    const calls = setup()
    await screen.findByText('OPENAI_API_KEY')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'NEW_KEY' } })
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 's3cret' } })
    fireEvent.click(screen.getByRole('button', { name: /save credential/i }))
    await waitFor(() => expect((screen.getByLabelText('Value') as HTMLInputElement).value).toBe(''))
    const put = calls.find((c) => c.method === 'PUT')!
    expect(put.url).toMatch(/\/check-env\/NEW_KEY$/)
    expect(JSON.parse(put.body!)).toEqual({ value: 's3cret' })
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('')
    expect(screen.queryByText('s3cret')).toBeNull()
  })

  it('shows the reason for a refused name without calling PUT', async () => {
    const calls = setup()
    await screen.findByText('OPENAI_API_KEY')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'PATH' } })
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'x' } })
    expect(await screen.findByText(/PATH changes how the check's shell runs/)).toBeTruthy()
    fireEvent.submit(screen.getByLabelText('Name').closest('form')!)
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('shows the server error when saving fails, and keeps what was typed', async () => {
    setup(['A'], 409)
    await screen.findByText('A')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'OK_NAME' } })
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'a-long-pasted-key' } })
    fireEvent.click(screen.getByRole('button', { name: /save credential/i }))
    expect(await screen.findByText('storage failed')).toBeTruthy()
    // Retrying a transient failure must not cost a re-paste of the key.
    expect((screen.getByLabelText('Value') as HTMLInputElement).value).toBe('a-long-pasted-key')
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('OK_NAME')
  })

  it('deletes a credential with DELETE', async () => {
    const calls = setup()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete STAGING_TOKEN' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/check-env/STAGING_TOKEN'))).toBe(true))
  })
})
