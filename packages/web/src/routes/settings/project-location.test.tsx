import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import { AppearanceProvider } from '@/components/appearance-provider'
import { ContextSidebarContext } from '@/components/context-sidebar'
import { GlobalSettingsDialog } from '@/components/global-settings-dialog'
import { ListViewProvider } from '@/components/list-view'
import { ThemeProvider } from '@/components/theme-provider'
import { AppRoutes } from '@/routes'
import { ShellProviders } from '@/test/shell-providers'

/**
 * Project settings shows WHERE the project is (project-location.tsx): the registry's absolute
 * root, in the index card and in the desktop nav footer. Pinned through the real routes so the
 * two renderings are asserted where a user meets them — including the one that must NOT appear,
 * global settings, which describes no project at all.
 */

const ROOT = '/Users/me/code/demo-project'

let requests: Array<{ method: string; url: string; body?: unknown }> = []

/** Only the two routes this pane talks to answer — the open-target list and the launch itself.
 *  Everything else the routes fetch stays honestly pending. */
function serve(targets: Array<{ id: string; label: string; icon?: string }> = OPEN_TARGETS) {
  requests = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined
      requests.push({ method, url, body })
      const json = (payload: unknown) =>
        new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url === '/api/v1/open-targets') return json({ targets })
      if (url === '/api/v1/open-in') return json({ opened: true, path: ROOT })
      return new Promise<never>(() => {})
    }),
  )
}

const OPEN_TARGETS = [
  { id: 'finder', label: 'Finder', icon: 'folder' },
  { id: 'vscode', label: 'VS Code', icon: 'vscode' },
  // The agent CLIs the machine has: offered for a task worktree, never for the checkout.
  { id: 'cli:claude', label: 'Claude CLI', icon: 'claude' },
]

function seededClient() {
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, {
    bootProject: 'boot',
    capabilities: { localHandoff: true, followups: true, singleProject: false, automations: false },
  })
  client.setQueryData(workspaceQueryKeys.projects, {
    projects: [
      {
        id: 'boot',
        name: 'demo-project',
        root: ROOT,
        addedAt: '2026-07-20T10:00:00.000Z',
        lastOpenedAt: '2026-07-20T10:00:00.000Z',
        source: 'local',
        status: 'ok',
      },
    ],
    bootProject: 'boot',
    projectsDir: '~/cezar/projects',
  })
  return client
}

const NO_REGISTRATION = () => () => {}

/** What the app shell gives every route: global settings as a dialog (the global sections render
 *  inside it, and its first one reads the theme), the list view the project home reads, and a
 *  mounted contextual sidebar — the settings nav and its folder footer are portalled into it. */
function renderAt(entry: string) {
  const sidebar = document.createElement('div')
  sidebar.setAttribute('data-slot', 'test-context-sidebar')
  document.body.appendChild(sidebar)
  render(
    <QueryClientProvider client={seededClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <ThemeProvider>
          <AppearanceProvider>
            <ShellProviders dialog={<GlobalSettingsDialog />}>
              <ContextSidebarContext.Provider value={{ node: sidebar, register: NO_REGISTRATION }}>
                <ListViewProvider>
                  <AppRoutes />
                </ListViewProvider>
              </ContextSidebarContext.Provider>
            </ShellProviders>
          </AppearanceProvider>
        </ThemeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => serve())

/** Radix opens on pointerdown. Returns the menu's target ids, in order. */
async function openWithMenu(): Promise<string[]> {
  const trigger = await waitFor(() => {
    const el = document.querySelector('[data-slot="project-location-open"]')
    expect(el).not.toBeNull()
    return el!
  })
  fireEvent.pointerDown(trigger)
  return waitFor(() => {
    const items = [...document.querySelectorAll('[data-target]')]
    expect(items.length).toBeGreaterThan(0)
    return items.map((el) => el.getAttribute('data-target')!)
  })
}

afterEach(() => {
  cleanup()
  document.querySelectorAll('[data-slot="test-context-sidebar"]').forEach((node) => node.remove())
  vi.unstubAllGlobals()
})

describe('the project folder in settings', () => {
  it('the General page names the absolute root, in full', async () => {
    renderAt('/settings')
    const field = await waitFor(() => {
      const el = document.querySelector('[data-slot="project-location"][data-variant="field"]')
      expect(el).not.toBeNull()
      return el!
    })
    // The whole path, not an ellipsised head — this row exists to be read and pasted.
    expect(field.querySelector('[data-slot="project-location-path"]')?.textContent).toBe(ROOT)
  })

  it('every project section keeps the root in the nav footer', async () => {
    renderAt('/settings/worktrees')
    const nav = await waitFor(() => {
      // The footer of the contextual sidebar the section nav lives in.
      const el = document.querySelector(
        '[data-slot="test-context-sidebar"] [data-slot="sidebar-footer"] [data-slot="project-location"]',
      )
      expect(el).not.toBeNull()
      return el!
    })
    expect(nav.querySelector('[data-action="project-location-copy"]')?.textContent).toBe(ROOT)
  })

  it('copies the path to the clipboard', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    renderAt('/settings')
    const copy = await screen.findByTitle('Copy the project folder path')

    fireEvent.click(copy)

    expect(writeText).toHaveBeenCalledWith(ROOT)
  })

  it('"Open with" lists the machine\'s apps, minus the agent CLIs', async () => {
    renderAt('/settings')
    // `cli:claude` is detected and offered for a task worktree, but opening the CHECKOUT in an
    // agent CLI is exactly what worktrees exist to avoid — the server 400s it too.
    expect(await openWithMenu()).toEqual(['finder', 'vscode'])
  })

  it('a pick opens the project folder through the server — the path never travels', async () => {
    renderAt('/settings')
    await openWithMenu()

    fireEvent.click(document.querySelector('[data-target="vscode"]')!)

    await waitFor(() => {
      expect(requests.find((r) => r.method === 'POST' && r.url === '/api/v1/open-in')).toBeDefined()
    })
    // The target and nothing else: the server resolves the folder from the scope it already has.
    expect(requests.find((r) => r.url === '/api/v1/open-in')?.body).toEqual({ target: 'vscode' })
  })

  it('hosted mode has no apps to offer, so no menu is rendered', async () => {
    serve([])
    renderAt('/settings')
    await waitFor(() => {
      expect(document.querySelector('[data-slot="project-location"]')).not.toBeNull()
    })
    await waitFor(() => {
      expect(requests.some((r) => r.url === '/api/v1/open-targets')).toBe(true)
    })
    expect(document.querySelector('[data-slot="project-location-open"]')).toBeNull()
  })

  it('global settings shows no project folder — it describes no project', async () => {
    // Global settings are a dialog now; the deep link opens it, and nothing in it (or in the
    // sidebar of the screen behind it) names a project folder.
    renderAt('/settings/global')
    await waitFor(() => {
      expect(document.querySelector('[data-slot="global-settings-dialog"]')).not.toBeNull()
    })
    expect(document.querySelector('[data-slot="project-location"]')).toBeNull()
  })
})
