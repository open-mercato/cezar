import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ApiRun, Capabilities, RunUnit } from '@open-mercato/cezar-api-client'
import { GuardRoute } from '@/routes/missions/guard'

/**
 * The Guard inbox (spec `2026-09-08-units-hierarchy` Q4) — a FILTERED VIEW of the same tree the
 * Missions page paints, so it is tested for what it filters and what it leaves out, not for an
 * approval UI it deliberately does not have (the thread's ask card is that).
 */

const NOW = Date.parse('2026-09-08T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

let seq = 0
function run(unit: RunUnit, over: Partial<ApiRun> = {}): ApiRun {
  seq += 1
  return {
    id: `r${seq}`,
    title: `Task ${seq}`,
    workflow: 'quick-task',
    task: `task ${seq}`,
    status: 'running',
    createdAt: ago(60_000),
    tokensUsed: 0,
    archived: false,
    steps: [],
    unit,
    ...over,
  } as ApiRun
}

const fetchMock = vi.fn<typeof fetch>()
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

function renderGuard(runs: ApiRun[], capabilities: Partial<Capabilities> = { units: true }) {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input)
    if (url === '/api/v1/runs') return json(runs)
    if (url === '/api/v1/health') return json({ capabilities })
    return json([])
  })
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/guard']}>
        <GuardRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const rowFor = (id: string) => document.querySelector(`[data-slot="guard-row"][data-run-id="${id}"]`)

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

describe('GuardRoute', () => {
  it('lists only the waiting nodes, newest first, each naming its mission', async () => {
    renderGuard([
      run({ role: 'caesar', missionId: 'm1' }, { id: 'm1', title: 'Ship the release' }),
      run(
        { role: 'legate', missionId: 'm1', parentRunId: 'm1' },
        { id: 'older', title: 'Cut the notes', status: 'waiting', createdAt: ago(50_000) },
      ),
      run(
        { role: 'centurion', missionId: 'm1', parentRunId: 'm1' },
        { id: 'newer', title: 'Tag the commit', status: 'waiting', createdAt: ago(10_000) },
      ),
      run(
        { role: 'centurion', missionId: 'm1', parentRunId: 'm1' },
        { id: 'busy', title: 'Still working', status: 'running' },
      ),
    ])

    await waitFor(() => expect(rowFor('newer')).not.toBeNull())
    const ids = [...document.querySelectorAll('[data-slot="guard-row"]')].map((row) =>
      row.getAttribute('data-run-id'),
    )
    expect(ids).toEqual(['newer', 'older'])
    // The mission's own title rides along, so a queue spanning several missions stays readable.
    expect(rowFor('newer')?.textContent).toContain('Ship the release')
    expect(rowFor('newer')?.querySelector('a')?.getAttribute('href')).toBe('/tasks/newer')
  })

  it('says so when nothing is waiting', async () => {
    renderGuard([run({ role: 'caesar', missionId: 'm1' }, { id: 'm1', status: 'running' })])
    await waitFor(() => expect(screen.getByText('Nothing is waiting for you.')).toBeTruthy())
  })

  it('explains itself instead of listing anything when the capability is off', async () => {
    renderGuard(
      [run({ role: 'caesar', missionId: 'm1' }, { id: 'm1', status: 'waiting' })],
      { units: false },
    )
    await waitFor(() => expect(screen.getByText('Missions are off')).toBeTruthy())
    expect(rowFor('m1')).toBeNull()
  })
})
