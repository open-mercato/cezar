import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type {
  HealthResponse,
  ProjectListEntry,
  RunIndexEntry,
  RunRecord,
  Skill,
} from '@open-mercato/cezar-api-client'
import {
  CommandPalette,
  mergeTasks,
  orderProjects,
  orderRuns,
  paletteScore,
} from '@/components/command-palette'
import { orderSkills } from '@/lib/skills'
import { ThemeProvider } from '@/components/theme-provider'
import { THEME_STORAGE_KEY, type Theme } from '@/lib/theme'

afterEach(cleanup)

const fetchMock = vi.fn<typeof fetch>()

beforeAll(() => {
  // cmdk scrolls the selected item into view; jsdom has no scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  localStorage.clear()
  document.documentElement.className = ''
  vi.stubGlobal('fetch', fetchMock)
  // jsdom ships no matchMedia; the ThemeProvider needs one to resolve `system`.
  vi.stubGlobal(
    'matchMedia',
    () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  )
  // cmdk sizes its list with a ResizeObserver; jsdom has none and never resizes anything.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

function run(overrides: Partial<RunRecord> & { id: string; title: string }): RunRecord {
  return {
    workflow: 'build',
    task: 'do the thing',
    status: 'running',
    createdAt: '2026-07-14T10:00:00Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...overrides,
  }
}

function skill(overrides: Partial<Skill> & { name: string; source: Skill['source'] }): Skill {
  return { body: '', path: `/skills/${overrides.source}/${overrides.name}.md`, ...overrides }
}

function indexed(
  overrides: Partial<RunIndexEntry> & { id: string; projectId: string; title: string },
): RunIndexEntry {
  return {
    status: 'done',
    createdAt: '2026-07-14T10:00:00Z',
    archived: false,
    workflow: 'build',
    ...overrides,
  }
}

function project(overrides: Partial<ProjectListEntry> & { id: string }): ProjectListEntry {
  return {
    name: overrides.id,
    root: `/repos/${overrides.id}`,
    addedAt: '2026-07-01T10:00:00Z',
    lastOpenedAt: '2026-07-01T10:00:00Z',
    source: 'local',
    status: 'ok',
    ...overrides,
  }
}

/** Health with/without a working forge — what gates the Views group's GitHub row (R6 1.1). */
function health(forgeAvailable: boolean, automations = false): HealthResponse {
  return {
    version: '0.0.0-test',
    projects: [],
    bootProject: 'default',
    repoRoot: '/repo',
    repo: { root: '/repo', branch: 'main' },
    checks: [],
    defaultRunner: 'claude',
    forge: forgeAvailable ? { kind: 'github', available: true } : null,
    capabilities: { localHandoff: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: true, singleProject: false, automations },
  }
}

function serve(routes: Record<string, unknown>): void {
  fetchMock.mockImplementation(async (input) => {
    const path = String(input)
    if (!(path in routes)) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    return new Response(JSON.stringify(routes[path]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
}

/** Where did the palette send us? Rendered as a sibling so navigation is observable. */
function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname + location.search}</output>
}

function renderPalette({
  runs = [] as RunRecord[],
  skills = [] as Skill[],
  projects = [] as ProjectListEntry[],
  indexed = [] as RunIndexEntry[],
  truncated = [] as string[],
  theme,
  forge = true,
  automations = false,
  uiState = {} as Record<string, unknown>,
  entry = '/',
}: {
  runs?: RunRecord[]
  skills?: Skill[]
  projects?: ProjectListEntry[]
  /** What `GET /workspace/runs-index` answers — every project's tasks, including the active one's. */
  indexed?: RunIndexEntry[]
  truncated?: string[]
  theme?: Theme
  forge?: boolean
  /** `capabilities.automations` (#801) — off by default, exactly as a default server reports. */
  automations?: boolean
  uiState?: Record<string, unknown>
  /** The URL to mount at. `/p/<id>/…` is what gives the palette an ACTIVE project. */
  entry?: string
} = {}) {
  if (theme) localStorage.setItem(THEME_STORAGE_KEY, theme)
  serve({
    '/api/v1/runs': runs,
    '/api/v1/skills': skills,
    '/api/v1/health': health(forge, automations),
    '/api/v1/ui-state': uiState,
    '/api/v1/projects': { projects, bootProject: projects[0]?.id ?? 'default', projectsDir: '/repos' },
    '/api/v1/workspace/runs-index': { runs: indexed, perProjectLimit: 200, truncated },
  })
  render(
    <QueryClientProvider client={createQueryClient()}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[entry]}>
          <CommandPalette />
          <LocationProbe />
          <input data-testid="outside-input" aria-label="outside" />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  )
}

const dialog = () => screen.queryByRole('dialog')
const location = () => screen.getByTestId('location').textContent

function openWith(init: { metaKey?: boolean; ctrlKey?: boolean }) {
  fireEvent.keyDown(window, { key: 'k', ...init })
}

describe('opening and closing', () => {
  it.each([
    { name: '⌘K', init: { metaKey: true } },
    { name: 'Ctrl+K', init: { ctrlKey: true } },
  ])('opens on $name', async ({ init }) => {
    renderPalette()
    expect(dialog()).toBeNull()

    openWith(init)

    expect(dialog()).not.toBeNull()
    expect(await screen.findByPlaceholderText(/Search projects, tasks/)).toBeTruthy()
  })

  it('does not open while the user is typing in an input', () => {
    renderPalette()

    fireEvent.keyDown(screen.getByTestId('outside-input'), { key: 'k', metaKey: true })

    expect(dialog()).toBeNull()
  })

  it('closes on Escape', async () => {
    renderPalette()
    openWith({ metaKey: true })
    expect(dialog()).not.toBeNull()

    fireEvent.keyDown(dialog() as HTMLElement, { key: 'Escape' })

    await waitFor(() => expect(dialog()).toBeNull())
  })

  it('⌘K toggles: pressed again — even from the palette’s own input — it closes', async () => {
    renderPalette()
    openWith({ metaKey: true })
    const input = await screen.findByPlaceholderText(/Search projects, tasks/)

    fireEvent.keyDown(input, { key: 'k', metaKey: true })

    await waitFor(() => expect(dialog()).toBeNull())
  })

  it('fetches nothing until first opened — the palette is lazy', async () => {
    renderPalette()
    expect(fetchMock).not.toHaveBeenCalled()

    openWith({ metaKey: true })

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const paths = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(paths).toContain('/api/v1/skills')
  })
})

describe('Views group', () => {
  it('leads with New task and its C hint, then the 8 nav destinations', async () => {
    renderPalette({ automations: true })
    openWith({ metaKey: true })
    await screen.findByRole('dialog')

    // The GitHub row waits on the health answer (forge gate) — settle before asserting.
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="palette-view"]')).toHaveLength(9),
    )
    const views = [...document.querySelectorAll('[data-slot="palette-view"]')]
    // New task FIRST — an empty query pre-selects it, so ⌘K then Enter starts a task.
    expect(views.map((view) => view.getAttribute('data-nav-to'))).toEqual([
      '/new', '/', '/inbox', '/git', '/github', '/automations', '/skills', '/workflows', '/settings',
    ])
    expect(views[0]?.textContent).toContain('New task')
    // The chip advertises `c` — ⌘N is browser-reserved and only fires in the desktop shell.
    expect(views[0]?.textContent).toContain('C')
  })

  // #801: the palette's Views group renders through the same `visibleNavItems` the sidebar does,
  // so the two can never disagree about whether Automations exists.
  it('omits Automations while the capability is off — the default', async () => {
    renderPalette()
    openWith({ metaKey: true })
    await screen.findByRole('dialog')

    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="palette-view"]')).toHaveLength(8),
    )
    const views = [...document.querySelectorAll('[data-slot="palette-view"]')]
    expect(views.map((view) => view.getAttribute('data-nav-to'))).toEqual([
      '/new', '/', '/inbox', '/git', '/github', '/skills', '/workflows', '/settings',
    ])
  })

  it('offers exactly ONE New task row — not one per group', async () => {
    renderPalette({ automations: true })
    openWith({ metaKey: true })
    await screen.findByRole('dialog')
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="palette-view"]')).toHaveLength(9),
    )

    const newTaskRows = [...document.querySelectorAll('[data-nav-to="/new"]')]
    expect(newTaskRows).toHaveLength(1)
    expect(document.querySelector('[data-action="new-task"]')).toBeNull()
  })

  it('is the row Enter picks with an empty query', async () => {
    renderPalette()
    openWith({ metaKey: true })
    await screen.findByRole('dialog')
    await waitFor(() =>
      expect(document.querySelector('[cmdk-item][aria-selected="true"]')).not.toBeNull(),
    )

    expect(
      document.querySelector('[cmdk-item][aria-selected="true"]')?.getAttribute('data-nav-to'),
    ).toBe('/new')
  })

  // R6 Step 1.1: the palette must not offer a GitHub view the sidebar honestly hides.
  it('drops the GitHub view when health reports no forge', async () => {
    renderPalette({ forge: false })
    openWith({ metaKey: true })
    await screen.findByRole('dialog')

    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="palette-view"]')).toHaveLength(7),
    )
    const targets = [...document.querySelectorAll('[data-slot="palette-view"]')].map((view) =>
      view.getAttribute('data-nav-to'),
    )
    expect(targets).not.toContain('/github')
    expect(targets).not.toContain('/automations')
  })

  it('navigates to the selected view and closes', async () => {
    renderPalette()
    openWith({ metaKey: true })
    await screen.findByRole('dialog')

    fireEvent.click(document.querySelector('[data-nav-to="/workflows"]') as HTMLElement)

    expect(location()).toBe('/workflows')
    await waitFor(() => expect(dialog()).toBeNull())
  })

  it('⌘N client-navigates to the React /new composer (R4 Step 1.1)', () => {
    renderPalette()

    fireEvent.keyDown(window, { key: 'n', metaKey: true })

    expect(location()).toBe('/new')
    expect(dialog()).toBeNull()
  })

  it('bare `c` client-navigates to /new — the browser-usable accelerator', () => {
    renderPalette()

    fireEvent.keyDown(window, { key: 'c' })

    expect(location()).toBe('/new')
    expect(dialog()).toBeNull()
  })

  it('`c` is inert while typing in a field', () => {
    renderPalette()
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()

    fireEvent.keyDown(input, { key: 'c' })

    expect(location()).toBe('/')
    input.remove()
  })
})

