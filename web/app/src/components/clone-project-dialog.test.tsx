import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ProjectListEntry } from '@/api/types'
import { CloneProjectDialog } from '@/components/clone-project-dialog'

/**
 * The clone-from-GitHub dialog (multi-project spec, "Add project" option B / step 4.3).
 *
 * Driven through a stubbed `fetch`, like the folder-browser dialog's suite: the request the
 * dialog puts on the wire (the `{url, name, checkoutId}` body) is half of what this step is.
 * Progress is driven by dispatching real `checkout-progress` events at the module-level
 * workspace-event registry, which is the same path the live EventSource takes.
 */

const fetchMock = vi.fn<typeof fetch>()

/** The workspace-event fan-out, captured so a test can play the server's side of the stream. */
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
  id: 'cezar-2',
  name: 'cezar',
  root: '/home/me/cezar/projects/cezar',
  addedAt: '2026-07-20T00:00:00.000Z',
  lastOpenedAt: '2026-07-20T00:00:00.000Z',
  source: 'checkout',
  status: 'ok',
}

const posted: Record<string, unknown>[] = []

/** `checkout` answers the POST; it may be a deferred promise so a test can inspect the pending
 *  state (the progress line) before the clone "finishes". */
function serve(checkout: () => Promise<Response> = async () => json({ project: PROJECT })): void {
  posted.length = 0
  fetchMock.mockImplementation(async (input, init) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/projects/checkout') {
      posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return checkout()
    }
    if (url.pathname === '/api/projects') {
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
        <CloneProjectDialog open onOpenChange={onOpenChange} />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { onOpenChange }
}

const slot = (name: string) => document.querySelector(`[data-slot="${name}"]`) as HTMLElement | null
const urlInput = () => slot('clone-url') as HTMLInputElement
const nameInput = () => slot('clone-name') as HTMLInputElement
const cloneButton = () => slot('clone-confirm') as HTMLButtonElement
const rootSettingsControl = () => slot('clone-root-settings') as HTMLAnchorElement | HTMLButtonElement

describe('CloneProjectDialog', () => {
  it('previews <projectsDir>/<repo> from the typed url and posts the trimmed reference', async () => {
    serve()
    const { onOpenChange } = renderDialog()
    await waitFor(() => expect(slot('clone-target')).toBeTruthy())

    fireEvent.change(urlInput(), { target: { value: 'https://github.com/open-mercato/cezar.git' } })
    // The name defaults to the repo half — the same rule the server applies.
    await waitFor(() => expect(slot('clone-target')?.textContent).toBe('~/cezar/projects/cezar'))
    expect(rootSettingsControl().tagName).toBe('A')
    expect(rootSettingsControl().getAttribute('href')).toBe('/settings/global/projects')
    expect(rootSettingsControl().getAttribute('aria-label')).toBe('Edit checkout root')
    expect(rootSettingsControl().getAttribute('title')).toBe('Edit checkout root')

    fireEvent.click(cloneButton())
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({ url: 'https://github.com/open-mercato/cezar.git' })
    // No `name` when it was never edited: the server owns the default.
    expect(posted[0]).not.toHaveProperty('name')
    expect(typeof posted[0]?.checkoutId).toBe('string')

    // Success closes the dialog and jumps to the new project's scope.
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    await waitFor(() => expect(document.querySelector('[data-testid="location"]')?.textContent).toBe('/p/cezar-2/'))
  })

  it('an edited folder name is previewed and posted', async () => {
    serve()
    renderDialog()
    fireEvent.change(urlInput(), { target: { value: 'open-mercato/cezar' } })
    fireEvent.change(nameInput(), { target: { value: 'cezar-fork' } })
    await waitFor(() => expect(slot('clone-target')?.textContent).toBe('~/cezar/projects/cezar-fork'))
    fireEvent.click(cloneButton())
    await waitFor(() => expect(posted[0]).toMatchObject({ name: 'cezar-fork' }))
  })

  it('renders checkout-progress lines for ITS OWN checkoutId and ignores another dialog\'s', async () => {
    let release: (res: Response) => void = () => {}
    serve(() => new Promise<Response>((resolve) => (release = resolve)))
    renderDialog()
    fireEvent.change(urlInput(), { target: { value: 'open-mercato/cezar' } })
    fireEvent.click(cloneButton())

    await waitFor(() => expect(slot('clone-progress')).toBeTruthy())
    // Pending, before any event: an honest placeholder rather than a blank line.
    expect(slot('clone-progress')?.textContent).toBe('Starting the clone…')
    // A clone cannot be dismissed while pending; the settings affordance follows the same rule
    // and becomes a disabled button rather than an active global navigation link (#561).
    expect(rootSettingsControl().tagName).toBe('BUTTON')
    expect((rootSettingsControl() as HTMLButtonElement).disabled).toBe(true)
    expect(rootSettingsControl().getAttribute('aria-label')).toBe('Edit checkout root')
    fireEvent.click(rootSettingsControl())
    expect(document.querySelector('[data-testid="location"]')?.textContent).toBe('/p/cezar/')

    const checkoutId = String(posted[0]?.checkoutId)
    emitWorkspaceEvent?.('checkout-progress', {
      checkoutId,
      name: 'cezar',
      phase: 'cloning',
      line: 'Receiving objects:  42% (420/1000)',
    })
    await waitFor(() => expect(slot('clone-progress')?.textContent).toBe('Receiving objects:  42% (420/1000)'))

    // Another tab's clone must never drive this dialog's line.
    emitWorkspaceEvent?.('checkout-progress', {
      checkoutId: 'someone-else',
      name: 'other',
      phase: 'cloning',
      line: 'not mine',
    })
    // …and neither does an unrelated workspace event.
    emitWorkspaceEvent?.('project-added', { project: PROJECT })
    await waitFor(() => expect(slot('clone-progress')?.textContent).toBe('Receiving objects:  42% (420/1000)'))

    release(json({ project: PROJECT }))
    await waitFor(() => expect(slot('clone-progress')).toBeNull())
  })

  it('shows the server\'s error VERBATIM and stays open — never a silent spinner', async () => {
    serve(async () => json({ error: 'gh CLI not found — install it and run `gh auth login`' }, 503))
    const { onOpenChange } = renderDialog()
    fireEvent.change(urlInput(), { target: { value: 'open-mercato/cezar' } })
    fireEvent.click(cloneButton())

    await waitFor(() =>
      expect(slot('clone-error')?.textContent).toContain('gh CLI not found'),
    )
    // Not closed, not navigated: the reader can fix the input and try again.
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(document.querySelector('[data-testid="location"]')?.textContent).toBe('/p/cezar/')
    expect(cloneButton().disabled).toBe(false)
  })

  it('surfaces the existing-folder 409 as an error rather than navigating anywhere', async () => {
    serve(async () => json({ error: 'folder already exists: /home/me/cezar/projects/cezar' }, 409))
    renderDialog()
    fireEvent.change(urlInput(), { target: { value: 'open-mercato/cezar' } })
    fireEvent.click(cloneButton())
    await waitFor(() => expect(slot('clone-error')?.textContent).toContain('already exists'))
    expect(document.querySelector('[data-testid="location"]')?.textContent).toBe('/p/cezar/')
  })

  it('the confirm button is inert until there is something to clone', async () => {
    serve()
    renderDialog()
    expect(cloneButton().disabled).toBe(true)
    fireEvent.change(urlInput(), { target: { value: '   ' } })
    expect(cloneButton().disabled).toBe(true)
    fireEvent.change(urlInput(), { target: { value: 'open-mercato/cezar' } })
    await waitFor(() => expect(cloneButton().disabled).toBe(false))
  })
})
