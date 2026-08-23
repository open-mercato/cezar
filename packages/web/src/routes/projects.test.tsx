import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { ProjectsRoute } from '@/routes/projects'

const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => vi.stubGlobal('fetch', fetchMock))
afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

const project = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  root: `/home/me/${id}`,
  addedAt: '2026-07-01T00:00:00.000Z',
  lastOpenedAt: '2026-07-20T12:00:00.000Z',
  source: 'local',
  status: 'ok',
  branch: 'main',
  ...over,
})

function serve(routes: Record<string, unknown>) {
  fetchMock.mockImplementation(async (input) => {
    const body = routes[String(input)]
    if (body === undefined) return new Response('{"error":"not found"}', { status: 404 })
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
}

describe('ProjectsRoute', () => {
  it('lists projects by last use with what needs you, what runs, and a door into each', async () => {
    serve({
      '/api/v1/projects': {
        projects: [
          project('old', { lastOpenedAt: '2026-07-01T00:00:00.000Z' }),
          project('shop', { lastOpenedAt: '2026-07-21T00:00:00.000Z' }),
          project('gone', { status: 'missing', lastOpenedAt: '2026-07-15T00:00:00.000Z' }),
        ],
        bootProject: 'old',
        projectsDir: '/home/me/projects',
      },
      '/api/v1/workspace/runs-index': {
        runs: [
          { projectId: 'shop', id: 'a', title: 'A', status: 'waiting', createdAt: '2026-07-20T00:00:00.000Z', archived: false, workflow: 'default' },
          { projectId: 'shop', id: 'b', title: 'B', status: 'running', createdAt: '2026-07-20T00:00:00.000Z', archived: false, workflow: 'default' },
          { projectId: 'shop', id: 'c', title: 'C', status: 'done', createdAt: '2026-07-20T00:00:00.000Z', archived: false, workflow: 'default' },
          { projectId: 'shop', id: 'z', title: 'Z', status: 'done', createdAt: '2026-07-20T00:00:00.000Z', archived: true, workflow: 'default' },
        ],
        referenceStatuses: {},
        perProjectLimit: 200,
        truncated: [],
      },
    })
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={['/projects']}>
          <ProjectsRoute />
        </MemoryRouter>
      </QueryClientProvider>,
    )

    await waitFor(() => expect(document.querySelectorAll('[data-slot="project-row"]')).toHaveLength(3))
    const rows = [...document.querySelectorAll('[data-slot="project-row"]')]
    expect(rows.map((r) => r.getAttribute('data-project-id'))).toEqual(['shop', 'gone', 'old'])

    const shop = rows[0] as HTMLElement
    expect(shop.querySelector('[data-slot="project-open"]')?.getAttribute('href')).toBe('/p/shop/')
    expect(shop.querySelector('[data-slot="project-needs-you"]')?.textContent).toBe('1 needs you')
    expect(shop.querySelector('[data-slot="project-running"]')?.textContent).toBe('1 running')
    // Archived stays out of the count.
    expect(shop.textContent).toContain('3 tasks')
    expect(screen.getByRole('link', { name: 'New task in shop' }).getAttribute('href')).toBe('/p/shop/new')

    // A missing folder is named but not a door, and says why.
    const gone = rows[1] as HTMLElement
    expect(gone.querySelector('[data-slot="project-open"]')).toBeNull()
    expect(gone.textContent).toContain('folder missing')
    expect(screen.queryByRole('link', { name: 'New task in gone' })).toBeNull()

    expect(screen.getByRole('link', { name: /Manage/ }).getAttribute('href')).toBe('/settings/global/projects')
  })
})
