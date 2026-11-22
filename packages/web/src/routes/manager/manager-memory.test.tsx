import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { ManagerMemoryEntry, ManagerMemoryResponse } from '@open-mercato/cezar-api-client'

import { MemoryDialog } from './manager-memory'
import { managerFixture } from './manager-fixtures'

const entry: ManagerMemoryEntry = { key: 'full-prs', kind: 'feedback', text: 'Open full PRs, not drafts', why: 'reviews start sooner', updatedAt: 't', source: 'import' }
const memory = (entries = [entry]): ManagerMemoryResponse => ({ entries, limits: { entries: 40, bytes: 6144 }, usedBytes: 180 })

function stub(responses: { get: ManagerMemoryResponse; write?: ManagerMemoryResponse }) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ url, method, ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}) })
    return new Response(JSON.stringify(method === 'GET' ? responses.get : responses.write ?? responses.get), { status: 200 })
  }))
  return calls
}

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryDialog manager={managerFixture({})} open onOpenChange={vi.fn()} />
    </QueryClientProvider>,
  )
}

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('MemoryDialog (spec 2026-11-21-manager-short-sessions-and-memory § 2.1)', () => {
  it('lists entries with their kind, why, source and the budget', async () => {
    stub({ get: memory() })
    renderDialog()
    expect(await screen.findByText('Open full PRs, not drafts')).toBeTruthy()
    expect(screen.getByText('Why: reviews start sooner')).toBeTruthy()
    expect(screen.getByText('Saved by imported')).toBeTruthy()
    expect(screen.getByText('1 of 40 entries · 180 of 6144 bytes')).toBeTruthy()
  })

  it('adds an entry under a key made from its text, as the user', async () => {
    const calls = stub({ get: memory([]), write: memory([{ ...entry, key: 'html-design-before-ui', text: 'HTML design before UI', source: 'user' }]) })
    renderDialog()
    fireEvent.click(await screen.findByRole('button', { name: 'Add' }))
    fireEvent.change(screen.getByLabelText('What to remember'), { target: { value: 'HTML design before UI' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls.at(-1)?.method).toBe('PUT'))
    expect(calls.at(-1)).toMatchObject({ url: expect.stringContaining('/memory/html-design-before-ui'), body: { kind: 'preference', text: 'HTML design before UI', source: 'user' } })
    expect(await screen.findByText('HTML design before UI')).toBeTruthy()
  })

  it('refuses to add a new entry under a key that is already saved', async () => {
    const calls = stub({ get: memory() })
    renderDialog()
    fireEvent.click(await screen.findByRole('button', { name: 'Add' }))
    fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'full-prs' } })
    fireEvent.change(screen.getByLabelText('What to remember'), { target: { value: 'Something else' } })
    expect(screen.getByText(/already saved/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    expect(calls.every((call) => call.method === 'GET')).toBe(true)
  })

  it('deletes an entry', async () => {
    const calls = stub({ get: memory(), write: memory([]) })
    renderDialog()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete full-prs' }))
    await waitFor(() => expect(calls.at(-1)?.method).toBe('DELETE'))
    expect(await screen.findByText(/Nothing yet/)).toBeTruthy()
  })
})
