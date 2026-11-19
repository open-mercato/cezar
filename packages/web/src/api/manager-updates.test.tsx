import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { managerFixture } from '@/routes/manager/manager-fixtures'
import { managerKeys, useUpdateManager } from './managers'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('serializes rapid account selections so an earlier save cannot overwrite the final set', async () => {
  const client = new QueryClient()
  const agents = [{ runner: 'claude' as const, agentProfile: 'one' }, { runner: 'claude' as const, agentProfile: 'two' }, { runner: 'codex' as const, agentProfile: 'work' }]
  let release!: () => void
  const first = new Promise<void>((resolve) => { release = resolve })
  const bodies: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (_input, init: RequestInit) => {
    const body = JSON.parse(init.body as string)
    bodies.push(body)
    if (bodies.length === 1) await first
    return Response.json(managerFixture({ taskAgents: body.taskAgents }))
  }))
  client.setQueryData(managerKeys.list, { managers: [managerFixture()] })
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
  const { result } = renderHook(() => useUpdateManager('global'), { wrapper })
  let pending!: Promise<unknown[]>
  act(() => { pending = Promise.all([
    result.current.mutateAsync({ taskAgents: agents.slice(0, 1) }),
    result.current.mutateAsync({ taskAgents: agents }),
  ]) })
  await waitFor(() => expect(bodies).toHaveLength(1))
  await act(async () => { release(); await pending })
  expect(bodies).toEqual([{ taskAgents: agents.slice(0, 1) }, { taskAgents: agents }])
  expect(client.getQueryData(managerKeys.list)).toMatchObject({ managers: [{ taskAgents: agents }] })
})
