import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type { Skill, SkillsUpdateState, WorkflowsResponse } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { AppRoutes } from '@/routes'

/**
 * `/skills` (R6 Step 1.4): the catalog + detail against fixture payloads, the #377
 * ordering/bold rendering, the #384 refresh contract (selection and scroll survive), and the
 * bookmarklet panel's protected link generation. The pure rules themselves are pinned in
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

let requests: Array<{ method: string; url: string; body?: unknown }> = []

function serve({
  skills = SKILLS,
  refreshed = SKILLS,
  importable = [],
  workspaceUiState = {},
  skillsUpdate,
  appliedSkillsUpdate,
}: {
  skills?: Skill[]
  refreshed?: Skill[]
  importable?: { name: string; description?: string }[]
  workspaceUiState?: Record<string, unknown>
  skillsUpdate?: SkillsUpdateState
  appliedSkillsUpdate?: SkillsUpdateState
} = {}) {
  requests = []
  // The selection lives in the GLOBAL ui-state (`/api/v1/workspace/ui-state`), whose PUT answers the
  // MERGED state; the Manage panel relies on that echo to reconcile its optimistic write, so the
  // stub must merge and return rather than answer `{}`.
  let global: Record<string, unknown> = { ...workspaceUiState }
  const json = (payload: unknown) =>
    new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      requests.push({ method, url, body })
      if (url === '/api/v1/skills' && method === 'GET') return json(skills)
      if (url === '/api/v1/skills/refresh' && method === 'POST') return json(refreshed)
      // Both the fast read and the ?wait=1 convergence read hit this endpoint.
      if (url.startsWith('/api/v1/skills/importable')) return json(importable)
      if (url === '/api/v1/workflows') return json(WORKFLOWS)
      if (url === '/api/v1/launch-key') return json({ key: 'sekret' })
      if (url === '/api/v1/ui-state') return json({}) // per-repo prefs — unused by the panel
      if (url === '/api/v1/workspace/ui-state' && method === 'GET') return json(global)
      if (url === '/api/v1/workspace/ui-state' && method === 'PUT') {
        global = { ...global, ...(body as Record<string, unknown>) }
        return json(global)
      }
      if (url === '/api/v1/runs' && method === 'POST') {
        return json({ id: 'upgrade-notes-run', status: 'queued', task: 'Apply upgrade notes' })
      }
      if (url === '/api/v1/workspace/skills-update?projectId=boot') return json(skillsUpdate ?? UPDATE_CURRENT)
      if (url === '/api/v1/workspace/skills-update/check' && method === 'POST') return json(skillsUpdate ?? UPDATE_CURRENT)
      if (url === '/api/v1/workspace/skills-update/apply' && method === 'POST') {
        return json(appliedSkillsUpdate ?? skillsUpdate ?? UPDATE_CURRENT)
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

function renderAt(entry: string) {
  const client = gateSeededClient()
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <AppRoutes />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return client
}

const UPDATE_CURRENT: SkillsUpdateState = {
  status: 'current', available: false, autoUpdateEnabled: true, inherited: true,
  checkedAt: '2026-07-22T12:00:00.000Z', updatedAt: null, needsUpgradeNotes: false,
  scopes: [{ scope: 'project', status: 'current', available: false, skills: ['om-fix'], checkedAt: '2026-07-22T12:00:00.000Z', updatedAt: null }],
}

const rowNames = () =>
  [...document.querySelectorAll('[data-slot="skill-row"]')].map((el) => el.getAttribute('data-skill'))

const detail = () => document.querySelector('[data-slot="skills-detail"] [data-slot="skill-detail"]')

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

describe('the catalog list', () => {
  it('renders project-first with bold project rows and source tags (#377)', async () => {
    serve()
    renderAt('/skills')

    await waitFor(() => expect(rowNames()).toEqual(['om-fix', 'om-review', 'zebra-global']))
    const rows = [...document.querySelectorAll('[data-slot="skill-row"]')]
    expect(rows[0]?.getAttribute('data-project')).toBe('true')
    expect(rows[1]?.getAttribute('data-project')).toBe('true')
    expect(rows[2]?.hasAttribute('data-project')).toBe(false)
    // The tag says where each skill comes from.
    expect(rows[0]?.querySelector('[data-slot="skill-source"]')?.textContent).toBe('ai')
    expect(rows[2]?.querySelector('[data-slot="skill-source"]')?.textContent).toBe('global')
  })

  it('the first skill is the default selection: detail shows markdown body, path, used-by', async () => {
    serve()
    renderAt('/skills')

    await waitFor(() => expect(detail()).not.toBeNull())
    const pane = detail()!
    expect(pane.querySelector('h2')?.textContent).toBe('om-fix')
    expect(pane.querySelector('[data-slot="skill-path"]')?.textContent).toContain('.ai/skills/om-fix.md')
    // `# om-fix` became a real heading — the body renders as markdown, not a <pre> dump.
    await waitFor(() =>
      expect(pane.querySelector('[data-slot="skill-body"] h1')?.textContent).toBe('om-fix'),
    )
    expect(pane.querySelector('[data-slot="skill-used-by"]')?.textContent).toContain('fix-and-verify › Fix')
  })

  it('clicking a row selects it via the URL and swaps the detail', async () => {
    serve()
    renderAt('/skills')
    await waitFor(() => expect(rowNames()).toHaveLength(3))

    fireEvent.click(document.querySelector('[data-slot="skill-row"][data-skill="om-review"]')!)
    await waitFor(() => expect(detail()?.querySelector('h2')?.textContent).toBe('om-review'))
    expect(
      document
        .querySelector('[data-slot="skill-row"][data-skill="om-review"]')
        ?.getAttribute('aria-current'),
    ).toBe('page')
    // An unreferenced skill says so instead of showing an empty section.
    expect(detail()?.querySelector('[data-slot="skill-used-by"]')?.textContent).toContain(
      'Not referenced by any workflow yet',
    )
  })

  it('the filter narrows the rows but never hides the pinned bookmarklet entry', async () => {
    serve()
    renderAt('/skills')
    await waitFor(() => expect(rowNames()).toHaveLength(3))

    fireEvent.change(document.querySelector('[data-slot="skills-filter"]')!, {
      target: { value: 'review' },
    })
    expect(rowNames()).toEqual(['om-review'])
    expect(document.querySelector('[data-slot="bookmarklets-row"]')).not.toBeNull()
  })

  it('an empty catalog explains where skills come from, and the panel is the fallback surface', async () => {
    serve({ skills: [] })
    renderAt('/skills')

    // #374: the hint must mention every project discovery dir, not just `.ai/skills/`.
    await waitFor(() => {
      const text = document.querySelector('[data-slot="skill-rows"]')?.textContent ?? ''
      expect(text).toContain('.ai/skills/')
      expect(text).toContain('.ai/cezar/skills/')
      expect(text).toContain('.agents/skills/')
    })
    // No skills → the bookmarklet panel is the default detail (legacy fallback rule).
    await waitFor(() => expect(document.querySelector('[data-slot="bookmarklet-panel"]')).not.toBeNull())
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

  it('a refresh that drops the selected skill falls back to the first skill, never crashes', async () => {
    serve({ refreshed: SKILLS.filter((s) => s.name !== 'om-review') })
    renderAt('/skills?skill=om-review')
    await waitFor(() => expect(detail()?.querySelector('h2')?.textContent).toBe('om-review'))

    fireEvent.click(document.querySelector('[data-slot="skills-refresh"]')!)
    await waitFor(() => expect(detail()?.querySelector('h2')?.textContent).toBe('om-fix'))
  })
})

describe('the Manage skills panel (opt-out OM skills)', () => {
  const IMPORTABLE = [
    { name: 'pr-create', description: 'Open a PR from the current branch' },
    { name: 'code-review', description: 'Review the diff for bugs' },
  ]

  const importRows = () =>
    [...document.querySelectorAll('[data-slot="import-row"]')].map((el) => el.getAttribute('data-skill'))

  // The panel's writes carry `importedSkills`; other providers (appearance, sidebar) write the
  // SAME global ui-state on mount, so select only the writes that touch our key.
  const lastPut = () =>
    requests
      .filter(
        (r) =>
          r.method === 'PUT' &&
          r.url === '/api/v1/workspace/ui-state' &&
          (r.body as { importedSkills?: unknown })?.importedSkills !== undefined,
      )
      .at(-1)?.body as { importedSkills: string[] } | undefined

  it('renders available, updating/current actions, scope labels, and the persistent migration callout', async () => {
    serve({ importable: IMPORTABLE, skillsUpdate: {
      ...UPDATE_CURRENT, status: 'available', available: true, needsUpgradeNotes: true,
      scopes: [{ ...UPDATE_CURRENT.scopes[0]!, status: 'available', available: true }],
    } })
    renderAt('/skills?skill=__import')
    await waitFor(() => expect(document.querySelector('[data-action="skills-update-apply"]')?.textContent).toContain('Update now'))
    const card = document.querySelector('[data-slot="skills-update-card"]')!
    expect(card.textContent).toContain('Project installation · 1 tracked')
    expect(card.textContent).not.toContain('/home/')
    expect(document.querySelector('[data-slot="skills-upgrade-notes"]')?.textContent).toContain('/om-apply-upgrade-notes')
    expect(document.body.textContent).toContain('checkboxes choose what cezar shows')
  })

  it('keeps the newer apply result when a slower check response arrives afterward', async () => {
    let releaseCheck!: (value: Response) => void
    const json = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    serve({ importable: IMPORTABLE })
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/v1/workspace/skills-update/check') return new Promise<Response>((resolve) => { releaseCheck = resolve })
      if (url === '/api/v1/workspace/skills-update/apply') return json({ ...UPDATE_CURRENT, updatedAt: '2026-07-22T13:00:00.000Z', needsUpgradeNotes: true })
      if (url === '/api/v1/workspace/skills-update?projectId=boot') return json(UPDATE_CURRENT)
      if (url === '/api/v1/skills') return json(SKILLS)
      if (url.startsWith('/api/v1/skills/importable')) return json(IMPORTABLE)
      if (url === '/api/v1/workflows') return json(WORKFLOWS)
      if (url === '/api/v1/workspace/ui-state') return json({})
      return new Promise<never>(() => {})
    })
    const client = renderAt('/skills?skill=__import')
    await waitFor(() => expect(document.querySelector('[data-action="skills-update-check"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-action="skills-update-check"]')!)
    client.setQueryData(workspaceQueryKeys.skillsUpdate('boot'), { ...UPDATE_CURRENT, status: 'available', available: true, scopes: [{ ...UPDATE_CURRENT.scopes[0]!, status: 'available', available: true }] })
    await waitFor(() => expect(document.querySelector('[data-action="skills-update-apply"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-action="skills-update-apply"]')!)
    await waitFor(() => expect(document.querySelector('[data-slot="skills-upgrade-notes"]')).not.toBeNull())
    await act(async () => releaseCheck(json(UPDATE_CURRENT)))
    expect(client.getQueryData<SkillsUpdateState>(workspaceQueryKeys.skillsUpdate('boot'))?.needsUpgradeNotes).toBe(true)
  })

  it('offers to start the upgrade-notes skill after a successful update', async () => {
    serve({
      importable: IMPORTABLE,
      skillsUpdate: {
        ...UPDATE_CURRENT,
        status: 'available',
        available: true,
        scopes: [{ ...UPDATE_CURRENT.scopes[0]!, status: 'available', available: true }],
      },
      appliedSkillsUpdate: {
        ...UPDATE_CURRENT,
        updatedAt: '2026-07-23T16:00:00.000Z',
        needsUpgradeNotes: true,
      },
    })
    renderAt('/skills?skill=__import')

    await waitFor(() => expect(document.querySelector('[data-action="skills-update-apply"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-action="skills-update-apply"]')!)
    await waitFor(() =>
      expect(document.querySelector('[data-slot="skills-upgrade-notes-dialog"]')?.textContent).toContain(
        'Apply the upgrade notes now?',
      ),
    )

    fireEvent.click(Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Yes, start session')!)
    await waitFor(() =>
      expect(
        requests.find((request) => request.method === 'POST' && request.url === '/api/v1/runs')?.body,
      ).toMatchObject({
        steps: [
          {
            skill: 'om-apply-upgrade-notes',
            prompt: '{{task}}',
          },
        ],
      }),
    )
  })

  it('lets the user decline the upgrade-notes session', async () => {
    serve({
      importable: IMPORTABLE,
      skillsUpdate: {
        ...UPDATE_CURRENT,
        status: 'available',
        available: true,
        scopes: [{ ...UPDATE_CURRENT.scopes[0]!, status: 'available', available: true }],
      },
      appliedSkillsUpdate: {
        ...UPDATE_CURRENT,
        updatedAt: '2026-07-23T16:00:00.000Z',
        needsUpgradeNotes: true,
      },
    })
    renderAt('/skills?skill=__import')

    await waitFor(() => expect(document.querySelector('[data-action="skills-update-apply"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-action="skills-update-apply"]')!)
    await waitFor(() => expect(document.querySelector('[data-slot="skills-upgrade-notes-dialog"]')).not.toBeNull())
    fireEvent.click(Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'No')!)

    await waitFor(() => expect(document.querySelector('[data-slot="skills-upgrade-notes-dialog"]')).toBeNull())
    expect(requests.some((request) => request.method === 'POST' && request.url === '/api/v1/runs')).toBe(false)
  })

  it('does not claim a failed retry succeeded when its update timestamp is stale', async () => {
    const previousUpdatedAt = '2026-07-23T16:00:00.000Z'
    serve({
      importable: IMPORTABLE,
      skillsUpdate: {
        ...UPDATE_CURRENT,
        status: 'error',
        updatedAt: previousUpdatedAt,
        needsUpgradeNotes: true,
        scopes: [{ ...UPDATE_CURRENT.scopes[0]!, status: 'error', available: true }],
      },
      appliedSkillsUpdate: {
        ...UPDATE_CURRENT,
        status: 'error',
        updatedAt: previousUpdatedAt,
        needsUpgradeNotes: true,
        scopes: [{ ...UPDATE_CURRENT.scopes[0]!, status: 'error', available: true }],
      },
    })
    renderAt('/skills?skill=__import')

    await waitFor(() => expect(document.querySelector('[data-action="skills-update-apply"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-action="skills-update-apply"]')!)

    await waitFor(() =>
      expect(requests.some((request) => request.url === '/api/v1/workspace/skills-update/apply')).toBe(true),
    )
    expect(document.querySelector('[data-slot="skills-upgrade-notes-dialog"]')).toBeNull()
  })

  it('shows the pinned "Manage skills" entry only when a vendor repo has default skills', async () => {
    serve({ importable: IMPORTABLE })
    renderAt('/skills')
    await waitFor(() => expect(document.querySelector('[data-slot="import-skills-row"]')).not.toBeNull())
  })

  it('hides the entry when there are no default skills (repo configured its own skillsRepos)', async () => {
    serve({ importable: [] })
    renderAt('/skills')
    await waitFor(() => expect(rowNames()).toHaveLength(3))
    expect(document.querySelector('[data-slot="import-skills-row"]')).toBeNull()
  })

  it('enables every default skill by default (opt-out), and unchecking one curates it away', async () => {
    serve({ importable: IMPORTABLE }) // uiState {} → not curated → all on
    renderAt('/skills?skill=__import')
    await waitFor(() => expect(importRows()).toEqual(['pr-create', 'code-review']))

    const toggleOf = (name: string) =>
      document.querySelector<HTMLInputElement>(
        `[data-slot="import-row"][data-skill="${name}"] [data-slot="import-toggle"]`,
      )!
    // Opt-out default: nothing is curated yet, so both start checked.
    expect(toggleOf('pr-create').checked).toBe(true)
    expect(toggleOf('code-review').checked).toBe(true)

    fireEvent.click(toggleOf('pr-create'))

    // The first uncheck expands "all on" into an explicit remaining set — the other skill only.
    await waitFor(() => expect(lastPut()?.importedSkills).toEqual(['code-review']))
    // …and the row reflects it (server echo reconciled, not reverted).
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="import-row"][data-skill="pr-create"]')?.getAttribute('data-imported'),
      ).toBeNull(),
    )
    expect(
      document.querySelector('[data-slot="import-row"][data-skill="code-review"]')?.getAttribute('data-imported'),
    ).toBe('true')
  })

  it('honors an existing curated selection, and re-checking a skill adds it back', async () => {
    serve({ importable: IMPORTABLE, workspaceUiState: { importedSkills: ['code-review'] } })
    renderAt('/skills?skill=__import')
    // Curated present → only code-review is on; pr-create is off.
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="import-row"][data-skill="code-review"]')?.getAttribute('data-imported'),
      ).toBe('true'),
    )
    expect(
      document.querySelector('[data-slot="import-row"][data-skill="pr-create"]')?.getAttribute('data-imported'),
    ).toBeNull()

    fireEvent.click(
      document.querySelector('[data-slot="import-row"][data-skill="pr-create"] [data-slot="import-toggle"]')!,
    )
    await waitFor(() => expect(lastPut()?.importedSkills.sort()).toEqual(['code-review', 'pr-create']))
  })

  it('"Remove all" clears the default catalog, then "Enable all" restores it', async () => {
    serve({ importable: IMPORTABLE }) // default: all on
    renderAt('/skills?skill=__import')
    await waitFor(() => expect(importRows()).toHaveLength(2))

    const button = () => document.querySelector('[data-slot="import-all"]')!
    // Opt-out default (all on) → the action is Remove all.
    expect(button().textContent).toContain('Remove all')
    fireEvent.click(button())
    await waitFor(() => expect(lastPut()?.importedSkills).toEqual([]))

    // Everything off → the action flips to Enable all → clicking restores the full set.
    await waitFor(() => expect(button().textContent).toContain('Enable all'))
    fireEvent.click(button())
    await waitFor(() => expect(lastPut()?.importedSkills.sort()).toEqual(['code-review', 'pr-create']))
  })

  // The lost-update regression (review "Major"): two toggles fired before the first PUT resolves
  // must both survive. The write chain serializes the PUTs (the second is derived from the first
  // and sent only after it lands), and only the newest response reconciles the cache — so a slow
  // or out-of-order response can neither lose nor resurrect a selection.
  it('serializes overlapping toggles so both persist, even with a slow/reordered response', async () => {
    const puts: { body: { importedSkills: string[] }; release: () => void }[] = []
    // Start already curated-to-empty so both rows begin unchecked and the two clicks ADD skills
    // (the opt-out default would start them checked, which is exercised elsewhere).
    let state: Record<string, unknown> = { importedSkills: [] }
    const json = (payload: unknown) =>
      new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (url === '/api/v1/skills' && method === 'GET') return json(SKILLS)
        if (url.startsWith('/api/v1/skills/importable')) return json(IMPORTABLE)
        if (url === '/api/v1/workflows') return json(WORKFLOWS)
        if (url === '/api/v1/launch-key') return json({ key: 'sekret' })
        if (url === '/api/v1/ui-state') return json({}) // per-repo prefs — unused by the panel
        if (url === '/api/v1/workspace/ui-state' && method === 'GET') return json(state)
        if (url === '/api/v1/workspace/ui-state' && method === 'PUT') {
          const body = JSON.parse(String(init!.body)) as { importedSkills: string[] }
          // Defer the response so the test controls when (and in what order) it lands.
          return new Promise<Response>((resolve) => {
            puts.push({
              body,
              release: () => {
                state = { ...state, ...body }
                resolve(json(state))
              },
            })
          })
        }
        return new Promise<never>(() => {})
      }),
    )

    renderAt('/skills?skill=__import')
    await waitFor(() => expect(importRows()).toEqual(['pr-create', 'code-review']))

    // Two quick toggles before the first PUT resolves.
    fireEvent.click(
      document.querySelector('[data-slot="import-row"][data-skill="pr-create"] [data-slot="import-toggle"]')!,
    )
    fireEvent.click(
      document.querySelector('[data-slot="import-row"][data-skill="code-review"] [data-slot="import-toggle"]')!,
    )

    // Optimistic UI: both flip immediately because the second toggle read the first from the cache.
    await waitFor(() => {
      expect(
        document.querySelector('[data-slot="import-row"][data-skill="pr-create"]')?.getAttribute('data-imported'),
      ).toBe('true')
      expect(
        document.querySelector('[data-slot="import-row"][data-skill="code-review"]')?.getAttribute('data-imported'),
      ).toBe('true')
    })

    // Serialized: only the FIRST PUT is in flight; the second waits for it.
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0]?.body.importedSkills).toEqual(['pr-create'])

    // Release the first → the chained second PUT fires, built on the first.
    await act(async () => {
      puts[0]!.release()
    })
    await waitFor(() => expect(puts).toHaveLength(2))
    expect(puts[1]?.body.importedSkills).toEqual(['pr-create', 'code-review'])

    await act(async () => {
      puts[1]!.release()
    })

    // Both selections persisted on the server, and neither toggle was lost.
    await waitFor(() => expect(state).toEqual({ importedSkills: ['pr-create', 'code-review'] }))
    expect(
      document.querySelector('[data-slot="import-row"][data-skill="pr-create"]')?.getAttribute('data-imported'),
    ).toBe('true')
    expect(
      document.querySelector('[data-slot="import-row"][data-skill="code-review"]')?.getAttribute('data-imported'),
    ).toBe('true')
  })
})

describe('the bookmarklet panel (spec 011)', () => {
  it('says it is loading rather than claiming there are no skills while the catalog is in flight', async () => {
    // The panel's empty state reads "(no skills yet …)". Rendering it against an unresolved
    // catalog would state that as fact on every cold load of the subpage — so the section
    // must gate on the pending query the way its sibling sections do.
    const json = (payload: unknown) =>
      new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/api/v1/launch-key') return json({ key: 'sekret' })
        if (url === '/api/v1/ui-state') return json({})
        return new Promise<never>(() => {}) // /api/v1/skills never settles
      }),
    )
    renderAt('/settings/bookmarklets')

    await waitFor(() =>
      expect(document.querySelector('[data-slot="bookmarklets-loading"]')).not.toBeNull(),
    )
    expect(document.querySelector('[data-slot="bookmarklet-panel"]')).toBeNull()
    expect(document.body.textContent).not.toContain('no skills yet')
  })

  it('is a first-class Settings page that generates protected links and auto-arms per-skill links only', async () => {
    serve()
    renderAt('/settings/bookmarklets')

    await waitFor(() => expect(document.querySelector('[data-slot="bookmarklet-panel"]')).not.toBeNull())
    // The key landed in the links (the panel is its one legitimate DOM use).
    await waitFor(() => {
      const generic = document.querySelector('[data-slot="bm-generic"] [data-slot="bm-link"]')
      expect(decodeURIComponent(generic?.getAttribute('href') ?? '')).toContain('auto=0&key=sekret&ref=')
    })
    const links = [...document.querySelectorAll('[data-slot="bm-list"] [data-slot="bm-link"]')]
    expect(links).toHaveLength(3) // one per skill, project-first like the catalog
    expect(links[0]?.textContent).toContain('/om-fix')
    for (const link of links) {
      expect(link.getAttribute('href')?.startsWith('javascript:')).toBe(true)
      expect(decodeURIComponent(link.getAttribute('href') ?? '')).toContain('auto=0&key=sekret')
    }

    // Auto-submit arms the per-skill links; the generic launcher stays prefill-only.
    fireEvent.click(document.querySelector('[data-slot="bm-auto"]')!)
    await waitFor(() => {
      const first = document.querySelector('[data-slot="bm-list"] [data-slot="bm-link"]')
      expect(decodeURIComponent(first?.getAttribute('href') ?? '')).toContain('auto=1&key=sekret')
    })
    const generic = document.querySelector('[data-slot="bm-generic"] [data-slot="bm-link"]')
    expect(decodeURIComponent(generic?.getAttribute('href') ?? '')).toContain('auto=0&key=sekret')
  })

  it('filters the per-skill rows and copies a link to the clipboard', async () => {
    serve()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderAt('/skills?skill=__bm')
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="bm-list"] [data-slot="bm-row"]')).toHaveLength(3),
    )

    fireEvent.change(document.querySelector('[data-slot="bm-filter"]')!, { target: { value: 'zebra' } })
    const rows = [...document.querySelectorAll('[data-slot="bm-list"] [data-slot="bm-row"]')]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('/zebra-global')

    fireEvent.click(rows[0]!.querySelector('[data-slot="bm-copy"]')!)
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(String(writeText.mock.calls[0]?.[0])).toMatch(/^javascript:/)
  })

  it('a clicked drag-source link never navigates — it only explains the gesture', async () => {
    serve()
    renderAt('/skills?skill=__bm')
    await waitFor(() => expect(document.querySelector('[data-slot="bm-generic"] [data-slot="bm-link"]')).not.toBeNull())

    fireEvent.click(document.querySelector('[data-slot="bm-generic"] [data-slot="bm-link"]')!)
    await waitFor(() =>
      expect(document.querySelector('[data-slot="toaster"]')?.textContent).toContain(
        'Drag me to your bookmarks bar',
      ),
    )
  })
})
