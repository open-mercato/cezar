import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { HealthResponse, RunRecord, Skill } from '@open-mercato/cezar-api-client'
import { CommandPalette, orderRuns } from '@/components/command-palette'
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

/** Health with/without a working forge — what gates the Views group's GitHub row (R6 1.1). */
function health(forgeAvailable: boolean): HealthResponse {
  return {
    version: '0.0.0-test',
    projects: [],
    bootProject: 'default',
    repoRoot: '/repo',
    repo: { root: '/repo', branch: 'main' },
    checks: [],
    defaultRunner: 'claude',
    forge: forgeAvailable ? { kind: 'github', available: true } : null,
    capabilities: { localHandoff: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: true, singleProject: false },
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
  theme,
  forge = true,
  uiState = {} as Record<string, unknown>,
}: {
  runs?: RunRecord[]
  skills?: Skill[]
  theme?: Theme
  forge?: boolean
  uiState?: Record<string, unknown>
} = {}) {
  if (theme) localStorage.setItem(THEME_STORAGE_KEY, theme)
  serve({ '/api/v1/runs': runs, '/api/v1/skills': skills, '/api/v1/health': health(forge), '/api/v1/ui-state': uiState })
  render(
    <QueryClientProvider client={createQueryClient()}>
      <ThemeProvider>
        <MemoryRouter initialEntries={['/']}>
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
    expect(await screen.findByPlaceholderText(/Search tasks, views/)).toBeTruthy()
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
    const input = await screen.findByPlaceholderText(/Search tasks, views/)

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
  it('lists the 8 nav destinations plus New task with its C hint', async () => {
    renderPalette()
    openWith({ metaKey: true })
    await screen.findByRole('dialog')

    // The GitHub row waits on the health answer (forge gate) — settle before asserting.
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="palette-view"]')).toHaveLength(9),
    )
    const views = [...document.querySelectorAll('[data-slot="palette-view"]')]
    expect(views.map((view) => view.getAttribute('data-nav-to'))).toEqual([
      '/', '/inbox', '/git', '/github', '/automations', '/skills', '/workflows', '/settings', '/new',
    ])
    expect(views[8]?.textContent).toContain('New task')
    // The chip advertises `c` — ⌘N is browser-reserved and only fires in the desktop shell.
    expect(views[8]?.textContent).toContain('C')
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

describe('Tasks group', () => {
  it('lists runs newest first with their attention dot, and navigates to the run', async () => {
    renderPalette({
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

    expect(location()).toBe('/tasks/r-new')
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

  it('offers New task as an action too — client navigation to /new', async () => {
    renderPalette()
    openWith({ metaKey: true })
    await screen.findByRole('dialog')

    fireEvent.click(document.querySelector('[data-action="new-task"]') as HTMLElement)

    expect(location()).toBe('/new')
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
})