describe('Projects group', () => {
  const REGISTRY = [
    project({ id: 'cezar', name: 'cezar', branch: 'main', lastOpenedAt: '2026-07-14T00:00:00Z' }),
    project({ id: 'shop', name: 'shop', branch: 'develop', lastOpenedAt: '2026-07-12T00:00:00Z' }),
    project({ id: 'docs', name: 'docs', lastOpenedAt: '2026-07-13T00:00:00Z' }),
  ]

  it('lists the registry recency-first with the active project last, and switches project', async () => {
    renderPalette({ projects: REGISTRY, entry: '/p/cezar/' })
    openWith({ metaKey: true })
    await screen.findByText('shop')

    const rows = [...document.querySelectorAll('[data-slot="palette-project"]')]
    expect(rows.map((row) => row.getAttribute('data-project-id'))).toEqual(['docs', 'shop', 'cezar'])
    // The branch is the disambiguator when two entries share a name; absent entries show none.
    expect(rows[1]?.textContent).toContain('develop')

    fireEvent.click(rows[1] as HTMLElement)

    // The tasks pane of the OTHER project — an explicit cross-project target, not the active scope.
    expect(location()).toBe('/p/shop/')
    await waitFor(() => expect(dialog()).toBeNull())
  })

  it('filters by name and by root, so two checkouts of one repo stay tellable apart', async () => {
    renderPalette({
      projects: [
        project({ id: 'cezar', name: 'cezar', root: '/repos/cezar' }),
        project({ id: 'cezar-fork', name: 'cezar', root: '/work/fork/cezar' }),
      ],
      entry: '/p/cezar/',
    })
    openWith({ metaKey: true })
    await screen.findByRole('dialog')
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="palette-project"]')).toHaveLength(2),
    )

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'fork' } })

    const rows = [...document.querySelectorAll('[data-slot="palette-project"]')]
    expect(rows.map((row) => row.getAttribute('data-project-id'))).toEqual(['cezar-fork'])
  })

  it('renders no Projects group in a single-project workspace — there is nowhere to switch to', async () => {
    renderPalette({ projects: [project({ id: 'cezar' })], entry: '/p/cezar/' })
    openWith({ metaKey: true })
    await screen.findByRole('dialog')

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(document.querySelector('[data-slot="palette-project"]')).toBeNull()
  })

  it('lists a missing folder but refuses to navigate into it', async () => {
    renderPalette({
      projects: [
        project({ id: 'cezar' }),
        project({ id: 'gone', name: 'gone', status: 'missing' }),
      ],
      entry: '/p/cezar/',
    })
    openWith({ metaKey: true })
    const row = await screen.findByText('folder not found')
    const item = row.closest('[data-slot="palette-project"]') as HTMLElement
    expect(item.getAttribute('data-project-id')).toBe('gone')

    fireEvent.click(item)

    expect(location()).toBe('/p/cezar/')
    expect(dialog()).not.toBeNull()
  })
})

