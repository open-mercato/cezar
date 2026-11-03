import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setApiScope, type RunRecord } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { ListViewProvider } from '@/components/list-view'
import { TasksOverviewRoute } from './tasks-overview'

const stamp = '2026-10-30T12:00:00.000Z'
const run = (id: string): RunRecord => ({ id, title: id, task: id, workflow: 'default', status: 'done',
  createdAt: stamp, finishedAt: stamp, tokensUsed: 0, archived: false, steps: [] })
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
function select(id: string) {
  const node = document.querySelector(`[data-slot="task-table-row"][data-run-id="${id}"]`)
  if (!(node instanceof HTMLElement)) throw new Error(`Missing ${id}`)
  fireEvent.click(within(node).getByRole('checkbox'))
}
afterEach(() => { cleanup(); setApiScope(null); vi.unstubAllGlobals(); localStorage.clear() })

describe('Tasks action route integration (#1599)', () => {
  it('posts only selected ids to the explicit project and patches the list/detail caches', async () => {
    setApiScope('project-a')
    const client = createQueryClient()
    let list = [run('chosen'), run('untouched')]
    const posts: { url: string; body: unknown }[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) })
        list = list.map((r) => r.id === 'chosen' ? { ...r, archived: true } : r)
        return json(list[0])
      }
      if (url.endsWith('/runs')) return json(list)
      if (url.endsWith('/automations')) return json({ automations: [] })
      return json({})
    }))
    render(<QueryClientProvider client={client}><MemoryRouter><ListViewProvider><TasksOverviewRoute /></ListViewProvider></MemoryRouter></QueryClientProvider>)
    await waitFor(() => expect(document.querySelector('[data-run-id="chosen"]')).not.toBeNull())
    select('chosen')
    fireEvent.click(screen.getByRole('button', { name: 'Archive (1)' }))
    await waitFor(() => expect(screen.getByRole('status', { name: 'Task action status' }).textContent).toContain('1 succeeded'))
    expect(posts).toEqual([{ url: '/api/v1/p/project-a/runs/chosen/archive', body: { archived: true, surface: 'tasks_table' } }])
    expect(client.getQueryData<RunRecord>(['project-a', 'runs', 'detail', 'chosen'])?.archived).toBe(true)
    expect(client.getQueryData<RunRecord[]>(['project-a', 'runs', 'list'])?.find((r) => r.id === 'untouched')?.archived).toBe(false)
    expect(document.querySelector('[data-slot="task-table-row"][data-run-id="chosen"]')).toBeNull()
  })

  it('keeps a queued batch on its original project after navigation changes the global scope', async () => {
    setApiScope('project-a')
    const client = createQueryClient()
    const posts: string[] = []
    let release: (() => void) | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'POST') {
        posts.push(url)
        if (posts.length === 1) await new Promise<void>((resolve) => { release = resolve })
        return json({ ...run(url.includes('/one/') ? 'one' : 'two'), seenAt: stamp })
      }
      if (url.endsWith('/runs')) return json([run('one'), run('two')])
      if (url.endsWith('/automations')) return json({ automations: [] })
      return json({})
    }))
    const view = render(<QueryClientProvider client={client}><MemoryRouter><ListViewProvider><TasksOverviewRoute /></ListViewProvider></MemoryRouter></QueryClientProvider>)
    await waitFor(() => expect(document.querySelector('[data-run-id="one"]')).not.toBeNull())
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select displayed tasks' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mark read (2)' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    view.unmount()
    setApiScope('project-b')
    client.setQueryData(['project-b', 'runs', 'detail', 'one'], run('one'))
    await act(async () => release?.())
    await waitFor(() => expect(posts).toHaveLength(2))
    expect(posts).toEqual(['/api/v1/p/project-a/runs/one/read', '/api/v1/p/project-a/runs/two/read'])
    expect(client.getQueryData<RunRecord>(['project-b', 'runs', 'detail', 'one'])?.seenAt).toBeUndefined()
  })
})
