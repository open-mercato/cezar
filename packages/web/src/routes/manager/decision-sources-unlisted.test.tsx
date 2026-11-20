import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'

import { workspaceQueryKeys } from '@/api/queries'
import type { ManagerMessage } from '@open-mercato/cezar-api-client'

import { DecisionSources } from './decision-sources'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const card = (number: number) => ({
  id: `card-${number}`,
  seq: 1,
  at: '2026-11-18T12:00:00.000Z',
  kind: 'action',
  status: 'pending',
  action: { type: 'merge-pr', projectId: 'acme', number },
  sourceTasks: [{ projectId: 'acme', runId: 'owner' }],
}) as ManagerMessage

function renderCard(number: number) {
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input, 'http://localhost')
    requests.push(url.pathname)
    if (url.pathname === '/api/v1/p/acme/runs/owner') {
      return Response.json({ id: 'owner', title: 'Fix the tags input', status: 'review', createdAt: '2026-01-01T00:00:00.000Z', pullRequestUrl: 'https://github.com/o/r/pull/9783' })
    }
    return Response.json({})
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  // The index holds the project's 200 newest tasks: the card's source is older than all of them.
  client.setQueryData(workspaceQueryKeys.runsIndex, { runs: [], truncated: ['acme'], referenceStatuses: {} })
  client.setQueryData(workspaceQueryKeys.projects, { projects: [{ id: 'acme', name: 'acme' }], bootProject: null, projectsDir: '' })
  render(<QueryClientProvider client={client}><MemoryRouter><DecisionSources message={card(number)} origin={{ id: 'm', name: 'Manager' }} /></MemoryRouter></QueryClientProvider>)
  return requests
}

it('reads a source task the capped runs index left out, and keeps it when it carries the PR', async () => {
  const requests = renderCard(9783)
  expect(await screen.findByText('Fix the tags input')).toBeTruthy()
  expect(requests).toContain('/api/v1/p/acme/runs/owner')
})

it('still drops an unlisted source that does not carry the card\'s PR', async () => {
  const requests = renderCard(9800)
  await vi.waitFor(() => expect(requests).toContain('/api/v1/p/acme/runs/owner'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(screen.queryByText('Fix the tags input')).toBeNull()
  expect(document.querySelector('[data-slot="decision-sources"]')).toBeNull()
})
