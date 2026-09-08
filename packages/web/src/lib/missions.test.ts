import { describe, expect, it } from 'vitest'

import type { ApiRun, RunUnit } from '@open-mercato/cezar-api-client'
import {
  budgetTone,
  buildMissionTrees,
  flattenMissions,
  guardCount,
  guardQueue,
  isUnitRun,
  missionUpdatedAt,
} from '@/lib/missions'

/**
 * The mission tree is the one piece of units logic the cockpit owns outright — the server
 * publishes no `/missions` read route, so if this grouping is wrong the whole feature is wrong
 * on screen while every server test still passes. Hence the spec's own requirement that it be a
 * pure function with tests.
 */

const NOW = Date.parse('2026-09-08T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

let seq = 0
function run(over: Partial<ApiRun> = {}): ApiRun {
  seq += 1
  return {
    id: `r${seq}`,
    title: `Task ${seq}`,
    workflow: 'quick-task',
    task: `task ${seq}`,
    status: 'running',
    createdAt: ago(60_000),
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  } as ApiRun
}

/** A run with a `unit`, spelled once so the cases below read as trees rather than as records. */
function unitRun(unit: RunUnit, over: Partial<ApiRun> = {}): ApiRun {
  return run({ unit, ...over })
}

describe('isUnitRun', () => {
  it('separates hierarchy runs from the flat ones that share the list', () => {
    const flat = run()
    const commander = unitRun({ role: 'caesar', missionId: 'm1' }, { id: 'm1' })
    expect(isUnitRun(flat)).toBe(false)
    expect(isUnitRun(commander)).toBe(true)
    // A plain task must never become a one-node mission: `legionary` exists precisely so a user
    // can say "no hierarchy for this one", and the server attaches no `unit` to it.
    expect(buildMissionTrees([flat])).toEqual([])
  })
})

describe('buildMissionTrees — grouping and nesting', () => {
  it('roots the parentless unit runs and nests the rest by parentRunId', () => {
    const runs = [
      unitRun({ role: 'centurion', missionId: 'm1', parentRunId: 'legate' }, { id: 'grunt' }),
      unitRun({ role: 'legate', missionId: 'm1', parentRunId: 'm1' }, { id: 'legate' }),
      unitRun({ role: 'caesar', missionId: 'm1' }, { id: 'm1' }),
    ]
    const [mission] = buildMissionTrees(runs)
    expect(mission?.missionId).toBe('m1')
    expect(mission?.root.role).toBe('caesar')
    expect(mission?.root.depth).toBe(0)
    expect(mission?.root.children.map((child) => child.run.id)).toEqual(['legate'])
    expect(mission?.root.children[0]?.depth).toBe(1)
    expect(mission?.root.children[0]?.children.map((child) => child.run.id)).toEqual(['grunt'])
    expect(mission?.root.children[0]?.children[0]?.depth).toBe(2)
    expect(mission?.nodeCount).toBe(3)
  })

  it('counts DIRECT children per node, not the whole subtree', () => {
    const runs = [
      unitRun({ role: 'caesar', missionId: 'm1' }, { id: 'm1' }),
      unitRun({ role: 'legate', missionId: 'm1', parentRunId: 'm1' }, { id: 'a' }),
      unitRun({ role: 'legate', missionId: 'm1', parentRunId: 'm1' }, { id: 'b' }),
      unitRun({ role: 'centurion', missionId: 'm1', parentRunId: 'a' }, { id: 'a1' }),
    ]
    const [mission] = buildMissionTrees(runs)
    expect(mission?.root.childCount).toBe(2)
    expect(mission?.nodeCount).toBe(4)
  })

  it('sorts siblings and missions newest first, on the age the Updated column prints', () => {
    const runs = [
      unitRun({ role: 'caesar', missionId: 'old' }, { id: 'old', createdAt: ago(90_000) }),
      unitRun({ role: 'caesar', missionId: 'new' }, { id: 'new', createdAt: ago(10_000) }),
      unitRun(
        { role: 'legate', missionId: 'new', parentRunId: 'new' },
        { id: 'child-old', createdAt: ago(9_000) },
      ),
      unitRun(
        { role: 'legate', missionId: 'new', parentRunId: 'new' },
        // `finishedAt` wins over `createdAt` in the ladder, which is what makes this the newest
        // sibling despite being created first.
        { id: 'child-new', createdAt: ago(50_000), finishedAt: ago(1_000) },
      ),
    ]
    const trees = buildMissionTrees(runs)
    expect(trees.map((tree) => tree.missionId)).toEqual(['new', 'old'])
    expect(trees[0]?.root.children.map((child) => child.run.id)).toEqual(['child-new', 'child-old'])
    expect(missionUpdatedAt(trees[0]!.root.children[0]!.run)).toBe(ago(1_000))
  })

  it('keeps the order total when two runs share an instant', () => {
    const at = ago(5_000)
    const runs = [
      unitRun({ role: 'caesar', missionId: 'b' }, { id: 'b', createdAt: at }),
      unitRun({ role: 'caesar', missionId: 'a' }, { id: 'a', createdAt: at }),
    ]
    expect(buildMissionTrees(runs).map((tree) => tree.missionId)).toEqual(['a', 'b'])
  })
})

describe('buildMissionTrees — orphans', () => {
  it('re-parents a child whose parent is missing onto its mission root', () => {
    const runs = [
      unitRun({ role: 'caesar', missionId: 'm1' }, { id: 'm1' }),
      // Its legate has been deleted; the centurion must not vanish with it.
      unitRun({ role: 'centurion', missionId: 'm1', parentRunId: 'gone' }, { id: 'orphan' }),
    ]
    const [mission] = buildMissionTrees(runs)
    expect(mission?.root.children.map((child) => child.run.id)).toEqual(['orphan'])
    expect(mission?.root.children[0]?.depth).toBe(1)
  })

  it('promotes an orphan to a root when its mission root is missing too', () => {
    const runs = [unitRun({ role: 'centurion', missionId: 'gone', parentRunId: 'alsoGone' }, { id: 'lost' })]
    const trees = buildMissionTrees(runs)
    expect(trees.map((tree) => tree.missionId)).toEqual(['lost'])
    expect(trees[0]?.root.depth).toBe(0)
  })

  it('survives a record that names itself as its own parent', () => {
    const runs = [unitRun({ role: 'caesar', missionId: 'self', parentRunId: 'self' }, { id: 'self' })]
    const trees = buildMissionTrees(runs)
    expect(trees).toHaveLength(1)
    expect(trees[0]?.root.children).toEqual([])
  })

  it('emits every node exactly once', () => {
    const runs = [
      unitRun({ role: 'caesar', missionId: 'm1' }, { id: 'm1' }),
      unitRun({ role: 'legate', missionId: 'm1', parentRunId: 'm1' }, { id: 'a' }),
      unitRun({ role: 'centurion', missionId: 'm1', parentRunId: 'a' }, { id: 'a1' }),
    ]
    const ids = flattenMissions(buildMissionTrees(runs)).map((node) => node.run.id)
    expect(ids).toEqual(['m1', 'a', 'a1'])
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('buildMissionTrees — roll-ups', () => {
  it('totals cost and budget across every node, root included', () => {
    const runs = [
      unitRun({ role: 'caesar', missionId: 'm1', budgetUsd: 20 }, { id: 'm1', costUsd: 1.5 }),
      unitRun(
        { role: 'legate', missionId: 'm1', parentRunId: 'm1', budgetUsd: 5 },
        { id: 'a', costUsd: 2 },
      ),
      unitRun({ role: 'centurion', missionId: 'm1', parentRunId: 'a' }, { id: 'a1', costUsd: 0.5 }),
    ]
    const [mission] = buildMissionTrees(runs)
    expect(mission?.totalCostUsd).toBeCloseTo(4)
    expect(mission?.totalBudgetUsd).toBe(25)
  })

  it('leaves the budget total absent when nothing in the tree declares one', () => {
    const runs = [unitRun({ role: 'caesar', missionId: 'm1' }, { id: 'm1', costUsd: 3 })]
    const [mission] = buildMissionTrees(runs)
    expect(mission?.totalBudgetUsd).toBeUndefined()
    expect(mission?.root.budgetRatio).toBeUndefined()
  })

  it('derives the per-node ratio, and answers a zero ceiling instead of dividing by it', () => {
    const runs = [
      unitRun({ role: 'caesar', missionId: 'm1', budgetUsd: 10 }, { id: 'm1', costUsd: 7.5 }),
      unitRun(
        { role: 'legate', missionId: 'm1', parentRunId: 'm1', budgetUsd: 0 },
        { id: 'spent', costUsd: 0.2 },
      ),
      unitRun({ role: 'legate', missionId: 'm1', parentRunId: 'm1', budgetUsd: 0 }, { id: 'idle' }),
    ]
    const [mission] = buildMissionTrees(runs)
    expect(mission?.root.budgetRatio).toBeCloseTo(0.75)
    const byId = new Map(flattenMissions([mission!]).map((node) => [node.run.id, node]))
    expect(byId.get('spent')?.budgetRatio).toBe(Number.POSITIVE_INFINITY)
    expect(byId.get('idle')?.budgetRatio).toBe(1)
  })

  it('rolls a waiting descendant up to the mission', () => {
    const runs = [
      unitRun({ role: 'caesar', missionId: 'm1' }, { id: 'm1', status: 'running' }),
      unitRun({ role: 'legate', missionId: 'm1', parentRunId: 'm1' }, { id: 'a', status: 'running' }),
      unitRun(
        { role: 'centurion', missionId: 'm1', parentRunId: 'a' },
        { id: 'deep', status: 'waiting' },
      ),
    ]
    const [mission] = buildMissionTrees(runs)
    expect(mission?.root.needsGuard).toBe(false)
    expect(mission?.needsGuard).toBe(true)
  })

  it('leaves a mission with nothing waiting alone', () => {
    const runs = [
      unitRun({ role: 'caesar', missionId: 'm1' }, { id: 'm1', status: 'done' }),
      unitRun({ role: 'legate', missionId: 'm1', parentRunId: 'm1' }, { id: 'a', status: 'review' }),
    ]
    expect(buildMissionTrees(runs)[0]?.needsGuard).toBe(false)
  })

  it('carries the canonical attention derivation onto every node', () => {
    const runs = [unitRun({ role: 'caesar', missionId: 'm1' }, { id: 'm1', status: 'waiting' })]
    const [mission] = buildMissionTrees(runs)
    expect(mission?.root.attention).toMatchObject({ tone: 'pending', label: 'needs you', pulse: true })
  })
})

describe('guardQueue', () => {
  it('is every waiting node across every mission, newest first, with its mission', () => {
    const runs = [
      unitRun({ role: 'caesar', missionId: 'm1' }, { id: 'm1', createdAt: ago(80_000) }),
      unitRun(
        { role: 'legate', missionId: 'm1', parentRunId: 'm1' },
        { id: 'older-ask', status: 'waiting', createdAt: ago(60_000) },
      ),
      unitRun({ role: 'caesar', missionId: 'm2' }, { id: 'm2', createdAt: ago(40_000) }),
      unitRun(
        { role: 'centurion', missionId: 'm2', parentRunId: 'm2' },
        { id: 'newer-ask', status: 'waiting', createdAt: ago(20_000) },
      ),
    ]
    const trees = buildMissionTrees(runs)
    expect(guardQueue(trees).map(({ node }) => node.run.id)).toEqual(['newer-ask', 'older-ask'])
    expect(guardQueue(trees).map(({ mission }) => mission.missionId)).toEqual(['m2', 'm1'])
    expect(guardCount(trees)).toBe(2)
  })

  it('is empty when nothing is parked — including for a run that merely wants review', () => {
    const runs = [
      unitRun({ role: 'caesar', missionId: 'm1' }, { id: 'm1', status: 'review' }),
      unitRun({ role: 'legate', missionId: 'm1', parentRunId: 'm1' }, { id: 'a', status: 'failed' }),
    ]
    expect(guardQueue(buildMissionTrees(runs))).toEqual([])
    expect(guardCount(buildMissionTrees(runs))).toBe(0)
  })
})

describe('budgetTone', () => {
  const cases: Array<[ratio: number | undefined, tone: string]> = [
    [undefined, 'success'],
    [0, 'success'],
    [0.69, 'success'],
    [0.7, 'pending'],
    [1, 'pending'],
    [1.0001, 'danger'],
    [Number.POSITIVE_INFINITY, 'danger'],
  ]
  for (const [ratio, tone] of cases) {
    it(`${ratio ?? 'no budget'} → ${tone}`, () => {
      expect(budgetTone(ratio)).toBe(tone)
    })
  }
})
