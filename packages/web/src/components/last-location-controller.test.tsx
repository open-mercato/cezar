import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { putWorkspaceUiState } from '@/api/client'
import { createQueryClient } from '@/api/query-client'
import { workspaceQueryKeys } from '@/api/queries'
import type {
  ProjectsResponse,
  WorkspaceLastLocation,
  WorkspaceUiState,
} from '@open-mercato/cezar-api-client'
import {
  LAST_LOCATION_WRITE_DEBOUNCE_MS,
  LastLocationController,
} from './last-location-controller'

vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  putWorkspaceUiState: vi.fn(),
}))

const putWorkspaceUiStateMock = vi.mocked(putWorkspaceUiState)

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
    </>
  )
}

function mount(entry: string, uiState: WorkspaceUiState = { appearance: { accent: 'violet' } }) {
  const client = createQueryClient()
  clients.push(client)
  client.setQueryData(workspaceQueryKeys.projects, REGISTRY)
  client.setQueryData(workspaceQueryKeys.uiState, uiState)
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

async function runDebounce() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(LAST_LOCATION_WRITE_DEBOUNCE_MS)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => {})))
  putWorkspaceUiStateMock.mockImplementation(async (patch) => patch)
})

afterEach(() => {
  cleanup()
  for (const client of clients) client.clear()
  clients = []
  putWorkspaceUiStateMock.mockReset()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('LastLocationController', () => {
  it('optimistically caches and then persists a valid scoped URL exactly', async () => {
    const { client } = mount('/p/boot/tasks/run-1/changes?file=src%2Findex.ts#L12')

    expect(client.getQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState)).toEqual({
      appearance: { accent: 'violet' },
      lastLocation: {
        projectId: 'boot',
        pathname: '/p/boot/tasks/run-1/changes',
        search: '?file=src%2Findex.ts',
        hash: '#L12',
      },
    })
    expect(putWorkspaceUiStateMock).not.toHaveBeenCalled()

    await runDebounce()

    expect(putWorkspaceUiStateMock).toHaveBeenCalledTimes(1)
    expect(putWorkspaceUiStateMock).toHaveBeenCalledWith({
      lastLocation: {
        projectId: 'boot',
        pathname: '/p/boot/tasks/run-1/changes',
        search: '?file=src%2Findex.ts',
        hash: '#L12',
      },
    })
  })

  it('coalesces rapid navigation into one write for the settled final location', async () => {
    mount('/p/boot/')

    fireEvent.click(screen.getByRole('button', { name: 'Middle' }))
    fireEvent.click(screen.getByRole('button', { name: 'Final' }))
    await runDebounce()

    expect(putWorkspaceUiStateMock).toHaveBeenCalledTimes(1)
    expect(putWorkspaceUiStateMock).toHaveBeenCalledWith({
      lastLocation: {
        projectId: 'other',
        pathname: '/p/other/tasks/final',
        search: '?tab=events',
        hash: '#tool-3',
      },
    })
  })

  it('does not write an unchanged remembered location', async () => {
    const lastLocation: WorkspaceLastLocation = {
      projectId: 'boot',
      pathname: '/p/boot/tasks/run-1',
    }
    mount('/p/boot/tasks/run-1', { lastLocation })

    await runDebounce()

    expect(putWorkspaceUiStateMock).not.toHaveBeenCalled()
  })

  it.each([
    ['an unscoped route', '/tasks/run-1'],
    ['global settings', '/settings/global/appearance'],
    ['an unknown project', '/p/unknown/tasks/run-1'],
    ['a missing project', '/p/gone/tasks/run-1'],
  ])('does not write %s', async (_case, entry) => {
    const { client } = mount(entry)

    await runDebounce()

    expect(putWorkspaceUiStateMock).not.toHaveBeenCalled()
    expect(client.getQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState)).toEqual({
      appearance: { accent: 'violet' },
    })
  })

  it('flushes the pending final location when unmounted', async () => {
    const { unmount } = mount('/p/other/tasks/run-9')

    await act(async () => {
      unmount()
    })

    expect(putWorkspaceUiStateMock).toHaveBeenCalledTimes(1)
    expect(putWorkspaceUiStateMock).toHaveBeenCalledWith({
      lastLocation: {
        projectId: 'other',
        pathname: '/p/other/tasks/run-9',
      },
    })
  })

  it('invalidates workspace state quietly when persistence fails', async () => {
    putWorkspaceUiStateMock.mockRejectedValueOnce(new Error('read-only home'))
    const { client } = mount('/p/boot/tasks/run-1')
    const invalidate = vi.spyOn(client, 'invalidateQueries')

    await runDebounce()

    expect(invalidate).toHaveBeenCalledWith({ queryKey: workspaceQueryKeys.uiState })
    expect(document.body.textContent).not.toContain('read-only home')
  })

  it('serializes writes so an older request cannot persist after the final location', async () => {
    const persisted: WorkspaceLastLocation[] = []
    let resolveFirst!: () => void
    putWorkspaceUiStateMock
      .mockImplementationOnce(
        (patch) =>
          new Promise((resolve) => {
            resolveFirst = () => {
              persisted.push(patch.lastLocation!)
              resolve({
                appearance: { accent: 'lime' },
                lastLocation: patch.lastLocation,
              })
            }
          }),
      )
      .mockImplementationOnce(async (patch) => {
        persisted.push(patch.lastLocation!)
        return patch
      })

    const { client } = mount('/p/boot/tasks/first')
    await runDebounce()

    fireEvent.click(screen.getByRole('button', { name: 'Final' }))
    await runDebounce()

    // The final candidate stays pending while the first request is active. Starting it now
    // would allow the slower first request to land last on disk.
    expect(putWorkspaceUiStateMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveFirst()
    })

    expect(putWorkspaceUiStateMock).toHaveBeenCalledTimes(2)
    expect(persisted).toEqual([
      { projectId: 'boot', pathname: '/p/boot/tasks/first' },
      {
        projectId: 'other',
        pathname: '/p/other/tasks/final',
        search: '?tab=events',
        hash: '#tool-3',
      },
    ])
    expect(client.getQueryData<WorkspaceUiState>(workspaceQueryKeys.uiState)).toEqual({
      lastLocation: {
        projectId: 'other',
        pathname: '/p/other/tasks/final',
        search: '?tab=events',
        hash: '#tool-3',
      },
    })
  })
})