describe('Tasks group', () => {
  it('lists runs newest first with their attention dot, and navigates to the run', async () => {
    renderPalette({
      // A registry with a real boot slug, as the server always answers — the run target is
      // spelled `/p/<boot>/…` rather than leaning on the legacy flat redirect to land.
      projects: [project({ id: 'cezar' })],
      runs: [
        run({ id: 'r-old', title: 'Old fix', status: 'done', createdAt: '2026-07-13T10:00:00Z' }),
        run({ id: 'r-new', title: 'Fix the flaky test', status: 'waiting', createdAt: '2026-07-14T10:00:00Z' }),
      ],
    })
    openWith({ metaKey: true })
    await screen.findByText('Fix the flaky test')

    const tasks = [...document.querySelectorAll('[data-slot="palette-task"]')]
    expect(tasks.map((task) => task.getAttribute('data-run-id'))).toEqual(['r-new', 'r-old'])
    // The dot is deriveAttention's, not a re-derivation: waiting → pending, done → success.
    expect(tasks[0]?.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('pending')
    expect(tasks[1]?.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('success')

    fireEvent.click(tasks[0] as HTMLElement)

    expect(location()).toBe('/p/cezar/tasks/r-new')
    await waitFor(() => expect(dialog()).toBeNull())
  })

  it('shows and filters by the auto-summary title, not the raw title it replaced', async () => {
    renderPalette({
      runs: [
        run({ id: 'r-sum', title: 'fix the login bug plz', titleSummary: 'Catch AuthError in the handler' }),
      ],
    })
    openWith({ metaKey: true })
    // The rendered name reads through runTitle, like every other surface.
    await screen.findByText('Catch AuthError in the handler')
    expect(screen.queryByText('fix the login bug plz')).toBeNull()

    // And the filter matches what is on screen — not the hidden raw title.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'AuthError' } })
    expect(document.querySelector('[data-slot="palette-task"]')).not.toBeNull()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'plz' } })
    expect(document.querySelector('[data-slot="palette-task"]')).toBeNull()
  })

  it('renders no Tasks group when there are no runs', async () => {
    renderPalette()
    openWith({ metaKey: true })
    await screen.findByRole('dialog')

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(document.querySelector('[data-slot="palette-task"]')).toBeNull()
  })
})

