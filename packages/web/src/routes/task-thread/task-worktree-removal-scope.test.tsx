import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setApiScope, type ApiRun } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { useRunActions } from './use-run-actions'

const run: ApiRun = { id: 'cloned-run', title: 'Demo task', task: 'Demo', workflow: 'quick-task', status: 'done',
  createdAt: '2026-10-30T10:00:00Z', tokensUsed: 0, archived: false, steps: [], worktreePath: '/private-demo/task' }
const operation = { id: 'demo-operation', worktreeId: 'demo-worktree', generation: 1, phase: 'teardown', state: 'queued' }
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
afterEach(() => { cleanup(); setApiScope(null); vi.unstubAllGlobals() })

function setup(delay: 'status' | 'operation') {
  setApiScope('project-a')
  const client = createQueryClient()
  client.setQueryData(['project-a', 'runs', 'detail', run.id], run)
  const other = { ...run, title: 'Other project clone' }
  client.setQueryData(['project-b', 'runs', 'detail', run.id], other)
  let release: (() => void) | undefined
  const posts: string[] = []
  let checked = false
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/git/status')) {
      checked = true
      if (delay === 'status') await new Promise<void>((resolve) => { release = resolve })
      return json({ uncommitted: 0, unpushed: null, ahead: 1, behind: 0 })
    }
    if (init?.method === 'POST' && url.endsWith('/worktree-lifecycle/operations')) {
      posts.push(url)
      if (delay === 'operation') await new Promise<void>((resolve) => { release = resolve })
      return json({ operation })
    }
    return json({})
  }))
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>
  const hook = renderHook(() => useRunActions(run), { wrapper })
  return { hook, client, other, posts, checked: () => checked, release: () => release?.() }
}

describe('worktree removal origin scope (#1600)', () => {
  it('keeps cleanup in its original project when navigation occurs during preflight', async () => {
    const { hook, posts, checked, release } = setup('status')
    act(() => { hook.result.current.removeWorktree.mutate() })
    await waitFor(() => expect(checked()).toBe(true))
    setApiScope('project-b')
    hook.rerender()
    await act(async () => release())
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts).toEqual(['/api/v1/p/project-a/worktree-lifecycle/operations'])
  })

  it('updates only the original record when the operation response follows navigation', async () => {
    const { hook, client, other, posts, release } = setup('operation')
    act(() => { hook.result.current.removeWorktree.mutate() })
    await waitFor(() => expect(posts).toHaveLength(1))
    setApiScope('project-b')
    hook.rerender()
    await act(async () => release())
    await waitFor(() => expect(hook.result.current.removeWorktree.isPending).toBe(false))
    expect(client.getQueryData(['project-b', 'runs', 'detail', run.id])).toBe(other)
    expect(client.getQueryData<ApiRun>(['project-a', 'runs', 'detail', run.id])?.worktreeLifecycle?.activeOperationId).toBe(operation.id)
  })

  it('does not carry a confirmation into another project with the same run id', () => {
    const { hook } = setup('status')
    act(() => hook.result.current.setWorktreeRemovalOpen(true))
    expect(hook.result.current.worktreeRemovalOpen).toBe(true)
    setApiScope('project-b')
    hook.rerender()
    expect(hook.result.current.worktreeRemovalOpen).toBe(false)
  })
})
