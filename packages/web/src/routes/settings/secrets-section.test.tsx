import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { secretHostIssue, setApiScope } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { parseBinding } from './secrets-binding'
import { ProjectSecretsSection, WorkspaceSecretsSection } from './secrets-section'

afterEach(() => { cleanup(); setApiScope(null); vi.unstubAllGlobals() })

type Stored = { name: string; audiences: ('checks' | 'cezar' | 'proxy')[]; updatedAt: string; binding?: { hosts: string[]; header: string; scheme: 'bearer' | 'basic' | 'raw'; sentinel?: string } }
const DEFAULT: Stored[] = [
  { name: 'OPENAI_API_KEY', audiences: ['checks'], updatedAt: '2026-10-10T00:00:00Z' },
  { name: 'STAGING_TOKEN', audiences: ['checks', 'cezar'], updatedAt: '2026-10-10T00:00:00Z' },
]

function setup(options: { secrets?: Stored[]; putStatus?: number; keyBackend?: 'keychain' | 'file'; scope?: 'project' | 'workspace'; skipped?: string } = {}) {
  const { secrets = DEFAULT, putStatus = 204, keyBackend = 'keychain', scope = 'project', skipped } = options
  const calls: { method: string; url: string; body?: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, url: String(input), body: typeof init?.body === 'string' ? init.body : undefined })
    if (method === 'GET') return new Response(JSON.stringify({ secrets, keyBackend, ...(skipped ? { skipped } : {}) }), { status: 200 })
    if (method === 'PUT' && putStatus !== 204) return new Response(JSON.stringify({ error: 'storage failed' }), { status: putStatus })
    return new Response(null, { status: 204 })
  }))
  const Section = scope === 'project' ? ProjectSecretsSection : WorkspaceSecretsSection
  render(<QueryClientProvider client={createQueryClient()}><Section /></QueryClientProvider>)
  return calls
}

