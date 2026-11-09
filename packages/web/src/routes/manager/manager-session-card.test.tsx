import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { workspaceQueryKeys } from '@/api/queries'

import { SessionCard } from './manager-session-card'

afterEach(cleanup)

describe('SessionCard', () => {
  it('names the task, not the chat’s own manager, and carries it on the link', () => {
    const client = createQueryClient()
    client.setQueryData(workspaceQueryKeys.runsIndex, {
      runs: [{ id: 'run-1', projectId: 'p1', title: 'Fix the login bug', status: 'running' }],
    })
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <SessionCard projectId="p1" runId="run-1" origin={{ id: 'm1', name: 'Ops Manager' }} />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    const card = document.querySelector('[data-slot="session-card"]')!
    expect(card.getAttribute('href')).toBe('/p/p1/tasks/run-1')
    expect(screen.queryByText('Ops Manager')).toBeNull()
    expect(card.textContent).toMatch(/Fix the login bug/)
  })
})
