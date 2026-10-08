import { describe, expect, it } from 'vitest'
import type { WaitEdge } from '@open-mercato/cezar-api-client'
import { pendingWaits, timeLeftLabel, waitCandidates, waitTargetPath } from './waits'
import { deriveAttention } from './attention'

const edge = (over: Partial<WaitEdge> = {}): WaitEdge => ({
  id: 'w',
  target: { projectId: 'api', runId: 'run-1' },
  targetTitle: 'Add export',
  origin: 'agent',
  createdAt: '2026-10-05T10:00:00.000Z',
  deadline: '2026-10-06T10:00:00.000Z',
  state: 'pending',
  ...over,
})

describe('cross-task waits — the pure half (spec 2026-10-05-cross-task-waits)', () => {
  it('keeps only pending edges', () => {
    expect(pendingWaits({ waits: [edge({ id: 'a' }), edge({ id: 'b', state: 'settled' })] }).map((e) => e.id)).toEqual(['a'])
    expect(pendingWaits({})).toEqual([])
  })

  it('links a target in the active project flat, and one elsewhere through its own /p/ scope', () => {
    expect(waitTargetPath(edge(), 'api')).toBe('/tasks/run-1')
    expect(waitTargetPath(edge(), 'web')).toBe('/p/api/tasks/run-1')
    // The boot project goes by three names: unscoped, `default`, and its registry id.
    expect(waitTargetPath(edge({ target: { projectId: 'default', runId: 'r' } }), null, 'web')).toBe('/tasks/r')
    expect(waitTargetPath(edge({ target: { projectId: 'web', runId: 'r' } }), null, 'web')).toBe('/tasks/r')
    expect(waitTargetPath(edge({ target: { projectId: 'default', runId: 'r' } }), 'web', 'web')).toBe('/tasks/r')
    expect(waitTargetPath(edge({ target: { projectId: 'default', runId: 'r' } }), 'api', 'web')).toBe('/p/default/tasks/r')
  })

  it('says how long is left, coarsely', () => {
    const now = Date.parse('2026-10-05T10:00:00.000Z')
    expect(timeLeftLabel('2026-10-06T09:00:00.000Z', now)).toBe('23 h')
    expect(timeLeftLabel('2026-10-05T10:12:00.000Z', now)).toBe('12 min')
    expect(timeLeftLabel('2026-10-08T10:00:00.000Z', now)).toBe('3 days')
    expect(timeLeftLabel('2026-10-05T09:00:00.000Z', now)).toBe('a moment')
    expect(timeLeftLabel('nonsense', now)).toBe('a moment')
  })

  it('offers unsettled runs other than the waiter, newest first, matched on title or id prefix', () => {
    const runs = [
      { id: 'aaaa', title: 'Old running', status: 'running' as const, createdAt: '2026-10-01' },
      { id: 'bbbb', title: 'Newer queued', titleSummary: 'Queued export', status: 'queued' as const, createdAt: '2026-10-03' },
      { id: 'cccc', title: 'Finished', status: 'done' as const, createdAt: '2026-10-04' },
      { id: 'me00', title: 'Me', status: 'running' as const, createdAt: '2026-10-05' },
    ]
    expect(waitCandidates(runs, 'me00', '').map((r) => r.id)).toEqual(['bbbb', 'aaaa'])
    expect(waitCandidates(runs, 'me00', 'export').map((r) => r.id)).toEqual(['bbbb'])
    expect(waitCandidates(runs, 'me00', 'AAA').map((r) => r.id)).toEqual(['aaaa'])
    expect(waitCandidates(runs, null, 'me').map((r) => r.id)).toEqual(['me00'])
  })

  it('names a monitor parked on another task for what it is doing', () => {
    expect(deriveAttention({ status: 'running', activity: 'monitoring', waits: [edge()] }).label).toBe('waiting on a task')
    expect(deriveAttention({ status: 'running', activity: 'monitoring', waits: [edge({ state: 'settled' })] }).label).toBe('monitoring')
  })
})
