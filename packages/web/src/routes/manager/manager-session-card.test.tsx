import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { workspaceQueryKeys } from '@/api/queries'

import { SessionCard, TaskChipLabel } from './manager-session-card'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

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

  it('holds the loaded card\'s two lines with a skeleton while the index loads, never the raw id', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <SessionCard projectId="p1" runId="de81d115abcdef" origin={{ id: 'm1', name: 'Ops Manager' }} />
          <TaskChipLabel projectId="p1" runId="de81d115abcdef" />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    const card = document.querySelector('[data-slot="session-card"]')!
    expect(card.textContent).not.toMatch(/de81d115/)
    const loading = card.querySelector('[data-slot="session-card-loading"]')!
    // Title row and the status row the loaded card has.
    expect(loading.children).toHaveLength(3)
    expect(loading.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(2)
    expect(loading.lastElementChild!.className).toContain('min-h-4')
    expect(document.body.textContent).not.toMatch(/task de81d115/)
  })
})