describe('Recently finished group', () => {
  /** A finished run nobody has opened since it finished — what `isUnread` calls unread. */
  const done = (id: string, title: string, finishedAt: string, seenAt?: string) =>
    run({ id, title, status: 'done', createdAt: '2026-07-10T10:00:00Z', finishedAt, seenAt })

  it('sits directly under New task, newest-finished first, and lists nothing else', async () => {
    renderPalette({
      runs: [
        done('r-old', 'Landed first', '2026-07-14T10:00:00Z'),
        done('r-new', 'Landed second', '2026-07-15T10:00:00Z'),
        // Already seen since it finished → read, so it belongs under Tasks.
        done('r-seen', 'Already read', '2026-07-13T10:00:00Z', '2026-07-13T11:00:00Z'),
        run({ id: 'r-live', title: 'Still running', status: 'running' }),
      ],
    })
    openWith({ metaKey: true })
    await screen.findByText('Landed second')

    const groups = [...document.querySelectorAll('[cmdk-group-heading]')].map((h) => h.textContent)
    expect(groups[0]).toBe('Recently finished')

    const unread = [
      ...(document.querySelector('[cmdk-group][data-value="Recently finished"]')?.querySelectorAll(
        '[data-slot="palette-task"]',
      ) ?? []),
    ]
    expect(unread.map((row) => row.getAttribute('data-run-id'))).toEqual(['r-new', 'r-old'])
  })

  it('never lists a task twice — an unread task is absent from Tasks', async () => {
    renderPalette({
      runs: [
        done('r-unread', 'Landed', '2026-07-15T10:00:00Z'),
        run({ id: 'r-live', title: 'Still running', status: 'running' }),
      ],
    })
    openWith({ metaKey: true })
    await screen.findByText('Landed')

    const all = [...document.querySelectorAll('[data-slot="palette-task"]')]
    expect(all.map((row) => row.getAttribute('data-run-id'))).toEqual(['r-unread', 'r-live'])
  })

  it('reaches across projects — another project’s unread task leads too', async () => {
    renderPalette({
      projects: [project({ id: 'cezar' }), project({ id: 'shop' })],
      entry: '/p/cezar/',
      runs: [run({ id: 'r-live', title: 'Still running', status: 'running' })],
      indexed: [
        indexed({
          id: 'r-shop',
          projectId: 'shop',
          title: 'Checkout crash',
          status: 'failed',
          finishedAt: '2026-07-15T10:00:00Z',
        }),
      ],
    })
    openWith({ metaKey: true })
    await screen.findByText('Checkout crash')

    const unread = document.querySelector('[cmdk-group][data-value="Recently finished"]')
    expect(unread?.querySelector('[data-slot="palette-task"]')?.getAttribute('data-run-id')).toBe(
      'r-shop',
    )
  })

  it('renders no Unread group when nothing finished unseen', async () => {
    renderPalette({ runs: [run({ id: 'r-live', title: 'Still running', status: 'running' })] })
    openWith({ metaKey: true })
    await screen.findByText('Still running')

    const groups = [...document.querySelectorAll('[cmdk-group-heading]')].map((h) => h.textContent)
    expect(groups).not.toContain('Recently finished')
  })

  it('leaves a usage-limit resume out, cross-project too — it has an appointment, not an outcome', async () => {
    renderPalette({
      projects: [project({ id: 'cezar' }), project({ id: 'shop' })],
      entry: '/p/cezar/',
      runs: [],
      indexed: [
        // `failed` with a resume booked (#auto-resume). `isUnread` and `deriveAttention` both
        // read `autoResumeAt`, so the index has to carry it or this row would claim a red dot
        // and a place in Recently finished for work that is simply waiting.
        indexed({
          id: 'r-parked',
          projectId: 'shop',
          title: 'Waiting out the limit',
          status: 'failed',
          finishedAt: '2026-07-15T10:00:00Z',
          autoResumeAt: '2026-07-15T14:00:00Z',
        }),
      ],
    })
    openWith({ metaKey: true })
    await screen.findByText('Waiting out the limit')

    const groups = [...document.querySelectorAll('[cmdk-group-heading]')].map((h) => h.textContent)
    expect(groups).not.toContain('Recently finished')
    // And it wears the parked dot the rest of the cockpit gives it, not the failure red.
    const row = document.querySelector('[data-run-id="r-parked"]')
    expect(row?.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('pending')
  })

  it('leaves archived runs out — archiving is a stronger "done with this" than reading', async () => {
    renderPalette({
      runs: [
        run({
          id: 'r-filed',
          title: 'Filed away',
          status: 'done',
          finishedAt: '2026-07-15T10:00:00Z',
          archived: true,
        }),
      ],
    })
    openWith({ metaKey: true })
    await screen.findByText('Filed away')

    const groups = [...document.querySelectorAll('[cmdk-group-heading]')].map((h) => h.textContent)
    expect(groups).not.toContain('Recently finished')
  })
})

describe('ranking', () => {
  it('scores a real substring hit above a uuid accident — the task-number case', () => {
    // The exact task, and a bystander whose run id merely contains 7…6…7 in order.
    const wanted = paletteScore('task 767: fix the flaky test 9c1d-4f2a', '767')
    const uuidNoise = paletteScore('task something else a7b6c7d2-1111-2222', '767')
    expect(wanted).toBeGreaterThan(uuidNoise)
  })

  it('rejects a subsequence that is not a substring — cmdk’s default would accept it', () => {
    // `7`,`6`,`7` all appear in order, with gaps. That is the match this scorer refuses.
    expect(paletteScore('task alpha 7 beta 6 gamma 7', '767')).toBe(0)
  })

  it('requires every token, so two words narrow instead of widening', () => {
    expect(paletteScore('task fix the auth bug', 'auth bug')).toBeGreaterThan(0)
    expect(paletteScore('task fix the auth bug', 'auth checkout')).toBe(0)
  })

  it('prefers a word-boundary hit over one buried mid-word', () => {
    expect(paletteScore('task 767 report', '767')).toBeGreaterThan(
      paletteScore('task a767b report', '767'),
    )
  })

  it('prefers an earlier hit, so a title match outranks an id match', () => {
    expect(paletteScore('task deploy the thing 0000-1111', 'deploy')).toBeGreaterThan(
      paletteScore('task something 0000-deploy', 'deploy'),
    )
  })

  it('matches keywords too — the project name on a task row', () => {
    expect(paletteScore('task checkout crash abc', 'shop', ['shop'])).toBeGreaterThan(0)
  })

  it('keeps everything with an empty query', () => {
    expect(paletteScore('task anything', '')).toBe(1)
    expect(paletteScore('task anything', '   ')).toBe(1)
  })
})

describe('searching', () => {
  const finished = (id: string, title: string) =>
    run({ id, title, status: 'done', finishedAt: '2026-07-15T10:00:00Z' })

  it('drops the Recently finished section, so near-misses cannot sit above the exact match', async () => {
    renderPalette({
      runs: [
        finished('r-767', 'Fix 767 the flaky test'),
        finished('r-other', 'Unrelated work'),
      ],
    })
    openWith({ metaKey: true })
    await screen.findByText('Fix 767 the flaky test')
    // Default view: the section is there.
    expect(
      [...document.querySelectorAll('[cmdk-group-heading]')].map((h) => h.textContent),
    ).toContain('Recently finished')

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '767' } })

    const headings = [...document.querySelectorAll('[cmdk-group-heading]')].map((h) => h.textContent)
    expect(headings).not.toContain('Recently finished')
    const tasks = [...document.querySelectorAll('[data-slot="palette-task"]')]
    expect(tasks.map((task) => task.getAttribute('data-run-id'))).toEqual(['r-767'])
  })

  it('puts the matching task first — ahead of New task and the views', async () => {
    renderPalette({ runs: [finished('r-767', 'Fix 767 the flaky test')] })
    openWith({ metaKey: true })
    await screen.findByText('Fix 767 the flaky test')

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '767' } })

    const first = document.querySelector('[cmdk-item]')
    expect(first?.getAttribute('data-run-id')).toBe('r-767')
    // And it is what Enter would take.
    expect(document.querySelector('[cmdk-item][aria-selected="true"]')?.getAttribute('data-run-id')).toBe(
      'r-767',
    )
  })

  it('still lists a task once when its section is folded away', async () => {
    renderPalette({ runs: [finished('r-767', 'Fix 767 the flaky test')] })
    openWith({ metaKey: true })
    await screen.findByText('Fix 767 the flaky test')

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'flaky' } })

    expect(document.querySelectorAll('[data-run-id="r-767"]')).toHaveLength(1)
  })
})

