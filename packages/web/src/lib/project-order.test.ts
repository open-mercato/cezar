import { describe, expect, it } from 'vitest'

import {
  moveProjectId,
  normalizeProjectOrder,
  orderProjects,
  PROJECT_ORDER_LIMIT,
} from './project-order'

/** The two fields the rule reads — the registry row's shape does not matter here. */
const project = (id: string, lastOpenedAt: string) => ({ id, lastOpenedAt })

const ids = (projects: Array<{ id: string }>) => projects.map((entry) => entry.id)

describe('normalizeProjectOrder', () => {
  it('passes a clean list through unchanged', () => {
    expect(normalizeProjectOrder(['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('survives everything a hand-edited ui-state.json can hold', () => {
    // `sidebar` is a loose bag on the wire, so this is a shape to absorb, not to reject.
    expect(normalizeProjectOrder(['a', 'a', 3, '', '  ', null, ' b ', undefined])).toEqual(['a', 'b'])
    expect(normalizeProjectOrder(undefined)).toEqual([])
    expect(normalizeProjectOrder(null)).toEqual([])
    expect(normalizeProjectOrder('a,b')).toEqual([])
    expect(normalizeProjectOrder({ 0: 'a' })).toEqual([])
  })

  it('clamps to the contract cap so an over-long list still renders', () => {
    const long = Array.from({ length: PROJECT_ORDER_LIMIT + 25 }, (_, index) => `p${index}`)
    expect(normalizeProjectOrder(long)).toHaveLength(PROJECT_ORDER_LIMIT)
    expect(normalizeProjectOrder(long)[0]).toBe('p0')
  })
})

describe('orderProjects', () => {
  const registry = [
    project('old', '2026-07-01T00:00:00.000Z'),
    project('newest', '2026-07-20T00:00:00.000Z'),
    project('middle', '2026-07-10T00:00:00.000Z'),
  ]

  it('falls back to most-recently-opened first when nothing is stored', () => {
    expect(ids(orderProjects(registry, []))).toEqual(['newest', 'middle', 'old'])
  })

  it('applies the stored order', () => {
    expect(ids(orderProjects(registry, ['old', 'newest', 'middle']))).toEqual([
      'old',
      'newest',
      'middle',
    ])
  })

  it('ignores stored ids that are no longer registered', () => {
    expect(ids(orderProjects(registry, ['gone', 'old', 'also-gone', 'newest', 'middle']))).toEqual([
      'old',
      'newest',
      'middle',
    ])
  })

  it('floats a project registered after the last drag to the top, by recency', () => {
    // The user placed two projects; `newest` and a later `fresh` were never placed. Neither is
    // dropped, and neither hides below the curated list — the thing you just added is visible.
    const withFresh = [...registry, project('fresh', '2026-07-25T00:00:00.000Z')]
    expect(ids(orderProjects(withFresh, ['old', 'middle']))).toEqual([
      'fresh',
      'newest',
      'old',
      'middle',
    ])
  })

  it('is a permutation of the input — never drops, duplicates or invents a row', () => {
    const ordered = orderProjects(registry, ['middle', 'middle', 'nope'])
    expect(ordered).toHaveLength(registry.length)
    expect([...ids(ordered)].sort()).toEqual([...ids(registry)].sort())
  })

  it('does not mutate its input', () => {
    const input = [...registry]
    orderProjects(input, ['old'])
    expect(ids(input)).toEqual(['old', 'newest', 'middle'])
  })

  it('handles the degenerate registries', () => {
    expect(orderProjects([], ['a'])).toEqual([])
    expect(ids(orderProjects([project('a', '2026-07-01T00:00:00.000Z')], ['a']))).toEqual(['a'])
  })
})

describe('moveProjectId', () => {
  it('moves down and up', () => {
    expect(moveProjectId(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a'])
    expect(moveProjectId(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
    expect(moveProjectId(['a', 'b', 'c'], 1, 2)).toEqual(['a', 'c', 'b'])
  })

  it('is a no-op for a drop that resolved to nothing', () => {
    expect(moveProjectId(['a', 'b'], 1, 1)).toEqual(['a', 'b'])
    expect(moveProjectId(['a', 'b'], -1, 0)).toEqual(['a', 'b'])
    expect(moveProjectId(['a', 'b'], 0, 7)).toEqual(['a', 'b'])
  })

  it('copies rather than splicing the caller’s array', () => {
    const input = ['a', 'b', 'c']
    moveProjectId(input, 0, 2)
    expect(input).toEqual(['a', 'b', 'c'])
  })
})
