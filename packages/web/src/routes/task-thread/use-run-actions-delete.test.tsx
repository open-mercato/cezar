import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ApiRun } from '@open-mercato/cezar-api-client'

import { useRunActions } from './use-run-actions'

const run: ApiRun = {
  id: 'r1', title: 'Demo task', task: 'Demo', workflow: 'quick-task', status: 'done',
  createdAt: '2026-10-30T10:00:00Z', tokensUsed: 0, archived: false, steps: [],
}
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useRunActions — delete', () => {
  it('leaves a deleted task for the tasks table, not the Now home', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({})))
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={['/p/demo/tasks/r1']}>{children}</MemoryRouter>
      </QueryClientProvider>
    )
    const hook = renderHook(() => ({ actions: useRunActions(run), location: useLocation() }), { wrapper })
    act(() => hook.result.current.actions.delete.mutate())
    await waitFor(() => expect(hook.result.current.location.pathname).toBe('/p/demo/tasks'))
  })
})
