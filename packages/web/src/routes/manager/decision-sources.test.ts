import { describe, expect, it } from 'vitest'
import type { ManagerMessage } from '@open-mercato/cezar-api-client'

import { cardSources } from './decision-sources'

type Runs = Parameters<typeof cardSources>[1]

const row = (id: string, extra: Record<string, unknown> = {}) => ({
  projectId: 'acme',
  id,
  archived: false,
  createdAt: '2026-11-18T12:00:00.000Z',
  ...extra,
})

const mergeCard = (number: number, sourceTasks: Array<{ projectId: string; runId: string }>, reason?: string): ManagerMessage => ({
  id: `card-${number}`,
  seq: number,
  at: '2026-11-18T12:00:00.000Z',
  kind: 'action',
  status: 'pending',
  action: { type: 'merge-pr', projectId: 'acme', number },
  sourceTasks,
  ...(reason ? { reason } : {}),
}) as ManagerMessage

describe('cardSources', () => {
  // Two cards a turn proposed in a row, both stored with the task the turn had read (#2310 report).
  const runs = [
    row('auto-review', { markerRefs: { pr: 8251 } }),
    row('owner', { pullRequestUrl: 'https://github.com/o/r/pull/9783' }),
  ] as unknown as Runs
  const unrelated = [{ projectId: 'acme', runId: 'auto-review' }]

  it('drops a stored source that does not carry the merge card\'s PR', () => {
    expect(cardSources(mergeCard(9800, unrelated), runs, [])).toEqual([])
    expect(cardSources(mergeCard(9783, [...unrelated, { projectId: 'acme', runId: 'owner' }]), runs, [])).toEqual([{ projectId: 'acme', runId: 'owner' }])
  })

  it('drops a task the reason names unless it carries the PR', () => {
    expect(cardSources(mergeCard(9800, [], 'Seen in [[task:acme/auto-review]]'), runs, [])).toEqual([])
    expect(cardSources(mergeCard(9783, [], 'See [[task:acme/owner]]'), runs, [])).toEqual([{ projectId: 'acme', runId: 'owner' }])
  })

  it('shows none until the runs index loads, and leaves other cards alone', () => {
    expect(cardSources(mergeCard(9783, [{ projectId: 'acme', runId: 'owner' }]), undefined, [])).toEqual([])
    const enable = { ...mergeCard(1, unrelated), action: { type: 'enable-automation', projectId: 'acme', automationId: 'a1' } } as ManagerMessage
    expect(cardSources(enable, runs, [])).toEqual(unrelated)
  })
})
