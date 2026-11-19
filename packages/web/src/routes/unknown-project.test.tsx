import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import { afterEach, expect, it } from 'vitest'
import { UnknownProjectRoute } from './unknown-project'

afterEach(cleanup)
it('lets a Manager decision return from a task in a deleted project', () => {
  render(<MemoryRouter initialEntries={[{ pathname: '/p/gone/tasks/deleted/chat', state: { manager: { id: 'm', name: 'Mira', decision: 'ask-1' } } }]}>
    <Routes><Route path="/p/:projectId/tasks/:id/chat" element={<UnknownProjectRoute projectId="gone" registry={{ projects: [], bootProject: 'alpha', projectsDir: '' }} />} /></Routes>
  </MemoryRouter>)
  expect(screen.getByRole('link', { name: 'Back to Mira' }).getAttribute('href')).toBe('/manager/m#decision-ask-1')
})
