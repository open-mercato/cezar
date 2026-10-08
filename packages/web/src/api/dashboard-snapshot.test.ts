import { afterEach, expect, it, vi } from 'vitest'
import type { DashboardSnapshot, DashboardTaskRow } from '@open-mercato/cezar-api-client'
import { getDashboard, getDashboardTasks } from './dashboard'
import { dashboardTransition, dashboardTruth } from './dashboard-truth'

afterEach(() => vi.unstubAllGlobals())

function snapshot(id: string): DashboardSnapshot {
  const row: DashboardTaskRow = {
    projectId: id,
    id: 'task',
    title: 'Waiting task',
    status: 'waiting',
    archived: false,
    createdAt: '2026-09-25T00:00:00Z',
    workflow: 'quick',
  }
  return {
    snapshotId: id,
    asOf: row.createdAt,
    expiresAt: '2026-09-25T01:00:00Z',
    coverage: { projects: [] },
    counts: { questions: 1, reviews: 0, running: 0, monitoring: 0, queued: 0, scheduled: 0 },
    questions: { rows: [row], total: 1, nextOffset: null },
    reviews: { rows: [], total: 0, nextOffset: null },
  }
}

it('recovers a missed return to waiting when a fresh read reuses the snapshot ID', async () => {
  const answer = snapshot('reused-fresh-snapshot')
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(answer)))
  await getDashboard()
  dashboardTransition(answer.snapshotId, { id: 'task', status: 'running', archived: false })
  // The server returned to waiting without a delivered SSE frame, so its current
  // dashboard has the same content and snapshot ID as the initial read.
  await getDashboard()
  expect(dashboardTruth(answer.snapshotId, 'task')?.status).toBe('waiting')
})

it('keeps historical page revisions pinned when a fresh read reuses the snapshot ID', async () => {
  const answer = snapshot('reused-historical-snapshot')
  answer.counts.questions = 2
  answer.questions.total = 2
  answer.questions.nextOffset = 1
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
    Response.json(String(input).includes('/dashboard/tasks') ? {
      snapshotId: answer.snapshotId,
      asOf: answer.asOf,
      coverage: answer.coverage,
      page: {
        rows: [{ ...answer.questions.rows[0], id: 'paged-task' }],
        total: 2,
        nextOffset: null,
      },
    } : answer),
  ))
  await getDashboard()
  dashboardTransition(answer.snapshotId, { id: 'paged-task', status: 'running', archived: false })
  await getDashboard()
  await getDashboardTasks(answer.snapshotId, 'needs-you', 1)
  expect(dashboardTruth(answer.snapshotId, 'paged-task')?.status).toBe('running')
})

it('preserves a transition delivered while a fresh read is in flight', async () => {
  const answer = snapshot('in-flight-fresh-snapshot')
  let resolve!: (response: Response) => void
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((done) => { resolve = done })))
  const pending = getDashboard()
  dashboardTransition(answer.snapshotId, { id: 'task', status: 'running', archived: false })
  resolve(Response.json(answer))
  await pending
  expect(dashboardTruth(answer.snapshotId, 'task')?.status).toBe('running')
})
