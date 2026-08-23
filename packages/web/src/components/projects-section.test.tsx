import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import type { ProjectListEntry } from '@open-mercato/cezar-api-client'
import { ProjectsSection } from './projects-section'

afterEach(cleanup)

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
    render(
      <MemoryRouter>
        <ProjectsSection projects={projects} activeId={null} />
      </MemoryRouter>,
    )
    expect(rows()).toHaveLength(10)
    expect(rows()[0]).toBe('p13')
    const more = screen.getByRole('button', { name: 'Load 3 more' })
    fireEvent.click(more)
    expect(rows()).toHaveLength(13)
    expect(screen.queryByRole('button', { name: /Load/ })).toBeNull()
  })

  it('pins the active project first and marks it', () => {
    const projects = Array.from({ length: 3 }, (_, i) => project(i + 1))
    render(
      <MemoryRouter>
        <ProjectsSection projects={projects} activeId="p1" />
      </MemoryRouter>,
    )
    expect(rows()[0]).toBe('p1')
    expect(screen.getByRole('link', { name: 'project-1' }).getAttribute('aria-current')).toBe('page')
  })
})
