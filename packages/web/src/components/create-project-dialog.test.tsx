import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { GithubOwnersResponse, ProjectListEntry } from '@open-mercato/cezar-api-client'
import { CreateProjectDialog } from '@/components/create-project-dialog'

/**
 * The new-project dialog (spec 2026-09-29-create-new-project), driven through a stubbed `fetch`
 * so the request body on the wire — especially the absence of any visibility field — is what
 * the assertions read.
 */

const fetchMock = vi.fn<typeof fetch>()

let emitWorkspaceEvent: ((name: string, payload: unknown) => void) | null = null

vi.mock('@/api/global-events', () => ({
  onWorkspaceEvent: (listener: (name: string, payload: unknown) => void) => {
    emitWorkspaceEvent = listener
    return () => {
      emitWorkspaceEvent = null
    }
  },
}))

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  emitWorkspaceEvent = null
  vi.unstubAllGlobals()
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const PROJECT: ProjectListEntry = {
  id: 'fresh',
  name: 'fresh',
  root: '/home/me/cezar/projects/fresh',
  addedAt: '2026-09-29T00:00:00.000Z',
  lastOpenedAt: '2026-09-29T00:00:00.000Z',
  source: 'checkout',
  status: 'ok',
}

const posted: Record<string, unknown>[] = []

function serve(
  owners: GithubOwnersResponse = { available: true, login: 'octo', orgs: ['acme'] },
  create: () => Promise<Response> = async () => json({ project: PROJECT }),
): void {
  posted.length = 0
  fetchMock.mockImplementation(async (input, init) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/v1/projects/create') {
      posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return create()
    }
    if (url.pathname === '/api/v1/projects/github-owners') return json(owners)
    if (url.pathname === '/api/v1/projects') {
      return json({ projects: [], bootProject: 'cezar', projectsDir: '~/cezar/projects' })
    }
    return json({ error: `unexpected ${String(init?.method ?? 'GET')} ${url.pathname}` }, 404)
  })
}

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>
}

function renderDialog() {
  const onOpenChange = vi.fn()
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/p/cezar/']}>
        <CreateProjectDialog open onOpenChange={onOpenChange} />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { onOpenChange }
}

const slot = (name: string) => document.querySelector(`[data-slot="${name}"]`) as HTMLElement | null
const nameInput = () => slot('create-name') as HTMLInputElement
const createButton = () => slot('create-confirm') as HTMLButtonElement

describe('CreateProjectDialog', () => {
  it('creates a private GitHub repo under the chosen org, with no visibility field', async () => {
    serve()
    const { onOpenChange } = renderDialog()
    await waitFor(() => expect(slot('create-owner')).toBeTruthy())
    const owner = slot('create-owner') as HTMLSelectElement
    expect([...owner.options].map((o) => o.value)).toEqual(['octo', 'acme'])
    expect(owner.value).toBe('octo')

    fireEvent.change(nameInput(), { target: { value: ' fresh ' } })
    expect(slot('create-target')?.textContent).toBe('~/cezar/projects/fresh')
    fireEvent.change(owner, { target: { value: 'acme' } })
    fireEvent.click(createButton())

    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({ name: 'fresh', github: { owner: 'acme' } })
    expect(JSON.stringify(posted[0])).not.toMatch(/visib|public/i)
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(document.querySelector('[data-testid="location"]')?.textContent).toBe('/p/fresh/')
  })

  it('passes a template when one is given', async () => {
    serve()
    renderDialog()
    await waitFor(() => expect(slot('create-template')).toBeTruthy())
    fireEvent.change(nameInput(), { target: { value: 'fresh' } })
    fireEvent.change(slot('create-template') as HTMLInputElement, { target: { value: 'acme/starter' } })
    fireEvent.click(createButton())
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({ github: { owner: 'octo', template: 'acme/starter' } })
  })

  it('turning GitHub off creates a local-only repo', async () => {
    serve()
    renderDialog()
    await waitFor(() => expect(slot('create-owner')).toBeTruthy())
    fireEvent.click(slot('create-github') as HTMLButtonElement)
    expect(slot('create-owner')).toBeNull()
    fireEvent.change(nameInput(), { target: { value: 'fresh' } })
    fireEvent.click(createButton())
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).not.toHaveProperty('github')
  })

  it('without gh, shows the reason and still offers a local repo', async () => {
    serve({ available: false, reason: 'gh CLI not found — install it and run `gh auth login`' })
    renderDialog()
    await waitFor(() => expect(slot('create-github-unavailable')?.textContent).toContain('gh CLI not found'))
    expect((slot('create-github') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(nameInput(), { target: { value: 'fresh' } })
    fireEvent.click(createButton())
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).not.toHaveProperty('github')
  })

  it('shows progress while pending and the server error verbatim on failure', async () => {
    let finish: (res: Response) => void = () => {}
    serve(undefined, () => new Promise<Response>((r) => (finish = r)))
    renderDialog()
    await waitFor(() => expect(slot('create-owner')).toBeTruthy())
    fireEvent.change(nameInput(), { target: { value: 'fresh' } })
    fireEvent.click(createButton())
    await waitFor(() => expect(slot('create-progress')).toBeTruthy())
    const checkoutId = posted[0]?.checkoutId
    emitWorkspaceEvent?.('checkout-progress', { checkoutId, name: 'fresh', phase: 'cloning', line: 'Creating private repository octo/fresh…' })
    await waitFor(() => expect(slot('create-progress')?.textContent).toBe('Creating private repository octo/fresh…'))
    finish(json({ error: 'GraphQL: Name already exists on this account' }, 500))
    await waitFor(() => expect(slot('create-error')?.textContent).toBe('GraphQL: Name already exists on this account'))
  })
})