describe('Tasks across projects', () => {
  const REGISTRY = [
    project({ id: 'cezar', name: 'cezar' }),
    project({ id: 'shop', name: 'shop' }),
  ]

  it('lists other projects’ tasks after the active one’s, labelled, and opens them in place', async () => {
    renderPalette({
      projects: REGISTRY,
      entry: '/p/cezar/',
      runs: [run({ id: 'r-mine', title: 'Fix the flaky test', createdAt: '2026-07-10T10:00:00Z' })],
      indexed: [
        // Newer than the active project's task and still listed second: locality wins the
        // unfiltered order, exactly like the Projects group.
        indexed({ id: 'r-shop', projectId: 'shop', title: 'Checkout crash', createdAt: '2026-07-15T10:00:00Z' }),
      ],
    })
    openWith({ metaKey: true })
    await screen.findByText('Checkout crash')

    const tasks = [...document.querySelectorAll('[data-slot="palette-task"]')]
    expect(tasks.map((task) => task.getAttribute('data-run-id'))).toEqual(['r-mine', 'r-shop'])
    // Every row says which project it is in — the whole point of a cross-project list.
    const labels = tasks.map((task) =>
      task.querySelector('[data-slot="palette-task-project"]')?.textContent,
    )
    expect(labels).toEqual(['cezar', 'shop'])

    fireEvent.click(tasks[1] as HTMLElement)

    expect(location()).toBe('/p/shop/tasks/r-shop')
    await waitFor(() => expect(dialog()).toBeNull())
  })

  it('filters by project name, so "shop" narrows to shop’s tasks', async () => {
    renderPalette({
      projects: REGISTRY,
      entry: '/p/cezar/',
      runs: [run({ id: 'r-mine', title: 'Fix the flaky test' })],
      indexed: [indexed({ id: 'r-shop', projectId: 'shop', title: 'Checkout crash' })],
    })
    openWith({ metaKey: true })
    await screen.findByText('Checkout crash')

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'shop' } })

    const tasks = [...document.querySelectorAll('[data-slot="palette-task"]')]
    expect(tasks.map((task) => task.getAttribute('data-run-id'))).toEqual(['r-shop'])
  })

  it('never doubles the active project — its live run list wins over the index snapshot', async () => {
    renderPalette({
      projects: REGISTRY,
      entry: '/p/cezar/',
      // The live list has the run's CURRENT status; the index still says it was running.
      runs: [run({ id: 'r-mine', title: 'Fix the flaky test', status: 'review' })],
      indexed: [
        indexed({ id: 'r-mine', projectId: 'cezar', title: 'Fix the flaky test', status: 'running' }),
        indexed({ id: 'r-shop', projectId: 'shop', title: 'Checkout crash' }),
      ],
    })
    openWith({ metaKey: true })
    await screen.findByText('Checkout crash')

    const tasks = [...document.querySelectorAll('[data-slot="palette-task"]')]
    expect(tasks.map((task) => task.getAttribute('data-run-id'))).toEqual(['r-mine', 'r-shop'])
    // review → violet, not the index's stale running.
    expect(tasks[0]?.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('violet')
  })

  it('lists the boot project once from an unscoped screen like global settings', async () => {
    renderPalette({
      projects: REGISTRY,
      // No `/p/` prefix — the one cockpit area outside every project scope. `useRuns()` still
      // answers for the boot project, so its rows must not double up with the index's.
      entry: '/settings/global',
      runs: [run({ id: 'r-boot', title: 'Fix the flaky test' })],
      indexed: [
        indexed({ id: 'r-boot', projectId: 'cezar', title: 'Fix the flaky test' }),
        indexed({ id: 'r-shop', projectId: 'shop', title: 'Checkout crash' }),
      ],
    })
    openWith({ metaKey: true })
    await screen.findByText('Checkout crash')

    const tasks = [...document.querySelectorAll('[data-slot="palette-task"]')]
    expect(tasks.map((task) => task.getAttribute('data-run-id'))).toEqual(['r-boot', 'r-shop'])
    // And it is labelled with the boot project rather than going nameless.
    expect(tasks[0]?.querySelector('[data-slot="palette-task-project"]')?.textContent).toBe('cezar')

    fireEvent.click(tasks[0] as HTMLElement)

    // An explicit target, not an unprefixed one that would need the legacy redirect to land.
    expect(location()).toBe('/p/cezar/tasks/r-boot')
  })

  it('asks for no index at all in a single-project workspace', async () => {
    renderPalette({
      projects: [project({ id: 'cezar' })],
      entry: '/p/cezar/',
      runs: [run({ id: 'r-mine', title: 'Fix the flaky test' })],
    })
    openWith({ metaKey: true })
    await screen.findByText('Fix the flaky test')
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(2))

    const paths = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(paths).not.toContain('/api/v1/workspace/runs-index')
    // And no project label, because there is only one place a task could be.
    expect(document.querySelector('[data-slot="palette-task-project"]')).toBeNull()
  })
})

