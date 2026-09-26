import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useNavigate } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type { Skill, SkillsUpdateState, WorkflowsResponse } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { AppRoutes } from '@/routes'

/**
 * `/skills` (R6 Step 1.4): the catalog + detail against fixture payloads, the #377
 * ordering/bold rendering, the #384 refresh contract (selection and scroll survive), and the
 * inline bookmarklet generation. The pure rules themselves are pinned in
 * lib/skills.test.ts and lib/bookmarklet.test.ts — this file asserts the SURFACE honors them.
 */

// ---- fixtures --------------------------------------------------------------------------------

const skill = (over: Partial<Skill> & Pick<Skill, 'name' | 'source'>): Skill => ({
  body: `# ${over.name}\n\nBody of ${over.name}.`,
  path: `.ai/skills/${over.name}.md`,
  ...over,
})

// Deliberately listed global-first: the SECTION must reorder project-first (#377).
const SKILLS: Skill[] = [
  skill({
    name: 'zebra-global',
    source: 'global',
    path: '/home/u/.agents/skills/zebra-global/SKILL.md',
    description: 'A global skill',
  }),
  skill({ name: 'om-fix', source: 'ai', description: 'Fix an issue end to end' }),
  skill({ name: 'om-review', source: 'cezar', path: '.ai/cezar/skills/om-review.md' }),
]

const openMercatoSkill = (name: string): Skill =>
  skill({
    name,
    source: 'team',
    path: `open-mercato/skills/${name}/SKILL.md`,
    team: { repo: 'open-mercato/skills', ref: 'main', path: `${name}/SKILL.md`, dir: true },
  })

const WORKFLOWS: WorkflowsResponse = {
  workflows: [
    {
      name: 'fix-and-verify',
      source: 'file',
      steps: [{ id: 'fix', name: 'Fix', skill: 'om-fix' }],
    },
  ],
  issues: [],
}

const CURRENT_SKILLS_UPDATE: SkillsUpdateState = {
  status: 'current',
  available: false,
  autoUpdateEnabled: true,
  inherited: true,
  checkedAt: null,
  updatedAt: null,
  scopes: [],
  needsUpgradeNotes: false,
}

let requests: Array<{ method: string; url: string; body?: unknown }> = []

function serve({
  skills = SKILLS,
  refreshed = SKILLS,
  importable = [],
  importableFailure = false,
  uiState = {},
  skillsUpdate = CURRENT_SKILLS_UPDATE,
}: {
  skills?: Skill[]
  refreshed?: Skill[]
  importable?: Skill[]
  importableFailure?: boolean
  uiState?: Record<string, unknown>
  skillsUpdate?: SkillsUpdateState
} = {}) {
  requests = []
  // Skill activation lives in the active project's ui-state.
  const projectStates = new Map<string, Record<string, unknown>>([['boot', { ...uiState }]])
  let workspaceState: Record<string, unknown> = {}
  const json = (payload: unknown) =>
    new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const path = url.replace(/^\/api\/v1\/p\/[^/]+/, '/api/v1')
      const scope = /^\/api\/v1\/p\/([^/]+)/.exec(url)?.[1] ?? 'boot'
      const projectState = projectStates.get(scope) ?? {}
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      requests.push({ method, url, body })
      if (path === '/api/v1/skills' && method === 'GET') {
        const selected = Array.isArray(projectState.importedSkills)
          ? new Set(projectState.importedSkills as string[])
          : new Set(importable.map((item) => item.name))
        return json(
          skills.filter(
            (item) => item.source !== 'team' || !importable.some((candidate) => candidate.name === item.name) || selected.has(item.name),
          ),
        )
      }
      if (path === '/api/v1/skills/refresh' && method === 'POST') return json(refreshed)
      // Both the fast read and the ?wait=1 convergence read hit this endpoint.
      if (path.startsWith('/api/v1/skills/importable')) {
        return importableFailure ? new Response('skills catalog unavailable', { status: 503 }) : json(importable)
      }
      if (path === '/api/v1/workflows') return json(WORKFLOWS)
      if (url === '/api/v1/launch-key') return json({ key: 'sekret' })
      if (path.startsWith('/api/v1/workspace/skills-update?projectId=')) return json(skillsUpdate)
      if (path === '/api/v1/workspace/skills-update/check' && method === 'POST') return json(skillsUpdate)
      if (path === '/api/v1/workspace/skills-update/apply' && method === 'POST') {
        return json({
          ...skillsUpdate,
          status: 'current',
          available: false,
          updatedAt: '2026-09-24T12:00:00.000Z',
          needsUpgradeNotes: true,
        })
      }
      if (path === '/api/v1/ui-state' && method === 'GET') return json(projectState)
      if (path === '/api/v1/ui-state' && method === 'PUT') {
        const merged = { ...projectState, ...(body as Record<string, unknown>) }
        projectStates.set(scope, merged)
        return json(merged)
      }
      if (path === '/api/v1/workspace/ui-state' && method === 'GET') return json(workspaceState)
      if (path === '/api/v1/workspace/ui-state' && method === 'PUT') {
        workspaceState = { ...workspaceState, ...(body as Record<string, unknown>) }
        return json(workspaceState)
      }
      return new Promise<never>(() => {})
    }),
  )
}

