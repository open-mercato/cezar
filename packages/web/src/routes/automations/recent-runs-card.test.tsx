import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ApiRun, AutomationLogRecord, AutomationLogResponse } from '@open-mercato/cezar-api-client'
import { ProjectScopeProvider } from '@/api/project-scope-context'
import { createQueryClient } from '@/api/query-client'
import { queryKeys } from '@/api/queries'

import { RecentRunsCard } from './recent-runs-card'

let emit: ((name: string, payload: unknown) => void) | null = null
vi.mock('@/api/global-events', () => ({
  onWorkspaceEvent: (listener: typeof emit) => {
    emit = listener
    return () => { emit = null }
  },
}))

const NOW = Date.parse('2026-10-30T12:00:00Z')
const row = (seq: number, runId?: string, result: AutomationLogRecord['result'] = 'launched'): AutomationLogRecord => ({
  seq, ts: '2026-10-30T10:00:00Z', automationId: 'a1', revision: 1, result,
  ...(runId ? { runId } : {}),
})
const log: AutomationLogResponse = {
  records: [row(4, 'r3', 'manual'), row(3, undefined, 'skipped'), row(2, 'r2', 'catch-up'), row(1, 'r1')],
  runs: {
    r3: { title: 'Newest task', status: 'running', costUsd: 0.42, children: [] },
    r2: { title: 'Catch up task', status: 'review', children: [] },
    r1: { title: 'Oldest task', status: 'failed', children: [] },
  },
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function stubLog(response: () => Response | Promise<Response> = () => json(log)) {
  const paths: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    paths.push(path)
    if (path.includes('/automation-log?')) return response()
    if (path.endsWith('/runs')) return json([])
    return json({ error: 'unexpected request' }, 404)
  }))
  return paths
}

function mount(props: Partial<Parameters<typeof RecentRunsCard>[0]> = {}, projectId: string | null = null) {
  const client = createQueryClient()
  client.setDefaultOptions({ queries: { retry: false } })
  const onLog = vi.fn()
  const onRunNow = vi.fn()
  const utils = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[projectId ? `/p/${projectId}/automations/a1` : '/automations/a1']}>
        <ProjectScopeProvider projectId={projectId}>
          <RecentRunsCard automationId="a1" onLog={onLog} onRunNow={onRunNow} now={NOW} {...props} />
        </ProjectScopeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { ...utils, client, onLog, onRunNow }
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('RecentRunsCard (#1623)', () => {
  it('shows launched tasks newest first with statuses, ages, task links and existing cost policy', async () => {
    stubLog()
    mount()
    const list = await screen.findByRole('list', { name: 'Recent runs' })
    const links = within(list).getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual(['Newest task', 'Catch up task', 'Oldest task'])
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/tasks/r3', '/tasks/r2', '/tasks/r1'])
    expect(within(list).getByText('running')).not.toBeNull()
    expect(within(list).getByText('needs review')).not.toBeNull()
    expect(within(list).getByText('failed')).not.toBeNull()
    expect(within(list).getAllByText('2h')).toHaveLength(3)
    expect(list.querySelector('time')?.getAttribute('dateTime')).toBe('2026-10-30T10:00:00Z')
    expect(screen.queryByText('$0.42')).toBeNull()
  })

  it('filters before capping, deduplicates task IDs and sorts by sequence without mutating the response', async () => {
    const records = [...Array.from({ length: 9 }, (_, i) => row(i + 1, `r${i + 1}`)), row(10, 'r9'), ...Array.from({ length: 8 }, (_, i) => row(i + 11, undefined, 'preview'))]
    stubLog(() => json({ records, runs: {} }))
    mount()
    await screen.findByRole('list')
    expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(['/tasks/r9', '/tasks/r8', '/tasks/r7', '/tasks/r6', '/tasks/r5'])
    expect(records[0]?.seq).toBe(1)
    expect(screen.getAllByText('Status unavailable')).toHaveLength(5)
    expect(screen.getByRole('link', { name: 'Task r9' })).not.toBeNull()
  })

  it('keeps actions available while loading, empty and busy', async () => {
    let finish!: (response: Response) => void
    stubLog(() => new Promise<Response>((resolve) => { finish = resolve }))
    const { onLog, onRunNow } = mount({ busy: true })
    expect(screen.getByRole('status').textContent).toBe('Loading recent runs…')
    expect((screen.getByRole('button', { name: 'Run now' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'View log' }))
    expect(onLog).toHaveBeenCalledOnce()
    expect(onRunNow).not.toHaveBeenCalled()
    finish(json({ records: [row(1, undefined, 'failed')], runs: {} }))
    expect(await screen.findByText('No runs launched yet.')).not.toBeNull()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('wires Run now and hides actions without handlers', async () => {
    stubLog()
    const { onRunNow } = mount({ onLog: undefined })
    await screen.findByRole('list')
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }))
    expect(onRunNow).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'View log' })).toBeNull()
  })

  it('shows permission/load errors, preserves actions and retries successfully', async () => {
    let failed = true
    stubLog(() => failed ? json({ error: 'Forbidden' }, 403) : json(log))
    mount()
    expect(await screen.findByRole('alert')).not.toBeNull()
    expect(screen.getByText('Could not load recent runs.')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'View log' })).not.toBeNull()
    failed = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('list')).not.toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('retains cached rows on refresh failure and cleans up its matching-event subscription', async () => {
    let failed = false
    const paths = stubLog(() => failed ? json({ error: 'Offline' }, 503) : json(log))
    const { unmount } = mount()
    await screen.findByRole('list')
    const before = paths.filter((path) => path.includes('automation-log')).length
    act(() => emit?.('automation-change', { automationId: 'other' }))
    expect(paths.filter((path) => path.includes('automation-log'))).toHaveLength(before)
    failed = true
    act(() => emit?.('automation-change', { automationId: 'a1' }))
    expect(await screen.findByText('Could not refresh recent runs.')).not.toBeNull()
    expect(screen.getByRole('link', { name: 'Newest task' })).not.toBeNull()
    unmount()
    expect(emit).toBeNull()
  })

  it('keeps requests and links project-scoped and ignores another project’s event', async () => {
    const paths = stubLog()
    mount({}, 'project-a')
    await screen.findByRole('list')
    expect(paths.some((path) => path === '/api/v1/p/project-a/automation-log?automationId=a1')).toBe(true)
    expect(screen.getByRole('link', { name: 'Newest task' }).getAttribute('href')).toBe('/p/project-a/tasks/r3')
    const before = paths.length
    act(() => emit?.('automation-change', { automationId: 'a1', project: 'project-b' }))
    expect(paths).toHaveLength(before)
    act(() => emit?.('automation-change', { automationId: 'a1', project: 'project-a' }))
    await waitFor(() => expect(paths.length).toBeGreaterThan(before))
  })

  it('uses the shared SSE-patched run cache for current status without a log poll', async () => {
    const paths = stubLog()
    const { client } = mount()
    await screen.findByText('running')
    const before = paths.filter((path) => path.includes('automation-log')).length
    act(() => client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [{ id: 'r3', title: 'Newest task updated', status: 'done' } as ApiRun]))
    expect(await screen.findByText('done')).not.toBeNull()
    expect(screen.getByRole('link', { name: 'Newest task updated' })).not.toBeNull()
    expect(paths.filter((path) => path.includes('automation-log'))).toHaveLength(before)
  })
})