describe('Actions group', () => {
  it('Toggle theme cycles exactly like the toggle button (light → dark), persists, and closes', async () => {
    renderPalette({ theme: 'light' })
    expect(document.documentElement.classList.contains('light')).toBe(true)
    openWith({ metaKey: true })
    await screen.findByRole('dialog')

    fireEvent.click(document.querySelector('[data-action="toggle-theme"]') as HTMLElement)

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(document.documentElement.classList.contains('light')).toBe(false)
    expect(document.documentElement.style.colorScheme).toBe('dark')
    await waitFor(() => expect(dialog()).toBeNull())
  })

  it('navigates to /new from the leading row', async () => {
    renderPalette()
    openWith({ metaKey: true })
    await screen.findByRole('dialog')

    fireEvent.click(document.querySelector('[data-nav-to="/new"]') as HTMLElement)

    expect(location()).toBe('/new')
    await waitFor(() => expect(dialog()).toBeNull())
  })
})

describe('Skills group', () => {
  const MIXED: Skill[] = [
    skill({ name: 'global-deploy', source: 'global', description: 'Deploy from anywhere' }),
    skill({ name: 'project-review', source: 'agents', description: 'Review the diff' }),
    skill({ name: 'team-release', source: 'team' }),
    skill({ name: 'project-fix', source: 'ai' }),
    skill({ name: 'project-plan', source: 'cezar' }),
  ]

  it('orders local and team project skills before global ones, stably (#377/#555)', async () => {
    renderPalette({ skills: MIXED })
    openWith({ metaKey: true })
    await screen.findByText('project-review')

    const names = [...document.querySelectorAll('[data-slot="palette-skill"]')].map(
      (item) => item.getAttribute('data-skill'),
    )
    expect(names).toEqual(['project-review', 'team-release', 'project-fix', 'project-plan', 'global-deploy'])
  })

  it('lists most-used skills first, across localities (#519)', async () => {
    renderPalette({ skills: MIXED, uiState: { skillUsage: { 'team-release': 5, 'project-fix': 2 } } })
    openWith({ metaKey: true })
    await screen.findByText('project-review')

    // Used skills lead frequency-descending regardless of locality; the unused rest keeps
    // the #377 project-first split.
    await waitFor(() => {
      const names = [...document.querySelectorAll('[data-slot="palette-skill"]')].map(
        (item) => item.getAttribute('data-skill'),
      )
      expect(names).toEqual(['team-release', 'project-fix', 'project-review', 'project-plan', 'global-deploy'])
    })
  })

  it('selecting a skill client-navigates to the prefilling /new?skill=…', async () => {
    renderPalette({ skills: MIXED })
    openWith({ metaKey: true })
    await screen.findByText('project-review')

    fireEvent.click(document.querySelector('[data-skill="project-review"]') as HTMLElement)

    expect(location()).toBe('/new?skill=project-review')
    await waitFor(() => expect(dialog()).toBeNull())
  })

  it('shows the description beside the name', async () => {
    renderPalette({ skills: MIXED })
    openWith({ metaKey: true })

    const item = await screen.findByText('Deploy from anywhere')
    expect(item.closest('[data-slot="palette-skill"]')?.getAttribute('data-skill')).toBe('global-deploy')
  })
})

