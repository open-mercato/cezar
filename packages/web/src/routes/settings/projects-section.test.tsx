import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type { ProjectListEntry, ProjectsResponse, WorkspaceConfigResponse } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { AppRoutes } from '@/routes'

/**
 * Global settings → Projects (multi-project spec, step 4.4; mockup `settings-global.html`).
 *
 * The two contracts the spec names for this pane, plus the one the CODE promises:
 *
 * - the checkout-root field renders the server's own 400 reason INLINE (the step-2.7 writability
 *   probe is the only thing that can decide this, so a client-side paraphrase would be a
 *   guess presented as a fact);
 * - a project with running tasks is refused with a 409 whose message reaches the user;
 * - "Remove" deregisters and says so — the confirm copy must never let a reader believe the
 *   folder is about to be deleted. The server-side half of that guarantee (no file on disk is
 *   touched) is pinned in src/server/projects-api.test.ts.
 */

let requests: Array<{ method: string; url: string; body?: unknown }> = []
/** Set by a test to make every subsequent PATCH answer 400 with this message. */
let failPatches: string | null = null

const PROJECTS: ProjectListEntry[] = [
  {
    id: 'cezar',
    name: 'cezar',
    root: '/home/piotr/Projects/cezar',
    addedAt: '2026-07-20T09:00:00.000Z',
    lastOpenedAt: '2026-07-20T09:00:00.000Z',
    source: 'local',
    status: 'ok',
    branch: 'main',
  },
  {
    id: 'shop-backend',
    name: 'shop-backend',
    root: '/home/piotr/cezar/projects/shop-backend',
    addedAt: '2026-07-20T09:00:00.000Z',
    lastOpenedAt: '2026-07-20T09:00:00.000Z',
    source: 'checkout',
    status: 'ok',
  },
  {
    id: 'old-spike',
    name: 'old-spike',
    root: '/home/piotr/tmp/old-spike',
    addedAt: '2026-06-02T09:00:00.000Z',
    lastOpenedAt: '2026-06-02T09:00:00.000Z',
    source: 'local',
    status: 'missing',
    // The workspace's existing vocabulary — what the OTHER rows autocomplete from. Parked on a
    // project no other test mutates, so the suggestion cases and the add/remove cases cannot
    // interfere with each other.
    tags: ['storefront', 'backend'],
  },
]

type Answers = {
  /** What `PUT /api/v1/workspace/config` answers — a 400 stands in for the writability probe. */
  putConfig?: { status: number; payload: unknown }
  /** What `DELETE /api/v1/projects/:id` answers. */
  del?: { status: number; payload: unknown }
}

