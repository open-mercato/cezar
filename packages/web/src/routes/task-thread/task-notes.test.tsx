import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ApiRun } from '@open-mercato/cezar-api-client'

import { TaskNotesRoute } from './task-notes'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const RUN: ApiRun = {
  id: 'r1',
  title: 'do the thing plz',
  titleSummary: 'Do the thing',
  workflow: 'quick-task',
  task: 'Summarize what this project does.',
  status: 'done',
  createdAt: '2026-07-15T08:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  steps: [],
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function stubFetch(handoff: () => Response): string[] {
  const sent: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      sent.push(path)
      if (path === '/api/v1/runs/r1') return jsonResponse(RUN)
      if (path === '/api/v1/runs/r1/handoff') return handoff()
      if (path === '/api/v1/runs') return jsonResponse([])
      return jsonResponse({})
    }),
  )
  return sent
}

function renderNotesRoute() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/tasks/r1/notes']}>
        <Routes>
          <Route path="/tasks/:id/notes" element={<TaskNotesRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('the Notes tab route', () => {
  it('renders the header with Notes active and the handoff as markdown', async () => {
    stubFetch(
      () =>
        new Response('# Handoff notes\n\nStill **todo**: the composer.', {
          status: 200,
          headers: { 'content-type': 'text/markdown; charset=utf-8' },
        }),
    )
    renderNotesRoute()

    await screen.findByText('Handoff notes')
    expect(
      document.querySelector('[data-slot="run-tabs"] a[aria-current="page"]')?.textContent,
    ).toBe('Notes')
    // Rendered markdown, not echoed source.
    expect(document.querySelector('[data-slot="notes-panel"]')?.textContent).not.toContain('#')
  })

  it('an unseeded handoff file reads as an honest empty state', async () => {
    stubFetch(() => new Response('', { status: 200 }))
    renderNotesRoute()
    await waitFor(() =>
      expect(
        screen.getByText('No notes yet — the handoff file is seeded when the task starts.'),
      ).not.toBeNull(),
    )
  })
})
