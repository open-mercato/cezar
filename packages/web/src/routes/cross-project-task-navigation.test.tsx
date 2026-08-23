import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ProjectsResponse } from '@open-mercato/cezar-api-client'
import { AppearanceProvider } from '@/components/appearance-provider'
import { ListViewProvider } from '@/components/list-view'
import { ThemeProvider } from '@/components/theme-provider'
import { AppRoutes } from '@/routes'

/**
 * Opening ANOTHER project's task without a reload (#task-detail-404).
 *
 * The rows of the global Tasks page, the sidebar's per-project lists and the ⌘K palette all link
 * into a project that is not the one the app currently stands in. The thread that arrives must ask
 * `/api/v1/p/<that project>/runs/:id` — the unscoped spelling reaches the BOOT project, which
 * honestly answers 404 for a run it does not own, and TanStack caches that error under the
 * correctly-scoped key, so the thread stays stuck on "Task not found" until a reload.
 *
 * Rendered under `StrictMode`, like `main.tsx`: its simulated remount is exactly what broke this.
 * The provider and the thread mount in ONE commit (soft navigation, thread chunk already loaded),
 * the double-invoke destroys the provider's scope reset among the subtree's cleanups, and a
 * PASSIVE reset then landed before the re-created child effects — which is where every request is
 * made. A reload never showed it: there the provider commits with the lazy route's Suspense
 * fallback, one commit ahead of the thread's own mount.
 */

const BOOT = 'boot'
const RUN_ID = 'r1'

const HEALTH = {
  version: '0.0.0-test',
  repoRoot: '/home/u/cezar',
  repo: null,
  checks: [],
  defaultRunner: 'claude',
  forge: null,
  capabilities: { localHandoff: true, followups: true, singleProject: false, automations: false },
  projects: [{ id: BOOT, name: 'cezar' }],
  bootProject: BOOT,
}

const REGISTRY: ProjectsResponse = {
  projects: [
    { id: BOOT, name: 'cezar', root: '/home/u/cezar', addedAt: '', lastOpenedAt: '', source: 'local', status: 'ok' },
    { id: 'other', name: 'other-repo', root: '/home/u/other', addedAt: '', lastOpenedAt: '', source: 'local', status: 'ok' },
  ],
  bootProject: BOOT,
  projectsDir: '~/cezar/projects',
}

/** The row the global Tasks page renders, and the record its thread then reads. */
const INDEX_ROW = {
  projectId: 'other',
  id: RUN_ID,
  title: 'Do the thing',
  status: 'done',
  createdAt: '2026-07-14T10:00:00Z',
  archived: false,
  workflow: 'quick-task',
  seenAt: '2026-07-14T10:06:00Z',
}

const RUN = {
  ...INDEX_ROW,
  task: 'Do the thing',
  startedAt: '2026-07-14T10:00:00Z',
  finishedAt: '2026-07-14T10:05:00Z',
  steps: [],
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** The unscoped spelling of every route this task's thread needs — what a stale scope emits. */
const UNSCOPED = [
  `/api/v1/runs/${RUN_ID}`,
  `/api/v1/runs/${RUN_ID}/history`,
  `/api/v1/runs/${RUN_ID}/history-context`,
]

let paths: string[] = []

beforeEach(() => {
  paths = []
  localStorage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      paths.push(path)
      if (path === '/api/v1/health') return json(HEALTH)
      if (path === '/api/v1/projects') return json(REGISTRY)
      if (path === '/api/v1/workspace/runs-index') {
        return json({ runs: [INDEX_ROW], perProjectLimit: 200, truncated: [], referenceStatuses: {} })
      }
      if (path === `/api/v1/p/other/runs/${RUN_ID}`) return json(RUN)
      // What the server really answers when the boot project is asked for another one's run.
      if (UNSCOPED.includes(path)) return json({ error: 'not found' }, 404)
      // Everything else stays pending — this file is about which URL goes out, not about data.
      return new Promise<never>(() => {})
    }),
  )
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
})

/** The address bar (MemoryRouter keeps it internal) plus the one cross-project jump every
 *  surface outside the arriving project makes — a plain, explicitly scoped target. */
function NavigationProbe() {
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <>
      <div data-testid="location" data-pathname={location.pathname} />
      <button onClick={() => navigate(`/p/other/tasks/${RUN_ID}`)}>Open the other project’s task</button>
    </>
  )
}

function renderAt(entry: string) {
  const client = createQueryClient()
  render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <AppearanceProvider>
            <MemoryRouter initialEntries={[entry]}>
              <ListViewProvider>
                <AppRoutes />
                <NavigationProbe />
              </ListViewProvider>
            </MemoryRouter>
          </AppearanceProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </StrictMode>,
  )
}

/** Wait for the thread's own request, whichever spelling it chose, then hold both to account. */
async function expectTheRunWasReadFromItsOwnProject() {
  await waitFor(() =>
    expect(document.querySelector('[data-testid="location"]')?.getAttribute('data-pathname')).toBe(
      `/p/other/tasks/${RUN_ID}`,
    ),
  )
  await waitFor(() => expect(paths.some((path) => path.includes(`/runs/${RUN_ID}`))).toBe(true))
  expect(paths).toContain(`/api/v1/p/other/runs/${RUN_ID}`)
  for (const path of UNSCOPED) expect(paths).not.toContain(path)
  expect(screen.queryByText('Task not found')).toBeNull()
}

describe('opening another project’s task without a reload', () => {
  it('reads the run from its own project when the row is clicked on the global Tasks page', async () => {
    renderAt('/tasks')
    fireEvent.click(await screen.findByRole('link', { name: 'Do the thing' }))
    await expectTheRunWasReadFromItsOwnProject()
  })

  // The regression proper: standing INSIDE a project (the boot one — which mounts unscoped, so a
  // leaked scope is invisible in the URL) and jumping to another project's task, with the thread
  // chunk already warm from the case above. Provider and thread mount in the same commit.
  it('reads the run from its own project when jumping out of the project in view', async () => {
    renderAt(`/p/${BOOT}/`)
    fireEvent.click(await screen.findByRole('button', { name: 'Open the other project’s task' }))
    await expectTheRunWasReadFromItsOwnProject()
  })
})
