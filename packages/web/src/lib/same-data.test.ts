import { describe, expect, it } from 'vitest'

import { sameData } from './same-data'

describe('sameData', () => {
  it.each([
    { label: 'primitives', a: 'text', b: 'text' },
    { label: 'null against null', a: null, b: null },
    { label: 'undefined against undefined', a: undefined, b: undefined },
    { label: 'flat objects', a: { id: 'i1', done: true }, b: { id: 'i1', done: true } },
    { label: 'key order', a: { id: 'i1', done: true }, b: { done: true, id: 'i1' } },
    { label: 'nested arrays', a: { rows: [{ t: 'a' }, { t: 'b' }] }, b: { rows: [{ t: 'a' }, { t: 'b' }] } },
    { label: 'empty containers', a: { rows: [], meta: {} }, b: { rows: [], meta: {} } },
  ])('is equal for $label', ({ a, b }) => {
    expect(sameData(a, b)).toBe(true)
  })

  it.each([
    { label: 'a changed leaf', a: { text: 'Hel' }, b: { text: 'Hell' } },
    { label: 'a missing key', a: { text: 'x', tone: 'dim' }, b: { text: 'x' } },
    { label: 'an extra key', a: { text: 'x' }, b: { text: 'x', tone: 'dim' } },
    { label: 'a renamed key', a: { text: 'x' }, b: { body: 'x' } },
    { label: 'a longer array', a: { rows: [1] }, b: { rows: [1, 2] } },
    { label: 'an array against an object', a: { rows: [] }, b: { rows: {} } },
    { label: 'a value against null', a: { rows: null }, b: { rows: [] } },
    { label: 'different types', a: 1, b: '1' },
    { label: 'NaN is still a value, not a mismatch marker', a: { n: 0 }, b: { n: Number.NaN } },
  ])('is not equal for $label', ({ a, b }) => {
    expect(sameData(a, b)).toBe(false)
  })

  it('treats NaN as equal to itself, like Object.is (a delta that did not change)', () => {
    expect(sameData({ n: Number.NaN }, { n: Number.NaN })).toBe(true)
  })

  it('falls back to reference equality for anything that is not a plain object', () => {
    const stamp = new Date('2026-07-31T00:00:00.000Z')
    expect(sameData(stamp, stamp)).toBe(true)
    expect(sameData(stamp, new Date('2026-07-31T00:00:00.000Z'))).toBe(false)
    const fn = () => {}
    expect(sameData({ fn }, { fn })).toBe(true)
    expect(sameData({ fn }, { fn: () => {} })).toBe(false)
  })

  it('short-circuits on shared sub-trees rather than walking them', () => {
    // The transcript reducer carries unchanged wire objects through by reference; that fast path
    // is what makes comparing a whole thread per frame cheap.
    const shared = { output: 'a'.repeat(100_000) }
    expect(sameData({ item: shared, seq: 1 }, { item: shared, seq: 1 })).toBe(true)
  })
})
