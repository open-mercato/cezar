import { describe, expect, it } from 'vitest'
import {
  dashboardTransition,
  dashboardTruth,
  dashboardTruthRevision,
  reconcileDashboardTruth,
} from './dashboard-truth'
import { compareFeedRows } from './dashboard'
describe('dashboard reconciliation', () => {
  it('retains deletion tombstones without positive identity proof and preserves newer frames', () => {
    dashboardTransition('project', 'deleted')
    dashboardTransition('project', { id: 'done', status: 'done', archived: false })
    const revision = dashboardTruthRevision()
    dashboardTransition('project', { id: 'newer', status: 'running', archived: false })
    reconcileDashboardTruth(revision)
    expect(dashboardTruth('project', 'deleted')).toBeNull()
    reconcileDashboardTruth(revision, [{ projectId: 'project', id: 'deleted' }])
    expect(dashboardTruth('project', 'deleted')).toBeUndefined()
    expect(dashboardTruth('project', 'done')?.status).toBe('done')
    expect(dashboardTruth('project', 'newer')?.status).toBe('running')
  })
  it('sorts timestamp values instead of ISO spelling', () => {
    const older = { key: 'github', at: '2026-09-18T12:00:00Z' }
    const newer = { key: 'task', at: '2026-09-18T12:00:00.500Z' }
    expect([older, newer].sort(compareFeedRows)).toEqual([newer, older])
  })
})

it('reconciles an existing transition only with the same identity and current fields', () => {
  dashboardTransition('reconcile', { id: 'task', status: 'running', archived: false })
  const revision = dashboardTruthRevision()
  reconcileDashboardTruth(revision, [{ projectId: 'elsewhere', id: 'task' }])
  expect(dashboardTruth('reconcile', 'task')?.status).toBe('running')
  reconcileDashboardTruth(revision, [
    { projectId: 'reconcile', id: 'task', status: 'done', archived: true },
  ])
  expect(dashboardTruth('reconcile', 'task')).toEqual({ status: 'done', archived: true })
})

it.each(['running', 'done'] as const)('does not replay historical rows over a fresh %s confirmation', (status) => {
  const project = `confirmation-${status}`
  dashboardTransition(project, { id: 'task', status: 'running', archived: false })
  const captured = dashboardTruthRevision()
  reconcileDashboardTruth(captured, [{ projectId: project, id: 'task', status, archived: false }])
  reconcileDashboardTruth(captured, [{ projectId: project, id: 'task', status: 'failed', archived: false }])
  expect(dashboardTruth(project, 'task')?.status).toBe(status)
})