function serve(answers: Answers = {}) {
  requests = []
  failPatches = null
  const registry: ProjectsResponse = {
    // Copies, not the shared PROJECTS objects: the PATCH handler mutates entries.
    projects: PROJECTS.map((p) => ({ ...p })),
    bootProject: 'cezar',
    projectsDir: '~/cezar/projects',
  }
  const config: WorkspaceConfigResponse = {
    agentDefaults: {},
    browseRoot: '~/',
    projectsDir: '~/cezar/projects',
    skillsAutoUpdate: null,
    effectiveSkillsAutoUpdate: true,
    composerDefaults: {
      autonomous: null,
      worktree: null,
      inheritedAutonomous: 'source-dependent',
      inheritedWorktree: false,
    },
    resources: {
      maxParallel: 2,
      maxMonitoringSessions: 2,
      monitoringWakeIntervalMinutes: null,
      autoResumeOnUsageLimit: true,
      memoryLimitMb: null,
      worktreeRetentionDefault: 10,
    },
  }
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
      requests.push({ method, url, body })
      if (url === '/api/v1/projects' && method === 'GET') return json(registry)
      if (url === '/api/v1/workspace/config' && method === 'GET') return json(config)
      if (url === '/api/v1/workspace/config' && method === 'PUT') {
        if (answers.putConfig) return json(answers.putConfig.payload, answers.putConfig.status)
        config.browseRoot = String(body?.browseRoot ?? config.browseRoot)
        config.projectsDir = String(body?.projectsDir ?? config.projectsDir)
        return json(config)
      }
      if (url.startsWith('/api/v1/projects/') && method === 'PATCH') {
        if (failPatches) return json({ error: failPatches }, 400)
        const id = url.split('/').pop() ?? ''
        const entry = registry.projects.find((p) => p.id === id)
        if (!entry) return json({ error: `unknown project: ${id}` }, 404)
        // Mirrors the route: each key applies only when the body NAMED it, so a tags-only
        // PATCH must leave maxParallel alone (and vice versa).
        if (body && 'maxParallel' in body) {
          const mp = body.maxParallel
          if (mp === null) delete entry.maxParallel
          else entry.maxParallel = mp as number
        }
        if (body && 'tags' in body) {
          const raw = Array.isArray(body.tags) ? (body.tags as string[]) : []
          // The server normalizes (trim, case-insensitive dedupe, sort) before storing.
          const bySpelling = new Map<string, string>()
          for (const tag of raw.map((t) => t.trim()).filter(Boolean)) {
            if (!bySpelling.has(tag.toLowerCase())) bySpelling.set(tag.toLowerCase(), tag)
          }
          const tags = [...bySpelling.values()].sort((a, b) => a.localeCompare(b))
          if (tags.length === 0) delete entry.tags
          else entry.tags = tags
        }
        return json({ project: entry })
      }
      if (url.startsWith('/api/v1/projects/') && method === 'DELETE') {
        const answer = answers.del ?? { status: 200, payload: { removed: true, id: url.split('/').pop() } }
        if (answer.status === 200) {
          registry.projects = registry.projects.filter((p) => !url.endsWith(`/${p.id}`))
        }
        return json(answer.payload, answer.status)
      }
      return new Promise<never>(() => {})
    }),
  )
}

/** Seeds the step-3.2 route gates so the (unscoped) global settings shell renders immediately. */
function gateSeededClient() {
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, { bootProject: 'cezar' })
  client.setQueryData(workspaceQueryKeys.projects, {
    projects: PROJECTS,
    bootProject: 'cezar',
    projectsDir: '~/cezar/projects',
  })
  return client
}

function renderProjects() {
  const client = gateSeededClient()
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/settings/global/projects']}>
        <AppRoutes />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return client
}

const rows = () => document.querySelectorAll('[data-slot="project-row"]')
const row = (id: string) => document.querySelector<HTMLElement>(`[data-slot="project-row"][data-project="${id}"]`)
const removeButton = (id: string) => row(id)?.querySelector<HTMLButtonElement>('[data-action="project-remove"]')
const rootInput = () => document.querySelector<HTMLInputElement>('[data-slot="projects-checkout-root"]')
const saveRoot = () => document.querySelector<HTMLButtonElement>('[data-action="projects-save-checkout-root"]')
const inlineError = () => document.querySelector<HTMLElement>('[data-slot="projects-checkout-root-error"]')
const browseInput = () => document.querySelector<HTMLInputElement>('[data-slot="projects-browse-root"]')
const saveBrowse = () => document.querySelector<HTMLButtonElement>('[data-action="projects-save-browse-root"]')
const browseError = () => document.querySelector<HTMLElement>('[data-slot="projects-browse-root-error"]')
const confirmButton = () => document.querySelector<HTMLButtonElement>('[data-action="projects-confirm-remove"]')
const deletes = () => requests.filter((r) => r.method === 'DELETE')
const patches = () => requests.filter((r) => r.method === 'PATCH')
const maxParallelSelect = (id: string) =>
  row(id)?.querySelector<HTMLSelectElement>('[data-slot="project-max-parallel"]')
const tagInput = (id: string) =>
  row(id)?.querySelector<HTMLInputElement>('[data-slot="project-tag-input"]')
const tagChips = (id: string) =>
  [...(row(id)?.querySelectorAll('[data-slot="project-tag"]') ?? [])].map((chip) =>
    (chip.textContent ?? '').trim(),
  )
/** The suggestion list is PORTALLED (the registry table clips overflow), so it is queried from
 *  the document rather than from inside the row. */
const suggestions = () =>
  [...document.querySelectorAll('[data-slot="project-tag-suggestion"]')].map((option) =>
    (option.textContent ?? '').trim(),
  )

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