/** Seeds the step-3.2 route gates — boot id (legacy redirect) + registry (known-check) — so a
 *  flat entry URL lands scoped immediately. The boot project mounts UNSCOPED, so the exact
 *  `/api/v1/*` paths this file's fetch stub matches stay byte-identical. */
function gateSeededClient() {
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, { bootProject: 'boot' })
  client.setQueryData(workspaceQueryKeys.projects, {
    projects: [],
    bootProject: 'boot',
    projectsDir: '~/cezar/projects',
  })
  return client
}

function renderAt(
  entry: string,
  client = gateSeededClient(),
  onNavigate?: (navigate: ReturnType<typeof useNavigate>) => void,
) {
  function CaptureNavigate() {
    const navigate = useNavigate()
    onNavigate?.(navigate)
    return null
  }
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        {onNavigate && <CaptureNavigate />}
        <AppRoutes />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return client
}

const rowNames = () =>
  [...document.querySelectorAll('[data-slot="skill-row"]')].map((el) => el.getAttribute('data-skill'))

const detail = () => document.querySelector('[data-slot="skills-detail"] [data-slot="skill-detail"]')

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

describe('the catalog list and skill preview', () => {
  it('renders project-first with bold project rows and source tags (#377)', async () => {
    serve()
    renderAt('/skills')
    await waitFor(() => expect(rowNames()).toEqual(['om-fix', 'om-review', 'zebra-global']))
    const rows = [...document.querySelectorAll('[data-slot="skill-row"]')]
    expect(rows[0]?.getAttribute('data-project')).toBe('true')
    expect(rows[1]?.getAttribute('data-project')).toBe('true')
    expect(rows[2]?.hasAttribute('data-project')).toBe(false)
    expect(rows[0]?.querySelector('[data-slot="skill-source"]')?.textContent).toBe('ai')
    expect(rows[2]?.querySelector('[data-slot="skill-source"]')?.textContent).toBe('global')
    expect(detail()?.querySelector('h2')?.textContent).toBe('om-fix')
  })

  it('selects a skill in the preview and returns to the list on mobile', async () => {
    serve()
    renderAt('/skills')
    await waitFor(() => expect(rowNames()).toHaveLength(3))
    fireEvent.click(document.querySelector('[data-slot="skill-row"][data-skill="om-review"]')!)
    await waitFor(() => expect(detail()?.querySelector('h2')?.textContent).toBe('om-review'))
    fireEvent.click(document.querySelector('[data-slot="skills-back"]')!)
    await waitFor(() => expect(document.querySelector('[data-slot="skills-detail"]')?.className).toContain('hidden'))
  })

  it('shows a recoverable error when the team skills catalog fails', async () => {
    const teamSkill = openMercatoSkill('team-review')
    serve({ skills: [...SKILLS, teamSkill], importableFailure: true })
    renderAt('/skills')
    await waitFor(() => expect(rowNames()).toContain('team-review'))

    const alert = await screen.findByRole('alert', {}, { timeout: 3_000 })
    expect(alert.textContent).toContain('Could not load the Open Mercato skills catalog.')
    expect(rowNames()).toContain('team-review')
    const row = document.querySelector('[data-slot="skill-row"][data-skill="team-review"]')!
    const toggle = row.parentElement?.querySelector<HTMLButtonElement>('[data-slot="skill-activation"]')
    expect(toggle?.hasAttribute('data-disabled')).toBe(true)

    const attempts = requests.filter((request) => request.url.includes('/api/v1/skills/importable')).length
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => {
      expect(requests.filter((request) => request.url.includes('/api/v1/skills/importable')).length).toBeGreaterThan(
        attempts,
      )
    })
  })

  it('shows the Open Mercato skills update status when no skills are tracked', async () => {
    serve()
    renderAt('/p/boot/skills')

    expect(await screen.findByText('No installed Open Mercato skills are tracked for updates.')).toBeTruthy()
  })

  it('puts team-skill activation in the catalog row without making the name toggle', async () => {
    const importedSkill = openMercatoSkill('team-review')
    serve({ skills: [...SKILLS, importedSkill], importable: [importedSkill] })
    renderAt('/skills')
    await waitFor(() => {
      const row = document.querySelector('[data-slot="skill-row"][data-skill="team-review"]')
      expect(row).not.toBeNull()
      expect(row?.parentElement?.querySelector('[data-slot="skill-activation"]')).not.toBeNull()
    })
    const row = document.querySelector('[data-slot="skill-row"][data-skill="team-review"]')!
    const toggle = row.parentElement?.querySelector<HTMLElement>('[data-slot="skill-activation"]')!
    expect(toggle.getAttribute('data-state')).toBe('checked')
    fireEvent.click(toggle)
    await waitFor(() =>
      expect(requests.filter((request) => request.method === 'PUT' && request.url.endsWith('/ui-state')).at(-1)?.body)
        .toMatchObject({ importedSkills: [] }),
    )
    expect(
      requests.find((request) => request.method === 'PUT' && Array.isArray((request.body as { importedSkills?: unknown })?.importedSkills))
        ?.url,
    ).toBe('/api/v1/p/boot/ui-state')
    await waitFor(() => expect(row.getAttribute('data-enabled')).toBe('false'))
    fireEvent.click(row)
    await waitFor(() => expect(detail()?.querySelector('h2')?.textContent).toBe('team-review'))
    expect(detail()?.querySelector('[data-slot="skill-status"]')).toBeNull()
    const detailToggle = detail()?.querySelector<HTMLElement>('[data-slot="skill-activation-detail"]')
    expect(detailToggle?.getAttribute('data-state')).toBe('unchecked')
    const sourceTag = detail()?.querySelector<HTMLElement>('[data-slot="skill-source"]')
    expect(sourceTag?.getAttribute('title')).toBeNull()
    expect(sourceTag?.getAttribute('aria-label')).toBe(
      'Shared from open-mercato/skills, a team skills repository configured for this project.',
    )
    expect(detail()?.querySelector('[data-slot="skill-body"]')?.textContent).toContain('Body of team-review.')
    expect(detail()?.querySelector('[data-slot="skill-run-from-github"]')).toBeNull()
    fireEvent.click(detailToggle!)
    await waitFor(() =>
      expect(requests.filter((request) => request.method === 'PUT' && request.url.endsWith('/ui-state')).at(-1)?.body)
        .toMatchObject({ importedSkills: ['team-review'] }),
    )
    await waitFor(() => expect(detailToggle?.getAttribute('data-state')).toBe('checked'))
  })

  it('keeps disabled skills in alphabetical order with enabled skills', async () => {
    const disabled = openMercatoSkill('team-alpha')
    const enabled = openMercatoSkill('team-zeta')
    serve({
      skills: [...SKILLS, enabled],
      importable: [disabled, enabled],
      uiState: { importedSkills: ['team-zeta'] },
    })
    renderAt('/skills')

    await waitFor(() => expect(rowNames()).toHaveLength(5))
    expect(rowNames()).toEqual(['om-fix', 'om-review', 'team-alpha', 'team-zeta', 'zebra-global'])
    expect(document.querySelector('[data-slot="skill-row"][data-skill="team-alpha"]')?.getAttribute('data-enabled')).toBe('false')
  })

  it('writes a team-skill choice to the active project ui-state', async () => {
    const importedSkill = openMercatoSkill('team-review')
    serve({ skills: [...SKILLS, importedSkill], importable: [importedSkill] })
    const client = gateSeededClient()
    client.setQueryData(workspaceQueryKeys.projects, {
      projects: [
        {
          id: 'other',
          name: 'other',
          root: '/other',
          addedAt: '2026-09-24T12:00:00.000Z',
          lastOpenedAt: '2026-09-24T12:00:00.000Z',
          source: 'local',
          status: 'ok',
        },
      ],
      bootProject: 'boot',
      projectsDir: '~/cezar/projects',
    })
    renderAt('/p/other/skills', client)
    const toggle = await screen.findByRole('switch', { name: 'Disable team-review' })

    fireEvent.click(toggle)
    await waitFor(() => {
      expect(requests.find((request) => request.method === 'PUT' && request.url.endsWith('/ui-state'))).toMatchObject({
        url: '/api/v1/p/other/ui-state',
        body: { importedSkills: [] },
      })
    })
  })

  it('checks and applies installed skill updates for the active project', async () => {
    const update: SkillsUpdateState = {
      ...CURRENT_SKILLS_UPDATE,
      status: 'available',
      available: true,
      scopes: [
        {
          scope: 'project',
          status: 'available',
          available: true,
          skills: ['om-fix'],
          checkedAt: null,
          updatedAt: null,
        },
      ],
    }
    serve({ skillsUpdate: update })
    const client = gateSeededClient()
    client.setQueryData(workspaceQueryKeys.projects, {
      projects: [
        {
          id: 'other',
          name: 'other',
          root: '/other',
          addedAt: '2026-09-24T12:00:00.000Z',
          lastOpenedAt: '2026-09-24T12:00:00.000Z',
          source: 'local',
          status: 'ok',
        },
      ],
      bootProject: 'boot',
      projectsDir: '~/cezar/projects',
    })
    renderAt('/p/other/skills', client)

    fireEvent.click(await screen.findByRole('button', { name: 'Update now' }))
    await waitFor(() => {
      const request = requests.find((entry) => entry.method === 'POST' && entry.url === '/api/v1/workspace/skills-update/apply')
      expect(request?.body).toEqual({ projectId: 'other' })
    })
    expect(await screen.findByRole('heading', { name: 'Apply the upgrade notes now?' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'No' }))
  })

  it('serializes quick toggles so the newest imported-skill selection wins', async () => {
    const first = openMercatoSkill('team-first')
    const second = openMercatoSkill('team-second')
    serve({ skills: [...SKILLS, first, second], importable: [first, second] })
    const client = renderAt('/skills')
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="skill-activation"][aria-label^="Disable team-"]')).toHaveLength(2),
    )

    const fetchMock = vi.mocked(fetch)
    const fetchNormally = fetchMock.getMockImplementation()!
    const writes: Array<{ body: unknown; resolve: (response: Response) => void }> = []
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/ui-state') && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as unknown
        return new Promise<Response>((resolve) => writes.push({ body, resolve }))
      }
      return fetchNormally(input, init)
    })

    fireEvent.click(document.querySelector('[data-slot="skill-activation"][aria-label="Disable team-first"]')!)
    await waitFor(() => expect(writes).toHaveLength(1))
    fireEvent.click(document.querySelector('[data-slot="skill-activation"][aria-label="Disable team-second"]')!)
    expect(writes).toHaveLength(1)

    const response = (payload: unknown) =>
      new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    expect(writes[0]?.body).toEqual({ importedSkills: ['team-second'] })
    await act(async () => writes[0]?.resolve(response({ importedSkills: ['team-second'] })))
    await waitFor(() => expect(writes).toHaveLength(2))
    expect(writes[1]?.body).toEqual({ importedSkills: [] })
    await act(async () => writes[1]?.resolve(response({ importedSkills: [] })))
    await waitFor(() =>
      expect((client.getQueryData(queryKeys.uiState) as { importedSkills?: string[] })?.importedSkills).toEqual([]),
    )
  })

  it('keeps queued skill writes scoped to the project where the toggles happened', async () => {
    const first = openMercatoSkill('team-first')
    const second = openMercatoSkill('team-second')
    serve({ skills: [...SKILLS, first, second], importable: [first, second] })
    const client = gateSeededClient()
    client.setQueryData(workspaceQueryKeys.projects, {
      projects: [
        {
          id: 'other',
          name: 'other',
          root: '/other',
          addedAt: '2026-09-24T12:00:00.000Z',
          lastOpenedAt: '2026-09-24T12:00:00.000Z',
          source: 'local',
          status: 'ok',
        },
      ],
      bootProject: 'boot',
      projectsDir: '~/cezar/projects',
    })
    let navigate!: ReturnType<typeof useNavigate>
    renderAt('/p/boot/skills', client, (value) => {
      navigate = value
    })
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="skill-activation"][aria-label^="Disable team-"]')).toHaveLength(2),
    )

    const fetchMock = vi.mocked(fetch)
    const fetchNormally = fetchMock.getMockImplementation()!
    const writes: Array<{ url: string; body: unknown; resolve: (response: Response) => void }> = []
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/ui-state') && init?.method === 'PUT') {
        return new Promise<Response>((resolve) =>
          writes.push({ url: String(input), body: JSON.parse(String(init.body)), resolve }),
        )
      }
      return fetchNormally(input, init)
    })

    fireEvent.click(document.querySelector('[data-slot="skill-activation"][aria-label="Disable team-first"]')!)
    await waitFor(() => expect(writes).toHaveLength(1))
    fireEvent.click(document.querySelector('[data-slot="skill-activation"][aria-label="Disable team-second"]')!)
    await act(async () => navigate('/p/other/skills'))
    const response = (payload: unknown) =>
      new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    await act(async () => writes[0]?.resolve(response({ importedSkills: ['team-second'] })))
    await waitFor(() => expect(writes).toHaveLength(2))
    expect(writes.map(({ url }) => url)).toEqual(['/api/v1/p/boot/ui-state', '/api/v1/p/boot/ui-state'])
    expect(writes[1]?.body).toEqual({ importedSkills: [] })
    await act(async () => writes[1]?.resolve(response({ importedSkills: [] })))
  })

  it('filters the skills list without adding a separate GitHub launcher view', async () => {
    serve()
    renderAt('/skills')
    await waitFor(() => expect(rowNames()).toHaveLength(3))
    fireEvent.change(document.querySelector('[data-slot="skills-filter"]')!, { target: { value: 'review' } })
    expect(rowNames()).toEqual(['om-review'])
    expect(document.querySelector('[data-slot="bookmarklets-row"]')).toBeNull()
  })

  it('explains where skills come from when the catalog is empty', async () => {
    serve({ skills: [] })
    renderAt('/skills')
    await waitFor(() => {
      const text = document.querySelector('[data-slot="skill-rows"]')?.textContent ?? ''
      expect(text).toContain('.ai/skills/')
      expect(text).toContain('.ai/cezar/skills/')
      expect(text).toContain('.agents/skills/')
    })
  })
})

