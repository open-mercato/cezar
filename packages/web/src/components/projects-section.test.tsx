import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ProjectListEntry } from '@open-mercato/cezar-api-client'
import { ProjectsSection } from './projects-section'

// The section reads the workspace runs index for each project's tasks; an empty answer here.
beforeEach(() =>
  vi.stubGlobal('fetch', async () =>
    new Response(JSON.stringify({ runs: [], perProjectLimit: 200, truncated: [], referenceStatuses: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ),
)
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const wrap = (ui: React.ReactElement) => (
  <QueryClientProvider client={createQueryClient()}>
    <MemoryRouter>{ui}</MemoryRouter>
  </QueryClientProvider>
)

const project = (n: number): ProjectListEntry => ({
  id: `p${n}`,
  name: `project-${n}`,
  root: `/r/p${n}`,
  addedAt: '2026-07-01T00:00:00.000Z',
  // Newer n = opened more recently, so the order under test is p13, p12, … p1.
  lastOpenedAt: `2026-07-${String(n).padStart(2, '0')}T00:00:00.000Z`,
  source: 'local',
  status: 'ok',
})

const rows = () => [...document.querySelectorAll('[data-slot="project-row"]')].map((r) => r.getAttribute('data-project-id'))

describe('ProjectsSection', () => {
  it('shows the ten most recent projects, then loads ten more on request', () => {
    const projects = Array.from({ length: 13 }, (_, i) => project(i + 1))
    render(wrap(<ProjectsSection projects={projects} activeId={null} />))
    expect(rows()).toHaveLength(10)
    expect(rows()[0]).toBe('p13')
    const more = screen.getByRole('button', { name: 'Load 3 more' })
    fireEvent.click(more)
    expect(rows()).toHaveLength(13)
    expect(screen.queryByRole('button', { name: /Load/ })).toBeNull()
  })

  it('pins the active project first and marks it', () => {
    const projects = Array.from({ length: 3 }, (_, i) => project(i + 1))
    render(wrap(<ProjectsSection projects={projects} activeId="p1" />))
    expect(rows()[0]).toBe('p1')
    expect(screen.getByRole('link', { name: 'project-1' }).getAttribute('aria-current')).toBe('page')
  })
})