describe('Global settings → Projects', () => {
  it('lists every registered project with its status, source and path', async () => {
    serve()
    renderProjects()
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(row('shop-backend')?.textContent).toContain('/home/piotr/cezar/projects/shop-backend')
    expect(row('shop-backend')?.textContent).toContain('checkout')
    // The `missing` row (step 3.3 greys it out in the sidebar) is actionable HERE.
    expect(row('old-spike')?.textContent).toContain('folder not found')
    expect(removeButton('old-spike')?.disabled).toBe(false)
  })

  it('renders the 400 reason from the writability probe INLINE, verbatim', async () => {
    // The exact shape `PUT /api/v1/workspace/config` answers with when the probe fails (step 2.7).
    const reason = 'not writable: EACCES: permission denied, mkdir \'/opt/checkouts\''
    serve({ putConfig: { status: 400, payload: { error: reason } } })
    renderProjects()
    await waitFor(() => expect(rootInput()).not.toBeNull())
    fireEvent.change(rootInput()!, { target: { value: '/opt/checkouts' } })
    fireEvent.click(saveRoot()!)

    await waitFor(() => expect(inlineError()).not.toBeNull())
    // Verbatim — no paraphrase, no generic "invalid path": the server's sentence is the only
    // one that tells the user what to fix.
    expect(inlineError()!.textContent).toContain(reason)
    expect(inlineError()!.textContent).toContain('setting unchanged')
    // Inline, NOT a toast that scrolls away from the field it is about.
    expect(screen.queryByRole('status')?.textContent ?? '').not.toContain('not writable')
    // The field keeps what the user typed, and the input is flagged for assistive tech.
    expect(rootInput()!.value).toBe('/opt/checkouts')
    expect(rootInput()!.getAttribute('aria-invalid')).toBe('true')
    // A rejected save changed no authoritative data, so it must not refresh the registry.
    expect(requests.filter((r) => r.method === 'GET' && r.url === '/api/v1/projects')).toHaveLength(0)
  })

  it('clears the inline error as soon as the value changes again', async () => {
    serve({ putConfig: { status: 400, payload: { error: 'not writable: /opt/checkouts' } } })
    renderProjects()
    await waitFor(() => expect(rootInput()).not.toBeNull())
    fireEvent.change(rootInput()!, { target: { value: '/opt/checkouts' } })
    fireEvent.click(saveRoot()!)
    await waitFor(() => expect(inlineError()).not.toBeNull())
    // The message names a path that is no longer in the field — leaving it up would be a lie.
    fireEvent.change(rootInput()!, { target: { value: '~/code' } })
    await waitFor(() => expect(inlineError()).toBeNull())
  })

  it('shows a missing browse-folder warning inline and keeps the typed path', async () => {
    const reason = 'browse folder does not exist: ~/missing'
    serve({ putConfig: { status: 400, payload: { error: reason } } })
    renderProjects()
    await waitFor(() => expect(browseInput()).not.toBeNull())
    fireEvent.change(browseInput()!, { target: { value: '~/missing' } })
    fireEvent.click(saveBrowse()!)

    await waitFor(() => expect(browseError()?.textContent).toContain(reason))
    expect(browseInput()!.value).toBe('~/missing')
    expect(browseInput()!.getAttribute('aria-invalid')).toBe('true')
  })

  it('saves a valid checkout root through PUT /api/v1/workspace/config', async () => {
    serve()
    renderProjects()
    await waitFor(() => expect(rootInput()).not.toBeNull())
    expect(saveRoot()!.disabled).toBe(true) // unchanged
    fireEvent.change(rootInput()!, { target: { value: '~/code' } })
    fireEvent.click(saveRoot()!)
    await waitFor(() =>
      expect(requests.filter((r) => r.method === 'PUT' && r.url === '/api/v1/workspace/config')).toEqual([
        { method: 'PUT', url: '/api/v1/workspace/config', body: { projectsDir: '~/code' } },
      ]),
    )
    // The clone dialog reads projectsDir from this response, not workspace/config. Refreshing
    // it here keeps the next Add project opening coherent without a whole-app reload (#567).
    await waitFor(() =>
      expect(requests.filter((r) => r.method === 'GET' && r.url === '/api/v1/projects')).toHaveLength(1),
    )
    expect(inlineError()).toBeNull()
  })

  it('saves the browse folder independently without refreshing the clone destination', async () => {
    serve()
    const client = renderProjects()
    client.setQueryData(workspaceQueryKeys.fsBrowse(null), {
      path: '/home/piotr',
      parent: null,
      dirs: [],
    })
    await waitFor(() => expect(browseInput()).not.toBeNull())
    expect(browseInput()!.value).toBe('~/')
    fireEvent.change(browseInput()!, { target: { value: '~/source' } })
    fireEvent.click(saveBrowse()!)
    await waitFor(() =>
      expect(requests.filter((r) => r.method === 'PUT' && r.url === '/api/v1/workspace/config')).toEqual([
        { method: 'PUT', url: '/api/v1/workspace/config', body: { browseRoot: '~/source' } },
      ]),
    )
    expect(rootInput()!.value).toBe('~/cezar/projects')
    expect(requests.filter((r) => r.method === 'GET' && r.url === '/api/v1/projects')).toHaveLength(0)
    await waitFor(() => expect(client.getQueryState(workspaceQueryKeys.fsBrowse(null))?.isInvalidated).toBe(true))
  })

  it('removes a project only after a confirm that promises no files are deleted', async () => {
    serve()
    renderProjects()
    await waitFor(() => expect(rows()).toHaveLength(3))
    fireEvent.click(removeButton('shop-backend')!)
    await waitFor(() => expect(confirmButton()).not.toBeNull())

    // The copy is the guarantee: a user must not be able to read this as "delete my repo".
    const dialog = document.querySelector('[role="alertdialog"]')!
    expect(dialog.textContent).toContain('only unregisters')
    expect(dialog.textContent).toContain('nothing on disk is deleted')
    expect(confirmButton()!.textContent).toContain('Remove from list')
    expect(deletes()).toEqual([])

    fireEvent.click(confirmButton()!)
    await waitFor(() => expect(deletes().map((r) => r.url)).toEqual(['/api/v1/projects/shop-backend']))
    await waitFor(() => expect(row('shop-backend')).toBeNull())
  })

  it('dismissing the confirm never calls the route', async () => {
    serve()
    renderProjects()
    await waitFor(() => expect(rows()).toHaveLength(3))
    fireEvent.click(removeButton('old-spike')!)
    await waitFor(() => expect(confirmButton()).not.toBeNull())
    fireEvent.click(screen.getByText('Keep it'))
    await waitFor(() => expect(confirmButton()).toBeNull())
    expect(deletes()).toEqual([])
  })

  it('surfaces the running-tasks 409 and keeps the project', async () => {
    const error = 'shop-backend has 2 running tasks — cancel or finish them before removing the project'
    serve({ del: { status: 409, payload: { error, runningTasks: 2 } } })
    renderProjects()
    await waitFor(() => expect(rows()).toHaveLength(3))
    fireEvent.click(removeButton('shop-backend')!)
    await waitFor(() => expect(confirmButton()).not.toBeNull())
    fireEvent.click(confirmButton()!)

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(error))
    // Refused means untouched — the row is still there.
    expect(row('shop-backend')).not.toBeNull()
  })

  it('pins a per-project max-parallel and can clear it back to inherit (2026-07-22)', async () => {
    serve()
    renderProjects()
    await waitFor(() => expect(rows()).toHaveLength(3))
    const select = maxParallelSelect('shop-backend')
    expect(select).not.toBeNull()
    // Unset projects show the inherit option carrying the live workspace cap (2).
    expect(select!.value).toBe('')
    expect(select!.textContent).toContain('Inherit workspace (2)')

    // Choosing a number PATCHes the per-project ceiling…
    fireEvent.change(select!, { target: { value: '1' } })
    await waitFor(() =>
      expect(patches()).toEqual([
        { method: 'PATCH', url: '/api/v1/projects/shop-backend', body: { maxParallel: 1 } },
      ]),
    )
    // …and the row reflects the persisted value after the query refreshes.
    await waitFor(() => expect(maxParallelSelect('shop-backend')!.value).toBe('1'))

    // Selecting "Inherit" clears the override with an explicit null.
    fireEvent.change(maxParallelSelect('shop-backend')!, { target: { value: '' } })
    await waitFor(() =>
      expect(patches().at(-1)).toEqual({
        method: 'PATCH',
        url: '/api/v1/projects/shop-backend',
        body: { maxParallel: null },
      }),
    )
    await waitFor(() => expect(maxParallelSelect('shop-backend')!.value).toBe(''))
  })

  /**
   * Tags: the labels that group connected repositories, which the global Tasks page filters by.
   * What matters here is that the editor never keeps its own copy of the list — every gesture
   * sends the WHOLE new list and the row re-renders from the server's answer.
   */
  describe('tags', () => {
    it('adds a tag on Enter, sending the whole list', async () => {
      serve()
      renderProjects()
      await waitFor(() => expect(rows()).toHaveLength(3))

      fireEvent.change(tagInput('shop-backend')!, { target: { value: 'storefront' } })
      fireEvent.keyDown(tagInput('shop-backend')!, { key: 'Enter' })

      await waitFor(() =>
        expect(patches()).toEqual([
          { method: 'PATCH', url: '/api/v1/projects/shop-backend', body: { tags: ['storefront'] } },
        ]),
      )
      await waitFor(() => expect(tagChips('shop-backend')).toEqual(['storefront']))
      // The draft is consumed, not left sitting in the field.
      expect(tagInput('shop-backend')!.value).toBe('')

      // A second tag sends BOTH — the list is replaced wholesale, never merged server-side.
      fireEvent.change(tagInput('shop-backend')!, { target: { value: 'api' } })
      fireEvent.keyDown(tagInput('shop-backend')!, { key: 'Enter' })
      await waitFor(() =>
        expect(patches().at(-1)!.body).toEqual({ tags: ['storefront', 'api'] }),
      )
    })

    it('treats a comma as a separator', async () => {
      serve()
      renderProjects()
      await waitFor(() => expect(rows()).toHaveLength(3))

      fireEvent.change(tagInput('cezar')!, { target: { value: 'infra' } })
      fireEvent.keyDown(tagInput('cezar')!, { key: ',' })
      await waitFor(() => expect(patches().at(-1)!.body).toEqual({ tags: ['infra'] }))
    })

    it('refuses a duplicate locally rather than sending a no-op the server would 200', async () => {
      serve()
      renderProjects()
      await waitFor(() => expect(rows()).toHaveLength(3))

      fireEvent.change(tagInput('cezar')!, { target: { value: 'infra' } })
      fireEvent.keyDown(tagInput('cezar')!, { key: 'Enter' })
      await waitFor(() => expect(tagChips('cezar')).toEqual(['infra']))

      // Same tag in a different case: the server would dedupe it away and answer 200, which
      // would look like it worked.
      fireEvent.change(tagInput('cezar')!, { target: { value: 'INFRA' } })
      fireEvent.keyDown(tagInput('cezar')!, { key: 'Enter' })
      await waitFor(() => expect(tagInput('cezar')!.value).toBe(''))
      expect(patches()).toHaveLength(1)
    })

    it('removes a tag from its chip, and with Backspace on an empty field', async () => {
      serve()
      renderProjects()
      await waitFor(() => expect(rows()).toHaveLength(3))

      for (const tag of ['api', 'web']) {
        fireEvent.change(tagInput('cezar')!, { target: { value: tag } })
        fireEvent.keyDown(tagInput('cezar')!, { key: 'Enter' })
        await waitFor(() => expect(tagChips('cezar')).toContain(tag))
      }

      fireEvent.click(
        row('cezar')!.querySelector<HTMLButtonElement>('[data-action="project-tag-remove"]')!,
      )
      await waitFor(() => expect(tagChips('cezar')).toEqual(['web']))

      fireEvent.keyDown(tagInput('cezar')!, { key: 'Backspace' })
      await waitFor(() => expect(patches().at(-1)!.body).toEqual({ tags: [] }))
      await waitFor(() => expect(tagChips('cezar')).toEqual([]))
    })

    it('autocompletes from the tags already used in the workspace', async () => {
      // The point of the vocabulary: tags only group anything if the second repo lands on the
      // first one's spelling, and free text does not converge on its own.
      serve()
      renderProjects()
      await waitFor(() => expect(rows()).toHaveLength(3))

      // Focusing the empty field answers "which tags exist here?" before a keystroke.
      fireEvent.focus(tagInput('cezar')!)
      await waitFor(() => expect(suggestions()).toEqual(['backend', 'storefront']))

      fireEvent.change(tagInput('cezar')!, { target: { value: 'stor' } })
      await waitFor(() => expect(suggestions()).toEqual(['storefront']))

      fireEvent.click(document.querySelector('[data-slot="project-tag-suggestion"]')!)
      await waitFor(() => expect(patches().at(-1)!.body).toEqual({ tags: ['storefront'] }))
      await waitFor(() => expect(tagChips('cezar')).toEqual(['storefront']))
    })

    it('stays open on the very click that opened it', async () => {
      // The reported bug: the list appeared for a blink and vanished. Opening on `focus` mounts
      // Radix's DismissableLayer mid-dispatch, so its fresh document listeners saw the focus
      // that OPENED the layer as an interaction outside it and dismissed immediately. Replayed
      // here as the events that reach those listeners while the list is already up.
      serve()
      renderProjects()
      await waitFor(() => expect(rows()).toHaveLength(3))

      fireEvent.focus(tagInput('cezar')!)
      await waitFor(() => expect(suggestions()).toEqual(['backend', 'storefront']))

      fireEvent.focusIn(tagInput('cezar')!)
      fireEvent.pointerDown(tagInput('cezar')!)
      fireEvent.mouseDown(tagInput('cezar')!)

      expect(suggestions()).toEqual(['backend', 'storefront'])
      expect(tagInput('cezar')!.getAttribute('aria-expanded')).toBe('true')
    })

    it('closes when focus really does leave the field', async () => {
      // The other half: with the layer no longer owning dismissal, blur is what closes it.
      serve()
      renderProjects()
      await waitFor(() => expect(rows()).toHaveLength(3))

      fireEvent.focus(tagInput('cezar')!)
      await waitFor(() => expect(suggestions()).toHaveLength(2))

      fireEvent.blur(tagInput('cezar')!)
      await waitFor(() => expect(suggestions()).toEqual([]))
    })

    it('does not suggest a tag the project already has', async () => {
      serve()
      renderProjects()
      await waitFor(() => expect(rows()).toHaveLength(3))

      // old-spike already carries both, so its own field has nothing left to offer.
      fireEvent.focus(tagInput('old-spike')!)
      await waitFor(() => expect(tagInput('old-spike')!.getAttribute('aria-expanded')).toBe('false'))
      expect(suggestions()).toEqual([])
    })

    it('picks the highlighted suggestion with the arrow keys and Enter', async () => {
      serve()
      renderProjects()
      await waitFor(() => expect(rows()).toHaveLength(3))

      fireEvent.focus(tagInput('cezar')!)
      await waitFor(() => expect(suggestions()).toEqual(['backend', 'storefront']))

      fireEvent.keyDown(tagInput('cezar')!, { key: 'ArrowDown' })
      fireEvent.keyDown(tagInput('cezar')!, { key: 'ArrowDown' })
      await waitFor(() =>
        expect(tagInput('cezar')!.getAttribute('aria-activedescendant')).toBe(
          'project-tag-suggestions-cezar-1',
        ),
      )

      fireEvent.keyDown(tagInput('cezar')!, { key: 'Enter' })
      await waitFor(() => expect(patches().at(-1)!.body).toEqual({ tags: ['storefront'] }))
    })

    it('still creates a tag nobody has used yet', async () => {
      serve()
      renderProjects()
      await waitFor(() => expect(rows()).toHaveLength(3))

      fireEvent.change(tagInput('cezar')!, { target: { value: 'brand-new' } })
      // Nothing to suggest — the field is a plain token input again.
      await waitFor(() => expect(suggestions()).toEqual([]))
      fireEvent.keyDown(tagInput('cezar')!, { key: 'Enter' })
      await waitFor(() => expect(patches().at(-1)!.body).toEqual({ tags: ['brand-new'] }))
    })

    it('Escape closes the list without discarding what was typed', async () => {
      serve()
      renderProjects()
      await waitFor(() => expect(rows()).toHaveLength(3))

      fireEvent.change(tagInput('cezar')!, { target: { value: 'stor' } })
      await waitFor(() => expect(suggestions()).toEqual(['storefront']))

      fireEvent.keyDown(tagInput('cezar')!, { key: 'Escape' })
      await waitFor(() => expect(suggestions()).toEqual([]))
      // Dismissing a suggestion list is not the same gesture as abandoning the draft.
      expect(tagInput('cezar')!.value).toBe('stor')
    })

    it('keeps the first tag when a second is added before the refetch lands', async () => {
      // The reported bug. The editor is bound to the server value with no local mirror, so
      // between the PATCH and the refetch the cached project still held the OLD list — and the
      // whole list is replaced wholesale, so the second save silently DELETED the first tag.
      // The optimistic write in `useUpdateProject` is what makes the second click compose on
      // top of the first.
      serve()
      renderProjects()
      await waitFor(() => expect(rows()).toHaveLength(3))

      fireEvent.change(tagInput('cezar')!, { target: { value: 'api' } })
      fireEvent.keyDown(tagInput('cezar')!, { key: 'Enter' })
      await waitFor(() => expect(tagChips('cezar')).toEqual(['api']))

      fireEvent.change(tagInput('cezar')!, { target: { value: 'web' } })
      fireEvent.keyDown(tagInput('cezar')!, { key: 'Enter' })

      // The second request carries BOTH — it read the list the first one just produced.
      await waitFor(() => expect(patches().at(-1)!.body).toEqual({ tags: ['api', 'web'] }))
      await waitFor(() => expect(tagChips('cezar')).toEqual(['api', 'web']))
    })

    it('puts the row back when the server refuses the edit', async () => {
      serve()
      renderProjects()
      await waitFor(() => expect(rows()).toHaveLength(3))

      fireEvent.change(tagInput('cezar')!, { target: { value: 'infra' } })
      fireEvent.keyDown(tagInput('cezar')!, { key: 'Enter' })
      await waitFor(() => expect(tagChips('cezar')).toEqual(['infra']))

      // A 400 from here on: the optimistic chip must not survive a refusal.
      failPatches = 'tag too long'
      fireEvent.change(tagInput('cezar')!, { target: { value: 'nope' } })
      fireEvent.keyDown(tagInput('cezar')!, { key: 'Enter' })

      // `getAllByRole`: the successful first add left its own toast up, so there are two.
      await waitFor(() =>
        expect(
          screen.getAllByRole('status').some((toast) => toast.textContent?.includes('tag too long')),
        ).toBe(true),
      )
      await waitFor(() => expect(tagChips('cezar')).toEqual(['infra']))
    })

    it('never touches maxParallel when only tags change', async () => {
      serve()
      renderProjects()
      await waitFor(() => expect(rows()).toHaveLength(3))

      fireEvent.change(maxParallelSelect('shop-backend')!, { target: { value: '3' } })
      await waitFor(() => expect(maxParallelSelect('shop-backend')!.value).toBe('3'))

      fireEvent.change(tagInput('shop-backend')!, { target: { value: 'storefront' } })
      fireEvent.keyDown(tagInput('shop-backend')!, { key: 'Enter' })

      await waitFor(() => expect(tagChips('shop-backend')).toEqual(['storefront']))
      // The tags PATCH named only `tags`, so the ceiling survived it.
      expect(patches().at(-1)!.body).toEqual({ tags: ['storefront'] })
      expect(maxParallelSelect('shop-backend')!.value).toBe('3')
    })
  })

  it('disables Remove for the project cezar is serving', async () => {
    serve()
    renderProjects()
    await waitFor(() => expect(rows()).toHaveLength(3))
    // The server refuses it too (it re-registers at every start); disabling explains it first.
    expect(removeButton('cezar')?.disabled).toBe(true)
    expect(removeButton('cezar')?.title).toContain('re-registers')
  })
})