describe('refresh (#384: selection and scroll survive)', () => {
  it('POSTs /api/v1/skills/refresh, keeps the selected skill, the row container and its scroll', async () => {
    serve({ refreshed: [...SKILLS, skill({ name: 'team-new', source: 'team' })] })
    renderAt('/skills?skill=om-review')
    await waitFor(() => expect(rowNames()).toHaveLength(3))

    const rowsBefore = document.querySelector('[data-slot="skill-rows"]')!
    rowsBefore.scrollTop = 120

    fireEvent.click(document.querySelector('[data-slot="skills-refresh"]')!)
    await waitFor(() =>
      expect(requests.some((r) => r.method === 'POST' && r.url === '/api/v1/skills/refresh')).toBe(true),
    )
    // The refreshed catalog rendered (the new team skill is in the list)…
    await waitFor(() => expect(rowNames()).toEqual(['om-fix', 'om-review', 'team-new', 'zebra-global']))

    // …but the pane was updated IN PLACE: same scroll container, same scroll offset, same
    // selection — the legacy innerHTML rebuild lost all three.
    const rowsAfter = document.querySelector('[data-slot="skill-rows"]')!
    expect(rowsAfter).toBe(rowsBefore)
    expect(rowsAfter.scrollTop).toBe(120)
    expect(
      document
        .querySelector('[data-slot="skill-row"][data-skill="om-review"]')
        ?.getAttribute('aria-current'),
    ).toBe('page')
    expect(detail()?.querySelector('h2')?.textContent).toBe('om-review')
  })

  it('a refresh that drops the selected skill returns to the list, never crashes', async () => {
    serve({ refreshed: SKILLS.filter((s) => s.name !== 'om-review') })
    renderAt('/skills?skill=om-review')
    await waitFor(() => expect(detail()?.querySelector('h2')?.textContent).toBe('om-review'))

    fireEvent.click(document.querySelector('[data-slot="skills-refresh"]')!)
    await waitFor(() => expect(document.querySelector('[data-slot="skills-detail"]')?.className).toContain('hidden'))
    expect(detail()).toBeNull()
  })
})

