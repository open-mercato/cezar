import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { queryKeys } from '@/api/queries'
import type { RunArtifact } from '@open-mercato/cezar-api-client'

import { ThreadArtifactCards } from './thread-artifact-cards'

const art = (name: string, kind: RunArtifact['kind'], minute: number, title?: string): RunArtifact => ({
  name,
  kind,
  size: 1,
  updatedAt: `2026-10-22T10:${String(minute).padStart(2, '0')}:00.000Z`,
  ...(title ? { title } : {}),
})

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>
}

/** Seeded cache, no fetch: the cards read only the listing the SSE frame keeps live. */
function mount(artifacts: RunArtifact[]) {
  const client = createQueryClient()
  client.setQueryData(queryKeys.runs.artifacts('r1'), { artifacts, truncated: false })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/tasks/r1']}>
        <Routes>
          <Route path="/tasks/:id" element={<ThreadArtifactCards runId="r1" />} />
          <Route path="/tasks/:id/assets/:name?" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return client
}

const cards = () => Array.from(document.querySelectorAll('[data-slot="thread-artifact-card"]')).map((card) => card.getAttribute('data-artifact'))

afterEach(cleanup)

describe('ThreadArtifactCards', () => {
  it('renders nothing for a run that published nothing', () => {
    mount([])
    expect(document.querySelector('[data-slot="thread-artifacts"]')).toBeNull()
  })

  it('shows a card with title, kind and name, and Open lands on that asset in the Assets view', async () => {
    mount([art('demo.html', 'html', 1, 'Dry-run demo')])
    expect(screen.getByText('Dry-run demo')).toBeTruthy()
    expect(screen.getByText('HTML · demo.html')).toBeTruthy()
    fireEvent.click(screen.getByRole('link', { name: 'Open Dry-run demo in Assets' }))
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/tasks/r1/assets/demo.html'))
  })

  it('grows when the listing gains a file, and keeps a reload-stable order: the newest three, oldest first', async () => {
    const client = mount([art('a.html', 'html', 1), art('b.md', 'markdown', 2)])
    expect(cards()).toEqual(['a.html', 'b.md'])
    act(() => {
      client.setQueryData(queryKeys.runs.artifacts('r1'), {
        artifacts: [art('a.html', 'html', 1), art('b.md', 'markdown', 2), art('c.png', 'image', 3), art('d.json', 'json', 4)],
        truncated: false,
      })
    })
    await waitFor(() => expect(cards()).toEqual(['b.md', 'c.png', 'd.json']))
    expect(screen.getByRole('link', { name: '1 more in Assets' }).getAttribute('href')).toBe('/tasks/r1/assets')
  })
})
