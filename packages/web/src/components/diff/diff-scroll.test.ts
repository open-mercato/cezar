import { describe, expect, it } from 'vitest'

import {
  DIFF_VIRTUALIZE_THRESHOLD,
  diffRenderMode,
  diffRowCount,
  estimateFileHeight,
  estimateFileRows,
  fileKey,
  widestLineChars,
} from './diff-scroll'
import type { DiffFileChange } from './types'

/** A file whose patch renders `rows` rows, behind git's 4-line preamble. */
function file(path: string, rows: number, overrides: Partial<DiffFileChange> = {}): DiffFileChange {
  const body = ['@@ -1,1 +1,1 @@', ...Array.from({ length: rows - 1 }, (_, index) => ` line ${index}`)]
  return {
    path,
    status: 'modified',
    adds: 0,
    dels: 0,
    patch: [`diff --git a/${path} b/${path}`, 'index 111..222 100644', `--- a/${path}`, `+++ b/${path}`, ...body].join('\n'),
    ...overrides,
  }
}

describe('estimateFileRows', () => {
  it('counts the rendered rows, discarding git\'s pre-@@ preamble', () => {
    expect(estimateFileRows(file('a.ts', 10))).toBe(10)
  })

  it('counts one row for the note a binary or metadata-only file renders instead', () => {
    expect(estimateFileRows({ ...file('logo.png', 5), binary: true })).toBe(1)
    expect(estimateFileRows({ ...file('moved.ts', 5), patch: '' })).toBe(1)
  })

  it('falls back to the whole patch when there is no hunk header to anchor on', () => {
    // Not a shape git emits, but the estimate must never go negative on a surprise.
    expect(estimateFileRows({ ...file('a.ts', 3), patch: 'one\ntwo\nthree' })).toBe(3)
  })
})

describe('diffRowCount', () => {
  it('sums the rows across the changeset', () => {
    expect(diffRowCount([file('a.ts', 10), file('b.ts', 25)])).toBe(35)
  })

  it('is zero for an empty changeset', () => {
    expect(diffRowCount([])).toBe(0)
  })
})

describe('estimateFileHeight', () => {
  it('scales with the row count and always leaves room for the card chrome', () => {
    const small = estimateFileHeight(file('a.ts', 5))
    const large = estimateFileHeight(file('a.ts', 500))
    expect(small).toBeGreaterThan(0)
    expect(large).toBeGreaterThan(small)
    // A one-row file still needs its sticky header — the placeholder can't be a bare 20px.
    expect(estimateFileHeight({ ...file('logo.png', 1), binary: true })).toBeGreaterThan(20)
  })
})

describe('diffRenderMode', () => {
  it('renders flat up to the threshold and virtualizes past it', () => {
    expect(diffRenderMode('', 0)).toBe('flat')
    expect(diffRenderMode('', DIFF_VIRTUALIZE_THRESHOLD)).toBe('flat')
    expect(diffRenderMode('', DIFF_VIRTUALIZE_THRESHOLD + 1)).toBe('virtual')
  })

  it('honors the ?diff= override in both directions — the measurement seam', () => {
    expect(diffRenderMode('?diff=virtual', 1)).toBe('virtual')
    expect(diffRenderMode('?diff=flat', 99_999)).toBe('flat')
  })

  it('ignores an unknown ?diff= value rather than guessing', () => {
    expect(diffRenderMode('?diff=yes', 1)).toBe('flat')
    expect(diffRenderMode('?other=flat', 99_999)).toBe('virtual')
  })
})

describe('fileKey', () => {
  it('separates a rename from a same-path edit', () => {
    expect(fileKey({ ...file('new.ts', 1), oldPath: 'old.ts' })).not.toBe(fileKey(file('new.ts', 1)))
  })

  it('is stable across refetches of the same file', () => {
    expect(fileKey(file('a.ts', 1))).toBe(fileKey(file('a.ts', 9)))
  })
})

describe('widestLineChars', () => {
  it('measures the longest line, which is what the horizontal scroll floor needs', () => {
    expect(widestLineChars('ab\nabcdef\nabc')).toBe(6)
  })

  it('is zero for an empty patch', () => {
    expect(widestLineChars('')).toBe(0)
  })
})