describe('the selected skill GitHub launcher', () => {
  it('generates a bookmarklet from inside the skill preview', async () => {
    serve()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderAt('/skills?skill=om-fix')
    await waitFor(() => expect(document.querySelector('[data-slot="skill-run-from-github"]')).not.toBeNull())

    const bookmarkletSettings = document.querySelector<HTMLAnchorElement>('[data-slot="skill-bookmarklets-settings"]')!
    expect(bookmarkletSettings.textContent).toBe('Manage saved bookmarklets')
    expect(bookmarkletSettings.getAttribute('href')).toBe('/p/boot/settings/bookmarklets')

    const link = document.querySelector<HTMLAnchorElement>('[data-slot="skill-run-from-github"] [data-slot="bm-link"]')!
    await waitFor(() => expect(decodeURIComponent(link.getAttribute('href') ?? '')).toContain('auto=0&key=sekret'))
    expect(link.getAttribute('href')?.startsWith('javascript:')).toBe(true)
    fireEvent.click(document.querySelector('[data-slot="bookmarklet-auto"]')!)
    await waitFor(() => expect(decodeURIComponent(link.getAttribute('href') ?? '')).toContain('auto=1&key=sekret'))
    fireEvent.click(document.querySelector('[data-slot="skill-bookmarklet-copy"]')!)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(link.getAttribute('href')))
  })
})
