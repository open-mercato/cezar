import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { workspaceQueryKeys } from '@/api/queries'
import type { ProjectsResponse, WorkspaceLastLocation } from '@open-mercato/cezar-api-client'
import { LAST_LOCATION_STORAGE_KEY } from '@/lib/last-location'
import { LastLocationController } from './last-location-controller'
import { resetSettingsReturn, settingsReturnLocation } from '@/lib/settings-return'

const REGISTRY: ProjectsResponse = {
  bootProject: 'boot',
  projectsDir: '/work',
  projects: [
    {
      id: 'boot',
      name: 'Boot',
      root: '/work/boot',
      addedAt: '2026-07-29T10:00:00.000Z',
      lastOpenedAt: '2026-07-29T10:00:00.000Z',
      source: 'local',
      status: 'ok',
    },
    {
      id: 'other',
      name: 'Other',
      root: '/work/other',
      addedAt: '2026-07-29T10:00:00.000Z',
      lastOpenedAt: '2026-07-29T10:00:00.000Z',
      source: 'local',
      status: 'not-git',
    },
    {
      id: 'gone',
      name: 'Gone',
      root: '/work/gone',
      addedAt: '2026-07-29T10:00:00.000Z',
      lastOpenedAt: '2026-07-29T10:00:00.000Z',
      source: 'local',
      status: 'missing',
    },
  ],
}

let clients: QueryClient[] = []

function NavigationControls() {
  const navigate = useNavigate()
  return (
    <>
      <button onClick={() => navigate('/p/boot/tasks/middle')}>Middle</button>
      <button onClick={() => navigate('/p/other/tasks/final?tab=events#tool-3')}>Final</button>
      <button onClick={() => navigate('/settings/global/appearance')}>Global settings</button>
      <button onClick={() => navigate('/p/boot/settings/agents')}>Project settings</button>
    </>
  )
}

function mount(entry: string) {
  const client = createQueryClient()
  clients.push(client)
  client.setQueryData(workspaceQueryKeys.projects, REGISTRY)
  const rendered = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <LastLocationController />
        <NavigationControls />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { client, ...rendered }
}

function stored(): unknown {
  const raw = localStorage.getItem(LAST_LOCATION_STORAGE_KEY)
  return raw === null ? null : JSON.parse(raw)
}

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => {})))
})

afterEach(() => {
  cleanup()
  for (const client of clients) client.clear()
  clients = []
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('LastLocationController', () => {
  it('feeds the settings return store with every NON-settings location (unified settings)', () => {
    resetSettingsReturn()
    mount('/p/boot/git')
    expect(settingsReturnLocation()).toEqual({ pathname: '/p/boot/git', search: '', hash: '' })
    // A settings page is never a way back — the previous page stays recorded across it.
    fireEvent.click(screen.getByText('Global settings'))
    expect(settingsReturnLocation()?.pathname).toBe('/p/boot/git')
    fireEvent.click(screen.getByText('Project settings'))
    expect(settingsReturnLocation()?.pathname).toBe('/p/boot/git')
  })

  it('remembers a valid scoped URL exactly, in this browser', () => {
    mount('/p/boot/tasks/run-1/changes?file=src%2Findex.ts#L12')

    expect(stored()).toEqual({
      projectId: 'boot',
      pathname: '/p/boot/tasks/run-1/changes',
      search: '?file=src%2Findex.ts',
      hash: '#L12',
    })
  })

  it('keeps the settled final location after rapid navigation', () => {
    mount('/p/boot/')

    fireEvent.click(screen.getByRole('button', { name: 'Middle' }))
    fireEvent.click(screen.getByRole('button', { name: 'Final' }))

    expect(stored()).toEqual({
      projectId: 'other',
      pathname: '/p/other/tasks/final',
      search: '?tab=events',
      hash: '#tool-3',
    })
  })

  it('does not rewrite an unchanged remembered location', () => {
    const lastLocation: WorkspaceLastLocation = {
      projectId: 'boot',
      pathname: '/p/boot/tasks/run-1',
    }
    localStorage.setItem(LAST_LOCATION_STORAGE_KEY, JSON.stringify(lastLocation))
    const setItem = vi.spyOn(Storage.prototype, 'setItem')

    mount('/p/boot/tasks/run-1')

    expect(setItem).not.toHaveBeenCalled()
    expect(stored()).toEqual(lastLocation)
  })

  it.each([
    ['an unscoped route', '/tasks/run-1'],
    ['global settings', '/settings/global/appearance'],
    ['an unknown project', '/p/unknown/tasks/run-1'],
    ['a missing project', '/p/gone/tasks/run-1'],
  ])('does not overwrite the remembered location from %s', (_case, entry) => {
    const kept: WorkspaceLastLocation = { projectId: 'boot', pathname: '/p/boot/git' }
    localStorage.setItem(LAST_LOCATION_STORAGE_KEY, JSON.stringify(kept))

    mount(entry)

    expect(stored()).toEqual(kept)
  })

  it('replaces a corrupted stored value with the current location', () => {
    localStorage.setItem(LAST_LOCATION_STORAGE_KEY, 'not json')

    mount('/p/boot/tasks/run-1')

    expect(stored()).toEqual({ projectId: 'boot', pathname: '/p/boot/tasks/run-1' })
  })

  it('does not write before the registry can validate the project', () => {
    const client = createQueryClient()
    clients.push(client)
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/p/boot/tasks/run-1']}>
          <LastLocationController />
        </MemoryRouter>
      </QueryClientProvider>,
    )

    expect(stored()).toBeNull()
  })
})
