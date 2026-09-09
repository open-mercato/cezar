import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ApiRun, Capabilities, RunUnit } from '@open-mercato/cezar-api-client'
import { MissionsRoute } from '@/routes/missions/missions'

/**
 * The Missions page (spec `2026-09-08-units-hierarchy` §Cockpit): the tree it paints comes from
 * the run list alone, so these render against a stubbed `/api/v1/runs` and a stubbed health —
 * the two requests the page actually makes.
 */

const NOW = Date.parse('2026-09-08T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

let seq = 0
function run(unit: RunUnit | undefined, over: Partial<ApiRun> = {}): ApiRun {
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
    ...(unit ? { unit } : {}),
    ...over,
  } as ApiRun
}

const fetchMock = vi.fn<typeof fetch>()

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function renderMissions(runs: ApiRun[], capabilities: Partial<Capabilities> = { units: true }) {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input)
    if (url === '/api/v1/runs') return json(runs)
    if (url === '/api/v1/health') return json({ capabilities })
    return json([])
  })
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/missions']}>
        <LocationProbe />
        <Routes>
          <Route path="/missions" element={<MissionsRoute />} />
          <Route path="*" element={null} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** Where the router ended up — the row-click assertion reads it. */
function LocationProbe() {
  const { pathname } = useLocation()
  return <output data-testid="location">{pathname}</output>
}

const rowFor = (id: string) => document.querySelector(`[data-slot="mission-row"][data-run-id="${id}"]`)

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

describe('MissionsRoute', () => {
  it('paints one row per node, indented and ranked by depth', async () => {
    renderMissions([
      run({ role: 'caesar', missionId: 'm1' }, { id: 'm1', title: 'Ship the release' }),
      run({ role: 'legate', missionId: 'm1', parentRunId: 'm1' }, { id: 'a', title: 'Cut the notes' }),
      run(
        { role: 'centurion', missionId: 'm1', parentRunId: 'a' },
        { id: 'a1', title: 'Draft the changelog' },
      ),
    ])

    await waitFor(() => expect(rowFor('m1')).not.toBeNull())
    expect(rowFor('m1')?.getAttribute('data-depth')).toBe('0')
    expect(rowFor('a')?.getAttribute('data-depth')).toBe('1')
    expect(rowFor('a1')?.getAttribute('data-depth')).toBe('2')
    expect(rowFor('m1')?.getAttribute('data-role')).toBe('caesar')
    expect(rowFor('a1')?.getAttribute('data-role')).toBe('centurion')
    // The rank chips read as their display names, not as the enum spelling.
    expect(rowFor('m1')?.querySelector('[data-slot="unit-role"]')?.textContent).toBe('Commander')
  })

  it('leaves plain tasks out — a run with no unit is not a one-node mission', async () => {
    renderMissions([
      run({ role: 'caesar', missionId: 'm1' }, { id: 'm1', title: 'Ship the release' }),
      run(undefined, { id: 'flat', title: 'Just a task' }),
    ])
    await waitFor(() => expect(rowFor('m1')).not.toBeNull())
    expect(rowFor('flat')).toBeNull()
    expect(screen.queryByText('Just a task')).toBeNull()
  })

  it('collapses a subtree behind its chevron, and reopens it', async () => {
    renderMissions([
      run({ role: 'caesar', missionId: 'm1' }, { id: 'm1', title: 'Ship the release' }),
      run({ role: 'legate', missionId: 'm1', parentRunId: 'm1' }, { id: 'a', title: 'Cut the notes' }),
    ])
    await waitFor(() => expect(rowFor('a')).not.toBeNull())

    const toggle = rowFor('m1')?.querySelector('[data-action="mission-toggle"]') as HTMLElement
    fireEvent.click(toggle)
    expect(rowFor('a')).toBeNull()
    fireEvent.click(toggle)
    expect(rowFor('a')).not.toBeNull()
  })

  it('opens the run thread when a row is clicked', async () => {
    renderMissions([run({ role: 'caesar', missionId: 'm1' }, { id: 'm1', title: 'Ship it' })])
    await waitFor(() => expect(rowFor('m1')).not.toBeNull())
    fireEvent.click(rowFor('m1')!)
    expect(screen.getByTestId('location').textContent).toBe('/tasks/m1')
  })

  it('raises the Guard banner when a unit run is waiting, at any depth', async () => {
    renderMissions([
      run({ role: 'caesar', missionId: 'm1' }, { id: 'm1', status: 'running' }),
      run(
        { role: 'centurion', missionId: 'm1', parentRunId: 'm1' },
        { id: 'asking', status: 'waiting' },
      ),
    ])
    await waitFor(() => expect(document.querySelector('[data-slot="guard-banner"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="guard-banner"]')?.textContent).toContain(
      '1 action is waiting for the Guard',
    )
  })

  it('says nothing about the Guard when nothing is waiting', async () => {
    renderMissions([run({ role: 'caesar', missionId: 'm1' }, { id: 'm1', status: 'running' })])
    await waitFor(() => expect(rowFor('m1')).not.toBeNull())
    expect(document.querySelector('[data-slot="guard-banner"]')).toBeNull()
  })

  it('renders the budget meter against the ceiling, and the spend alone without one', async () => {
    renderMissions([
      run({ role: 'caesar', missionId: 'm1', budgetUsd: 20 }, { id: 'm1', costUsd: 15 }),
      run({ role: 'legate', missionId: 'm1', parentRunId: 'm1' }, { id: 'free', costUsd: 1 }),
    ])
    await waitFor(() => expect(rowFor('m1')).not.toBeNull())
    const capped = rowFor('m1')?.querySelector('[data-slot="mission-budget"]')
    // `formatCost`'s own rule: cents stop mattering at $10, so this reads `$15`, not `$15.00`.
    expect(capped?.textContent).toContain('$15 / $20')
    // 75 % is past the amber threshold but not over — the meter says pending, never danger.
    expect(capped?.getAttribute('data-tone')).toBe('pending')
    const uncapped = rowFor('free')?.querySelector('[data-slot="mission-budget"]')
    expect(uncapped?.textContent).toBe('$1.00')
    expect(uncapped?.getAttribute('data-tone')).toBeNull()
  })

  it('explains itself instead of rendering a tree when the capability is off', async () => {
    renderMissions([run({ role: 'caesar', missionId: 'm1' }, { id: 'm1' })], { units: false })
    await waitFor(() => expect(screen.getByText('Missions are off')).toBeTruthy())
    expect(document.querySelector('[data-slot="missions-table"]')).toBeNull()
    expect(rowFor('m1')).toBeNull()
  })

  it('offers the composer from the empty state', async () => {
    renderMissions([])
    await waitFor(() => expect(screen.getByText('No missions yet')).toBeTruthy())
    expect(screen.getAllByText('New mission').length).toBeGreaterThan(0)
  })
})
