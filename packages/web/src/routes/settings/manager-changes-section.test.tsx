import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { managerKeys } from '@/api/managers'
import { workspaceQueryKeys } from '@/api/queries'
import type { ManagerChange } from '@open-mercato/cezar-api-client'

import { changeByLabel, ManagerChangesSection } from './manager-changes-section'

const change = (n: number, overrides: Partial<ManagerChange> = {}): ManagerChange => ({
  id: `c${n}`, at: '2026-11-20T14:02:00.000Z', managerId: 'm1', managerName: 'Scout', type: 'merge-pr', kind: 'proposal',
  category: 'pull-requests', actionId: `a${n}`, projectId: 'alpha', summary: `Merge of alpha#${n}`, outcome: 'done', result: `Merged #${n}`, by: 'user', ...overrides,
})

const requests: string[] = []
let answer: { changes: ManagerChange[] } = { changes: [] }

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(managerKeys.list, { managers: [{ id: 'm1', name: 'Scout', avatar: 0 }] })
  client.setQueryData(workspaceQueryKeys.projects, { projects: [{ id: 'alpha', name: 'Meblohand' }], bootProject: 'alpha', projectsDir: '' })
  render(<QueryClientProvider client={client}><MemoryRouter><ManagerChangesSection /></MemoryRouter></QueryClientProvider>)
  return client
}

beforeEach(() => {
  requests.length = 0
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    requests.push(url)
    if (url.includes('/admin-audit')) return Response.json(answer)
    return new Promise(() => {})
  }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Settings → Behaviour → Change history (spec 2026-11-20 § 3.3)', () => {
  it('lists each change with its manager, project, kind, outcome, who settled it and the reason', async () => {
    answer = { changes: [
      change(128, { reason: 'Checks are green.' }),
      change(129, { outcome: 'rejected', result: 'Rejected' }),
      change(1, { kind: 'direct', type: 'rename', category: 'managers', summary: 'Renamed New manager to Scout', by: 'manager', actionId: undefined, projectId: undefined, result: undefined }),
    ] }
    renderSection()
    const rows = await screen.findAllByRole('listitem')
    expect(rows).toHaveLength(3)
    expect(rows[0]?.textContent).toContain('Merge of alpha#128')
    expect(rows[0]?.textContent).toContain('Meblohand')
    expect(rows[0]?.textContent).toContain('Pull requests')
    expect(rows[0]?.textContent).toContain('approved by you')
    expect(rows[0]?.textContent).toContain('Checks are green.')
    expect(rows[0]?.textContent).toContain('Merged #128')
    expect(rows[1]?.textContent).toContain('Rejected')
    expect(rows[1]?.textContent).toContain('by you')
    expect(rows[2]?.textContent).toContain('by the manager, no card')
    // A decided card links back to itself in the chat; a direct write has no card.
    const links = screen.getAllByRole('link', { name: 'Open card' })
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/manager/m1#decision-a128', '/manager/m1#decision-a129'])
  })

  it('says so when there is nothing yet', async () => {
    answer = { changes: [] }
    renderSection()
    expect(await screen.findByText(/No changes yet/)).toBeTruthy()
    expect(requests.some((url) => url.endsWith('/api/v1/workspace/admin-audit?limit=50'))).toBe(true)
  })

  it('pages older entries on demand', async () => {
    answer = { changes: Array.from({ length: 50 }, (_, index) => change(index + 1)) }
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: 'Show older' }))
    await waitFor(() => expect(requests.some((url) => url.endsWith('/api/v1/workspace/admin-audit?limit=100'))).toBe(true))
  })

  it('names who settled it in the user\'s words', () => {
    expect(changeByLabel({ kind: 'proposal', by: 'user', outcome: 'done' })).toBe('approved by you')
    expect(changeByLabel({ kind: 'proposal', by: 'user', outcome: 'failed' })).toBe('approved by you')
    expect(changeByLabel({ kind: 'proposal', by: 'user', outcome: 'dismissed' })).toBe('by you')
    expect(changeByLabel({ kind: 'proposal', by: 'cezar', outcome: 'dismissed' })).toBe('by cezar')
    expect(changeByLabel({ kind: 'direct', by: 'manager', outcome: 'done' })).toBe('by the manager, no card')
  })
})
