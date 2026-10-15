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
  owners: GithubOwnersResponse | Record<string, unknown> = {
    available: true,
    owners: [
      { login: 'octo', personal: true, avatarUrl: 'https://avatars.githubusercontent.com/u/1' },
      { login: 'acme', personal: false, description: 'Builds rockets' },
    ],
  },
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
const ownerCards = () => [...document.querySelectorAll<HTMLButtonElement>('[data-slot="create-owner-option"]')]
const selectedOwner = () => ownerCards().find((card) => card.getAttribute('aria-checked') === 'true')?.dataset.owner

describe('CreateProjectDialog', () => {
  it('creates a private GitHub repo under the chosen org, with no visibility field', async () => {
    serve()
    const { onOpenChange } = renderDialog()
    await waitFor(() => expect(slot('create-owner')).toBeTruthy())
    // The personal account comes first and is the default; each card shows avatar and subtitle.
    expect(ownerCards().map((card) => card.dataset.owner)).toEqual(['octo', 'acme'])
    expect(selectedOwner()).toBe('octo')
    expect(ownerCards()[0]?.textContent).toContain('Personal account')
    expect(ownerCards()[0]?.querySelector('img')?.getAttribute('src')).toBe('https://avatars.githubusercontent.com/u/1')
    expect(ownerCards()[1]?.textContent).toContain('Builds rockets')

    fireEvent.change(nameInput(), { target: { value: ' fresh' } })
    expect(slot('create-target')?.textContent).toBe('~/cezar/projects/fresh')
    fireEvent.click(ownerCards()[1] as HTMLButtonElement)
    expect(selectedOwner()).toBe('acme')
    fireEvent.click(createButton())

    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({ name: 'fresh', github: { owner: 'acme' } })
    expect(JSON.stringify(posted[0])).not.toMatch(/visib|public/i)
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    // The router re-renders after `navigate()` returns, so the new path can land a tick later.
    await waitFor(() => expect(document.querySelector('[data-testid="location"]')?.textContent).toBe('/p/fresh/'))
  })

  it('puts the owner cards in their own column beside the form, and drops it without GitHub', async () => {
    serve()
    renderDialog()
    await waitFor(() => expect(ownerCards()).toHaveLength(2))
    const column = slot('create-owners-column')
    expect(column?.contains(slot('create-owner'))).toBe(true)
    expect(column?.contains(nameInput())).toBe(false)
    expect(column?.textContent).toContain('Select organization')
    expect(slot('create-layout')?.className).toContain('md:grid-cols-')
    // Switching GitHub off keeps the column (no layout jump) but disables the cards.
    fireEvent.click(slot('create-github') as HTMLButtonElement)
    expect(ownerCards().every((card) => card.disabled)).toBe(true)
  })

  it('without gh there is no owner column — a single-column form', async () => {
    serve({ available: false, reason: 'gh CLI not found' })
    renderDialog()
    await waitFor(() => expect(slot('create-github-unavailable')).toBeTruthy())
    expect(slot('create-owners-column')).toBeNull()
    expect(slot('create-layout')?.className).not.toContain('md:grid-cols-')
  })

  it('keeps the name a valid GitHub repository name', async () => {
    serve()
    renderDialog()
    await waitFor(() => expect(slot('create-owner')).toBeTruthy())
    fireEvent.change(nameInput(), { target: { value: 'my new project' } })
    expect(nameInput().value).toBe('my-new-project')
    expect(slot('create-target')?.textContent).toBe('~/cezar/projects/my-new-project')
    fireEvent.change(nameInput(), { target: { value: 'zażółć' } })
    expect(slot('create-name-error')?.textContent).toContain('letters, digits')
    expect(createButton().disabled).toBe(true)
    fireEvent.keyDown(nameInput(), { key: 'Enter' })
    expect(posted).toHaveLength(0)
  })

  it('arrow keys move the owner selection', async () => {
    serve()
    renderDialog()
    await waitFor(() => expect(ownerCards()).toHaveLength(2))
    fireEvent.keyDown(ownerCards()[0] as HTMLButtonElement, { key: 'ArrowDown' })
    expect(selectedOwner()).toBe('acme')
    fireEvent.keyDown(ownerCards()[1] as HTMLButtonElement, { key: 'ArrowDown' })
    expect(selectedOwner()).toBe('octo')
  })

  it('has no link away to settings', async () => {
    serve()
    renderDialog()
    await waitFor(() => expect(slot('create-owner')).toBeTruthy())
    expect(document.querySelector('[data-slot="create-project-dialog"] a')).toBeNull()
  })

  it('starts empty by default and says so', async () => {
    serve()
    renderDialog()
    await waitFor(() => expect(ownerCards()).toHaveLength(2))
    expect(slot('create-start-empty')?.getAttribute('aria-checked')).toBe('true')
    expect(slot('create-start-empty')?.textContent).toContain('One empty commit')
    expect(slot('create-template')).toBeNull()
    fireEvent.change(nameInput(), { target: { value: 'fresh' } })
    fireEvent.click(createButton())
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({ github: { owner: 'octo' } })
    expect((posted[0]?.github as Record<string, unknown>).template).toBeUndefined()
  })

  it('from a template: suggestions fill the field, and the template is sent', async () => {
    serve()
    renderDialog()
    await waitFor(() => expect(ownerCards()).toHaveLength(2))
    fireEvent.change(nameInput(), { target: { value: 'fresh' } })
    fireEvent.click(slot('create-start-template') as HTMLButtonElement)
    // Nothing picked yet: Create waits for a template.
    expect(createButton().disabled).toBe(true)

    const input = slot('create-template') as HTMLInputElement
    // Visible straight away — not only on focus — so nothing appears under the cursor later.
    expect(document.querySelectorAll('[data-slot="create-template-suggestion"]').length).toBeGreaterThan(5)
    // Rendered inside the dialog, never portalled out of it: the dialog's scroll lock would
    // swallow wheel/touch scrolling on a list outside its DOM.
    expect(slot('create-project-dialog')?.contains(slot('create-template-suggestions'))).toBe(true)
    fireEvent.change(input, { target: { value: 'obsidian' } })
    const options = [...document.querySelectorAll<HTMLElement>('[data-slot="create-template-suggestion"]')]
    expect(options.map((o) => o.dataset.template)).toEqual(['andrewmcodes/obsidian-beginner-vault-template'])
    fireEvent.click(options[0] as HTMLElement)
    expect(input.value).toBe('andrewmcodes/obsidian-beginner-vault-template')
    // After a pick the whole list stays (no dropdown to close), with the chosen template marked.
    const marked = [...document.querySelectorAll<HTMLElement>('[data-slot="create-template-suggestion"]')].filter(
      (o) => o.getAttribute('aria-selected') === 'true',
    )
    expect(marked.map((o) => o.dataset.template)).toEqual(['andrewmcodes/obsidian-beginner-vault-template'])
    expect(document.querySelectorAll('[data-slot="create-template-suggestion"]').length).toBeGreaterThan(5)

    fireEvent.click(createButton())
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({ github: { owner: 'octo', template: 'andrewmcodes/obsidian-beginner-vault-template' } })
  })

  it('a query with no suggestion says any owner/repo works', async () => {
    serve()
    renderDialog()
    await waitFor(() => expect(ownerCards()).toHaveLength(2))
    fireEvent.click(slot('create-start-template') as HTMLButtonElement)
    fireEvent.change(slot('create-template') as HTMLInputElement, { target: { value: 'acme/internal-starter' } })
    expect(slot('create-template-no-match')?.textContent).toContain('owner/repo')
  })

  it('arrow keys and Enter pick a suggestion; a pasted owner/repo works too', async () => {
    serve()
    renderDialog()
    await waitFor(() => expect(ownerCards()).toHaveLength(2))
    fireEvent.click(slot('create-start-template') as HTMLButtonElement)
    const input = slot('create-template') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'next' } })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input.value).toBe('github/codespaces-nextjs')
    fireEvent.change(input, { target: { value: 'acme/starter' } })
    fireEvent.change(nameInput(), { target: { value: 'fresh' } })
    fireEvent.click(createButton())
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({ github: { template: 'acme/starter' } })
  })

  it('turning GitHub off creates a local-only repo', async () => {
    serve()
    renderDialog()
    await waitFor(() => expect(slot('create-owner')).toBeTruthy())
    fireEvent.click(slot('create-github') as HTMLButtonElement)
    expect(ownerCards().every((card) => card.disabled)).toBe(true)
    // A template needs GitHub.
    expect((slot('create-start-template') as HTMLButtonElement).disabled).toBe(true)
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

  it('an owners body of another shape (a server from before the owner cards) degrades to local-only, never a crash', async () => {
    serve({ available: true, login: 'octo', orgs: ['acme'] })
    renderDialog()
    await waitFor(() => expect(slot('create-github-unavailable')?.textContent).toContain('locally only'))
    expect(ownerCards()).toHaveLength(0)
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
