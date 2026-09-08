import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { NewMissionRoute, ladderRolesFor } from '@/routes/missions/new-mission'

/**
 * The mission composer (spec `2026-09-08-units-hierarchy` §Cockpit): the size decides which
 * ranks the mission places, and therefore which ladder rows are worth showing — and Start posts
 * exactly what the user filled in, with nothing invented for the fields they left alone.
 */

let posted: Array<{ url: string; body: unknown }> = []
const fetchMock = vi.fn<typeof fetch>()

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function renderComposer(units = true) {
  posted = []
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (method === 'POST') posted.push({ url, body: JSON.parse(String(init?.body)) })
    if (url === '/api/v1/health') return json({ capabilities: { units } })
    if (url === '/api/v1/missions') return json({ id: 'mission-1' }, 201)
    if (url.startsWith('/api/v1/providers/status')) return json({ providers: [] })
    // A project whose configured default IS the runner the pickers resolve to — the ordinary
    // case, and the one where an untouched rung must put nothing on the wire. Without it
    // `runnerOverride` would (correctly) send the provider-status fallback explicitly, and these
    // assertions would be about that fallback rather than about the composer.
    if (url === '/api/v1/config') return json({ defaultRunner: 'claude' })
    return json({})
  })
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/missions/new']}>
        <LocationProbe />
        <Routes>
          <Route path="/missions/new" element={<NewMissionRoute />} />
          <Route path="*" element={null} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function LocationProbe() {
  const { pathname } = useLocation()
  return <output data-testid="location">{pathname}</output>
}

const ladderRoles = () =>
  [...document.querySelectorAll('[data-slot="mission-ladder-row"]')].map((row) =>
    row.getAttribute('data-role'),
  )
const sizeCard = (size: string) =>
  document.querySelector(`[data-slot="mission-size"][data-size="${size}"]`) as HTMLElement
const objective = () => document.querySelector('[data-slot="mission-objective"]') as HTMLElement
const start = () => screen.getByText('Start mission')

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

/** The pure half — which ranks a size places. Asserted on its own so the rendering test below is
 *  about the rows, not about the rule. */
describe('ladderRolesFor', () => {
  it('places the ranks each size actually creates', () => {
    expect(ladderRolesFor('army')).toEqual(['caesar', 'legate', 'centurion'])
    expect(ladderRolesFor('squad')).toEqual(['centurion'])
    expect(ladderRolesFor('legionary')).toEqual([])
  })
})

describe('NewMissionRoute', () => {
  it('opens on Army with a rung for every rank it places', async () => {
    renderComposer()
    await waitFor(() => expect(sizeCard('army')).not.toBeNull())
    expect(sizeCard('army').getAttribute('data-selected')).toBe('true')
    expect(ladderRoles()).toEqual(['caesar', 'legate', 'centurion'])
  })

  it('narrows the ladder to the centurion for a squad', async () => {
    renderComposer()
    await waitFor(() => expect(sizeCard('squad')).not.toBeNull())
    fireEvent.click(sizeCard('squad'))
    expect(ladderRoles()).toEqual(['centurion'])
  })

  it('drops the ladder entirely for a legionary, and says why', async () => {
    renderComposer()
    await waitFor(() => expect(sizeCard('legionary')).not.toBeNull())
    fireEvent.click(sizeCard('legionary'))
    expect(ladderRoles()).toEqual([])
    expect(screen.getByText('A plain task uses the composer defaults.')).toBeTruthy()
  })

  it('posts the objective, size, constraints and budget — and nothing the user left alone', async () => {
    renderComposer()
    await waitFor(() => expect(sizeCard('army')).not.toBeNull())

    fireEvent.change(objective(), { target: { value: 'Ship the release' } })
    const constraint = document.querySelector('[data-slot="mission-constraint-input"]') as HTMLElement
    fireEvent.change(constraint, { target: { value: 'never force-push' } })
    fireEvent.keyDown(constraint, { key: 'Enter' })
    fireEvent.change(constraint, { target: { value: 'tests must pass' } })
    fireEvent.keyDown(constraint, { key: 'Enter' })
    fireEvent.change(document.querySelector('[data-slot="mission-budget"]')!, {
      target: { value: '20' },
    })

    fireEvent.click(start())
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]?.url).toBe('/api/v1/missions')
    // The constraints go up as an ARRAY: composing them into a `## Constraints` block is the
    // server's job (`missionTask`), so both halves of the API agree on one spelling.
    expect(posted[0]?.body).toEqual({
      objective: 'Ship the release',
      unit: 'army',
      budgetUsd: 20,
      constraints: ['never force-push', 'tests must pass'],
    })
    // No `ladder` key at all — an untouched picker means "use the project's defaults", which is a
    // different request from naming them.
    expect(Object.keys(posted[0]?.body as object)).not.toContain('ladder')
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/missions'))
  })

  it('drops an added constraint when its chip is clicked', async () => {
    renderComposer()
    await waitFor(() => expect(sizeCard('army')).not.toBeNull())
    fireEvent.change(objective(), { target: { value: 'Ship it' } })
    const constraint = document.querySelector('[data-slot="mission-constraint-input"]') as HTMLElement
    fireEvent.change(constraint, { target: { value: 'never force-push' } })
    fireEvent.keyDown(constraint, { key: 'Enter' })
    fireEvent.click(document.querySelector('[data-slot="mission-constraints"] button')!)

    fireEvent.click(start())
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]?.body).toEqual({ objective: 'Ship it', unit: 'army' })
  })

  it('lands a legionary in its own thread — there is no tree to look at', async () => {
    renderComposer()
    await waitFor(() => expect(sizeCard('legionary')).not.toBeNull())
    fireEvent.click(sizeCard('legionary'))
    fireEvent.change(objective(), { target: { value: 'One small thing' } })
    fireEvent.click(start())
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]?.body).toEqual({ objective: 'One small thing', unit: 'legionary' })
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/tasks/mission-1'))
  })

  it('refuses to start on an empty objective', async () => {
    renderComposer()
    await waitFor(() => expect(sizeCard('army')).not.toBeNull())
    expect((start() as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(start())
    expect(posted).toHaveLength(0)
  })

  it('explains itself instead of rendering a form when the capability is off', async () => {
    renderComposer(false)
    await waitFor(() => expect(screen.getByText('Missions are off')).toBeTruthy())
    expect(document.querySelector('[data-slot="new-mission"]')).toBeNull()
  })
})