describe('Secrets settings', () => {
  it('lists stored names with their audiences, the key backend, and renders no value', async () => {
    setup()
    await screen.findByText('OPENAI_API_KEY')
    expect(screen.getByText('STAGING_TOKEN')).toBeTruthy()
    expect(screen.getByText('Not proxied (legacy: check steps · cezar itself)')).toBeTruthy()
    expect(screen.getByText(/kept in your OS keychain/)).toBeTruthy()
    expect(screen.queryByText(/Visible to/)).toBeNull()
    expect(screen.queryByDisplayValue(/s3cret|sk-/)).toBeNull()
    expect((screen.getByLabelText('Value') as HTMLInputElement).value).toBe('')
    expect(screen.getByLabelText('Value').getAttribute('type')).toBe('password')
  })

  it('says why listed secrets cannot be read', async () => {
    setup({ skipped: 'the data key is gone' })
    await screen.findByText('OPENAI_API_KEY')
    expect(screen.getByRole('alert').textContent).toContain('the data key is gone')
  })

  it('says plainly when the data key is a file, not a keychain item', async () => {
    setup({ keyBackend: 'file' })
    await screen.findByText('OPENAI_API_KEY')
    expect(screen.getByText(/private file, not a vault/)).toBeTruthy()
  })

  it('adds a secret as a proxy secret and clears the inputs', async () => {
    const calls = setup()
    await screen.findByText('OPENAI_API_KEY')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'NEW_KEY' } })
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 's3cret' } })
    expect((screen.getByRole('button', { name: /save secret/i }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Hosts'), { target: { value: 'api.example.com' } })
    fireEvent.click(screen.getByRole('button', { name: /save secret/i }))
    await waitFor(() => expect((screen.getByLabelText('Value') as HTMLInputElement).value).toBe(''))
    const put = calls.find((c) => c.method === 'PUT')!
    expect(put.url).toMatch(/\/secrets\/NEW_KEY$/)
    expect(put.url).not.toContain('/workspace/')
    expect(JSON.parse(put.body!)).toEqual({
      value: 's3cret', audiences: ['proxy'],
      binding: { hosts: ['api.example.com'], header: 'Authorization', scheme: 'bearer' },
    })
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('')
    expect(screen.queryByText('s3cret')).toBeNull()
  })

  it('collects the destination binding for a proxy secret and sends it with the value', async () => {
    const calls = setup()
    await screen.findByText('OPENAI_API_KEY')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'GH_READONLY_TOKEN' } })
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'ghp_x' } })
    fireEvent.change(screen.getByLabelText('Hosts'), { target: { value: 'github.com, API.github.com' } })
    fireEvent.change(screen.getByLabelText('Placeholder env var'), { target: { value: 'gh_token' } })
    fireEvent.click(screen.getByRole('button', { name: /save secret/i }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
    expect(JSON.parse(calls.find((c) => c.method === 'PUT')!.body!)).toEqual({
      value: 'ghp_x',
      audiences: ['proxy'],
      binding: { hosts: ['api.github.com', 'github.com'], header: 'Authorization', scheme: 'bearer', sentinel: 'GH_TOKEN' },
    })
  })

  it('refuses a wildcard host before sending and shows a stored binding in the table', async () => {
    const calls = setup({ secrets: [{
      name: 'GH', audiences: ['proxy'], updatedAt: '2026-10-10T00:00:00Z',
      binding: { hosts: ['github.com'], header: 'Authorization', scheme: 'basic' },
    }] as never })
    await screen.findByText('GH')
    expect(screen.getByText('github.com · Authorization (basic)')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'X' } })
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'v' } })
    fireEvent.change(screen.getByLabelText('Hosts'), { target: { value: '*.github.com' } })
    fireEvent.click(screen.getByRole('button', { name: /save secret/i }))
    expect((await screen.findByRole('alert')).textContent).toContain('exact lowercase hostname')
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('addresses the workspace routes from the global section', async () => {
    const calls = setup({ scope: 'workspace' })
    await screen.findByText('OPENAI_API_KEY')
    expect(calls[0]!.url).toMatch(/\/api\/v1\/workspace\/secrets$/)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'LLM_KEY' } })
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'sk-x' } })
    fireEvent.change(screen.getByLabelText('Hosts'), { target: { value: 'api.example.com' } })
    fireEvent.click(screen.getByRole('button', { name: /save secret/i }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
    expect(calls.find((c) => c.method === 'PUT')!.url).toMatch(/\/api\/v1\/workspace\/secrets\/LLM_KEY$/)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete STAGING_TOKEN' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/workspace/secrets/STAGING_TOKEN'))).toBe(true))
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

  it('keeps Save disabled until a destination host is given', async () => {
    const calls = setup()
    await screen.findByText('OPENAI_API_KEY')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'OK_NAME' } })
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'x' } })
    expect((screen.getByRole('button', { name: /save secret/i }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.submit(screen.getByLabelText('Name').closest('form')!)
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('shows the server error when saving fails, and keeps what was typed', async () => {
    setup({ secrets: [{ name: 'A', audiences: ['checks'], updatedAt: '' }], putStatus: 409 })
    await screen.findByText('A')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'OK_NAME' } })
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'a-long-pasted-key' } })
    fireEvent.change(screen.getByLabelText('Hosts'), { target: { value: 'api.example.com' } })
    fireEvent.click(screen.getByRole('button', { name: /save secret/i }))
    expect(await screen.findByText('storage failed')).toBeTruthy()
    // Retrying a transient failure must not cost a re-paste of the key.
    expect((screen.getByLabelText('Value') as HTMLInputElement).value).toBe('a-long-pasted-key')
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('OK_NAME')
  })

  it('deletes a secret with DELETE', async () => {
    const calls = setup()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete STAGING_TOKEN' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/secrets/STAGING_TOKEN'))).toBe(true))
  })

  it('renders the form with the shared Input inside a FormRow and a danger-ghost Delete per row', async () => {
    setup()
    await screen.findByText('OPENAI_API_KEY')
    expect(screen.getByLabelText('Name').getAttribute('data-slot')).toBe('input')
    expect(screen.getByLabelText('Value').getAttribute('data-slot')).toBe('input')
    expect(screen.getByLabelText('Name').closest('[data-slot="form-row"]')).not.toBeNull()
    expect(document.querySelector('select:not([aria-hidden])')).toBeNull()
    expect(screen.getByRole('button', { name: 'Delete OPENAI_API_KEY' }).getAttribute('data-variant')).toBe('danger-ghost')
  })
  it('edits a proxy secret in place: the form is prefilled, the value is empty and required, the whole binding is re-sent', async () => {
    const calls = setup({ secrets: [{
      name: 'GH', audiences: ['proxy'], updatedAt: '2026-10-10T00:00:00Z',
      binding: { hosts: ['api.github.com', 'github.com'], header: 'Authorization', scheme: 'basic', sentinel: 'GH_TOKEN' },
    }] })
    fireEvent.click(await screen.findByRole('button', { name: 'Edit GH' }))
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('GH')
    expect((screen.getByLabelText('Name') as HTMLInputElement).readOnly).toBe(true)
    expect((screen.getByLabelText('Hosts') as HTMLInputElement).value).toBe('api.github.com, github.com')
    expect((screen.getByLabelText('Header') as HTMLInputElement).value).toBe('Authorization')
    expect((screen.getByLabelText('Placeholder env var') as HTMLInputElement).value).toBe('GH_TOKEN')
    const value = screen.getByLabelText('Value') as HTMLInputElement
    expect(value.value).toBe('')
    expect(value.required).toBe(true)
    expect(screen.getByText(/re-enter it/)).toBeTruthy()
    expect((screen.getByRole('button', { name: /save secret/i }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.submit(value.closest('form')!)
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
    fireEvent.change(screen.getByLabelText('Hosts'), { target: { value: 'github.com' } })
    fireEvent.change(value, { target: { value: 'tok-new' } })
    fireEvent.click(screen.getByRole('button', { name: /save secret/i }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
    expect(JSON.parse(calls.find((c) => c.method === 'PUT')!.body!)).toEqual({
      value: 'tok-new', audiences: ['proxy'],
      binding: { hosts: ['github.com'], header: 'Authorization', scheme: 'basic', sentinel: 'GH_TOKEN' },
    })
    await waitFor(() => expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(''))
    expect((screen.getByLabelText('Name') as HTMLInputElement).readOnly).toBe(false)
  })

  it('cancelling an edit empties the form', async () => {
    setup({ secrets: [{ name: 'GH', audiences: ['proxy'], updatedAt: '', binding: { hosts: ['github.com'], header: 'Authorization', scheme: 'basic' } }] })
    fireEvent.click(await screen.findByRole('button', { name: 'Edit GH' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('Hosts') as HTMLInputElement).value).toBe('')
  })

  it('converts a legacy secret: no hosts yet, the value re-entered, saved as a proxy secret', async () => {
    const calls = setup()
    fireEvent.click(await screen.findByRole('button', { name: 'Convert OPENAI_API_KEY to a proxy secret' }))
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('OPENAI_API_KEY')
    expect((screen.getByLabelText('Hosts') as HTMLInputElement).value).toBe('')
    expect(screen.getByText(/Converting OPENAI_API_KEY to a proxy secret/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'x-api-key header' }))
    fireEvent.change(screen.getByLabelText('Hosts'), { target: { value: 'api.openai.com' } })
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'sk-new' } })
    fireEvent.click(screen.getByRole('button', { name: /save secret/i }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
    expect(JSON.parse(calls.find((c) => c.method === 'PUT')!.body!)).toEqual({
      value: 'sk-new', audiences: ['proxy'],
      binding: { hosts: ['api.openai.com'], header: 'x-api-key', scheme: 'raw' },
    })
  })

  it('offers the real cases as presets that fill header, scheme and hosts', async () => {
    const calls = setup()
    await screen.findByText('OPENAI_API_KEY')
    expect(screen.getByText(/github\.com and api\.github\.com/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'GitHub over HTTPS' }))
    expect((screen.getByLabelText('Hosts') as HTMLInputElement).value).toBe('github.com, api.github.com')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'GH' } })
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'tok' } })
    fireEvent.click(screen.getByRole('button', { name: /save secret/i }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
    expect(JSON.parse(calls.find((c) => c.method === 'PUT')!.body!).binding).toEqual({ hosts: ['api.github.com', 'github.com'], header: 'Authorization', scheme: 'basic' })
    fireEvent.click(screen.getByRole('button', { name: 'Bearer token' }))
    expect((screen.getByLabelText('Header') as HTMLInputElement).value).toBe('Authorization')
  })

  it('warns that proxy secrets are unusable with a file data key, and only then', async () => {
    cleanup()
    setup({ keyBackend: 'file' })
    expect((await screen.findByText(/launcher refuses a file key/))).toBeTruthy()
    cleanup()
    setup({ keyBackend: 'keychain' })
    await screen.findByText('OPENAI_API_KEY')
    expect(screen.queryByText(/launcher refuses a file key/)).toBeNull()
  })

  it.each(['*.example.com', 'API.example.com', 'api.example.com:443', '10.0.0.1', '[::1]', 'a b.com', 'a..com', '-a.com', 'https://a.com', 'a.com/x', 'api.example.com', 'localhost'])(
    'the form takes host %s exactly as the contract does', (host) => {
      const fields = { hosts: host, header: 'Authorization', scheme: 'bearer' as const, sentinel: '' }
      const lowered = host.toLowerCase()
      const parts = lowered.split(/[\s,]+/).filter(Boolean)
      const expected = parts.length > 0 && parts.every((part) => secretHostIssue(part) === null)
      expect(parseBinding(fields).binding !== undefined).toBe(expected)
    })
  it('points an empty store at the import command, and a stocked one does not', async () => {
    setup({ secrets: [], scope: 'workspace' })
    expect((await screen.findByText(/No secrets stored/)).textContent).toContain('cezar secrets import-sandcastle --workspace')
    cleanup()
    setup()
    await screen.findByText('OPENAI_API_KEY')
    expect(screen.queryByText(/import-sandcastle/)).toBeNull()
  })

})
