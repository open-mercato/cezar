import { describe, expect, it } from 'vitest'
import {
  dashboardPreferencesInputSchema,
  dashboardPreferencesSchema,
} from '@open-mercato/cezar-api-client'
import { normalizeOrder, resetViewOrder } from './preferences'

describe('dashboard layout persistence', () => {
  it('adds new overview modules without changing the relative order of saved modules', () => {
    expect(normalizeOrder()).toEqual([
      'overview',
      'needsYou',
      'recent',
      'fleet',
      'automations',
      'portfolio',
      'usage',
      'trends',
    ])
    const saved = ['fleet', 'needsYou', 'recent', 'usage', 'trends'] as const
    expect(normalizeOrder([...saved])).toEqual([
      'overview',
      ...saved,
      'automations',
      'portfolio',
    ])
    const moved = [
      'portfolio',
      'fleet',
      'overview',
      'needsYou',
      'recent',
      'usage',
      'trends',
    ] as const
    expect(normalizeOrder([...moved])).toEqual([...moved, 'automations'])
    expect(dashboardPreferencesInputSchema.parse({ order: moved }).order).toEqual(moved)
    expect(dashboardPreferencesSchema.parse({ order: moved }).order).toEqual(moved)
  })
  it('restores omitted modules without duplicate slots', () => {
    expect(normalizeOrder(['usage', 'fleet'])).toEqual([
      'overview',
      'usage',
      'fleet',
      'needsYou',
      'recent',
      'automations',
      'portfolio',
      'trends',
    ])
    expect(normalizeOrder(['usage', 'usage'])).toEqual([
      'overview',
      'usage',
      'needsYou',
      'recent',
      'fleet',
      'automations',
      'portfolio',
      'trends',
    ])
  })
  it('rejects invalid writes and recovers malformed saved order without losing visibility', () => {
    for (const order of [
      ['usage', 'usage'],
      [''],
      ['x'.repeat(65)],
      Array.from({ length: 201 }, (_, i) => String(i)),
      'usage',
    ]) {
      expect(dashboardPreferencesInputSchema.safeParse({ order }).success).toBe(false)
      expect(
        dashboardPreferencesSchema.parse({ order, tiles: { usage: false } }),
      ).toMatchObject({ order: [], tiles: { usage: false } })
    }
    expect(
      dashboardPreferencesInputSchema.parse({ order: ['usage', 'fleet'], future: 1 }).future,
    ).toBe(1)
  })
})

it('resets only Overview slots while preserving Costs placement and relative order', () => {
  const saved = [
    'trends',
    'portfolio',
    'usage',
    'fleet',
    'recent',
    'overview',
    'needsYou',
  ] as const
  expect(
    resetViewOrder([...saved], ['overview', 'portfolio', 'fleet', 'needsYou', 'recent']),
  ).toEqual(['trends', 'overview', 'usage', 'needsYou', 'recent', 'fleet', 'portfolio'])
})

it('persists all eight slots and automation visibility', () => {
  const order = normalizeOrder()
  expect(
    dashboardPreferencesInputSchema.parse({ order, tiles: { automations: false } }),
  ).toEqual({ order, tiles: { automations: false } })
  expect(
    dashboardPreferencesSchema.parse({ tiles: { automations: 'invalid' } }).tiles?.automations,
  ).toBe(true)
})

it('upgrades the previous default without leaving Automations after Projects', () => {
  const old = [
    'overview',
    'needsYou',
    'recent',
    'fleet',
    'portfolio',
    'usage',
    'trends',
  ] as const
  expect(normalizeOrder([...old])).toEqual(normalizeOrder())
  // A complete order can be an intentional drag to the last position.
  expect(normalizeOrder([...old, 'automations'])).toEqual([...old, 'automations'])
})