describe('the pure ordering helpers', () => {
  it('orderSkills puts every project source before every non-project one', () => {
    const ordered = orderSkills([
      skill({ name: 'g', source: 'global' }),
      skill({ name: 't', source: 'team' }),
      skill({ name: 'a', source: 'agents' }),
      skill({ name: 'c', source: 'cezar' }),
      skill({ name: 'i', source: 'ai' }),
    ])
    expect(ordered.map((entry) => entry.source)).toEqual(['team', 'agents', 'cezar', 'ai', 'global'])
  })

  it('orderRuns sorts newest first without mutating its input', () => {
    const input = [
      run({ id: 'a', title: 'a', createdAt: '2026-07-12T00:00:00Z' }),
      run({ id: 'b', title: 'b', createdAt: '2026-07-14T00:00:00Z' }),
    ]
    expect(orderRuns(input).map((entry) => entry.id)).toEqual(['b', 'a'])
    expect(input.map((entry) => entry.id)).toEqual(['a', 'b'])
  })

  it('mergeTasks puts the active project first and drops its duplicate index rows', () => {
    const merged = mergeTasks(
      [
        run({ id: 'a', title: 'a', createdAt: '2026-07-10T00:00:00Z' }),
        run({ id: 'b', title: 'b', createdAt: '2026-07-11T00:00:00Z' }),
      ],
      'cezar',
      [
        indexed({ id: 'a', projectId: 'cezar', title: 'a', createdAt: '2026-07-10T00:00:00Z' }),
        indexed({ id: 'z', projectId: 'shop', title: 'z', createdAt: '2026-07-20T00:00:00Z' }),
        indexed({ id: 'y', projectId: 'docs', title: 'y', createdAt: '2026-07-12T00:00:00Z' }),
      ],
    )
    // Active project newest-first, then the rest newest-first; `a`'s index twin is gone.
    expect(merged.map((task) => task.id)).toEqual(['b', 'a', 'z', 'y'])
    expect(merged.map((task) => task.projectId)).toEqual(['cezar', 'cezar', 'shop', 'docs'])
  })

  it('mergeTasks keeps every project when the cockpit is unscoped', () => {
    const merged = mergeTasks([run({ id: 'a', title: 'a' })], null, [
      indexed({ id: 'z', projectId: 'shop', title: 'z' }),
    ])
    expect(merged.map((task) => task.projectId)).toEqual([null, 'shop'])
  })

  it('mergeTasks dedups against the BOOT project when there is no active scope', () => {
    // Global settings: no project scope, so `useRuns()` answered for the boot project. The
    // caller passes that slug, and the index's twin of `a` must not become a second row.
    const merged = mergeTasks([run({ id: 'a', title: 'a' })], 'cezar', [
      indexed({ id: 'a', projectId: 'cezar', title: 'a' }),
      indexed({ id: 'z', projectId: 'shop', title: 'z' }),
    ])
    expect(merged.map((task) => `${task.projectId}/${task.id}`)).toEqual(['cezar/a', 'shop/z'])
  })

  it('orderProjects sorts most-recently-opened first, active last, without mutating', () => {
    const input = [
      project({ id: 'old', lastOpenedAt: '2026-07-10T00:00:00Z' }),
      project({ id: 'here', lastOpenedAt: '2026-07-14T00:00:00Z' }),
      project({ id: 'recent', lastOpenedAt: '2026-07-12T00:00:00Z' }),
    ]
    // `here` has the newest timestamp and still sinks — being where you already are outranks it.
    expect(orderProjects(input, 'here').map((entry) => entry.id)).toEqual(['recent', 'old', 'here'])
    // Unscoped (global settings) nothing is active, so it is pure recency.
    expect(orderProjects(input, null).map((entry) => entry.id)).toEqual(['here', 'recent', 'old'])
    expect(input.map((entry) => entry.id)).toEqual(['old', 'here', 'recent'])
  })
})
