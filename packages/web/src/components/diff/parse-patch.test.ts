import { describe, expect, it } from 'vitest'

import {
  buildSplitRows,
  buildUnifiedRows,
  contextGaps,
  contextLinesForGap,
  parsePatch,
  type HunkLine,
} from './parse-patch'

/** A realistic two-hunk section, exactly as `ChangedFile.patch` carries it. */
const TWO_HUNKS = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -3,4 +3,4 @@ function head() {',
  ' const one = 1',
  '-const two = 2',
  '+const two = 3',
  ' const three = 3',
  ' const four = 4',
  '@@ -20,3 +20,4 @@ function tail() {',
  ' before()',
  '+added()',
  ' between()',
  ' after()',
  '',
].join('\n')

describe('parsePatch', () => {
  it('parses hunk headers and assigns per-side line numbers', () => {
    const { hunks, truncated } = parsePatch(TWO_HUNKS)

    expect(truncated).toBe(false)
    expect(hunks).toHaveLength(2)
    expect(hunks[0]).toMatchObject({ oldStart: 3, oldCount: 4, newStart: 3, newCount: 4 })
    expect(hunks[0]!.header).toContain('function head()')

    const [context, del, add] = hunks[0]!.lines
    expect(context).toEqual({ kind: 'context', text: 'const one = 1', oldLine: 3, newLine: 3 })
    expect(del).toEqual({ kind: 'del', text: 'const two = 2', oldLine: 4 })
    expect(add).toEqual({ kind: 'add', text: 'const two = 3', newLine: 4 })
    // Context after a paired change advances both sides past the del/add.
    expect(hunks[0]!.lines[3]).toMatchObject({ oldLine: 5, newLine: 5 })
  })

  it('defaults omitted hunk counts to 1 (@@ -1 +1 @@ form)', () => {
    const { hunks } = parsePatch('@@ -1 +1 @@\n-a\n+b\n')
    expect(hunks[0]).toMatchObject({ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 })
  })

  it('skips the "no newline" marker without counting it as content', () => {
    const { hunks } = parsePatch('@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n')
    expect(hunks[0]!.lines.map((line) => line.kind)).toEqual(['del', 'add'])
  })

  it('flags the server truncation marker and stops attributing lines', () => {
    const { hunks, truncated } = parsePatch('@@ -1,2 +1,2 @@\n-a\n+b\n… (patch truncated)\n+stray')
    expect(truncated).toBe(true)
    // The stray line after the cap belongs to no hunk — counts must not drift.
    expect(hunks[0]!.lines).toHaveLength(2)
  })

  it('parses headers-only sections (binary, mode-change) and empty patches to zero hunks', () => {
    expect(parsePatch('').hunks).toHaveLength(0)
    expect(
      parsePatch('diff --git a/x.png b/x.png\nindex 111..222\nBinary files a/x.png and b/x.png differ\n').hunks,
    ).toHaveLength(0)
  })
})

describe('contextGaps', () => {
  const { hunks } = parsePatch(TWO_HUNKS)

  it('finds the leading and between-hunk gaps with counts', () => {
    const gaps = contextGaps(hunks)
    expect(gaps).toEqual([
      { beforeHunk: 0, count: 2, oldStart: 1, newStart: 1 },
      { beforeHunk: 1, count: 13, oldStart: 7, newStart: 7 },
    ])
  })

  it('adds the open-ended trailing gap only on request', () => {
    const gaps = contextGaps(hunks, true)
    expect(gaps.at(-1)).toEqual({ beforeHunk: 2, count: undefined, oldStart: 23, newStart: 24 })
  })

  it('materializes gap lines from the new-side file text with lockstep numbering', () => {
    const fileLines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)
    const between = contextGaps(hunks)[1]!
    const lines = contextLinesForGap(between, fileLines)
    expect(lines).toHaveLength(13)
    expect(lines[0]).toEqual({ kind: 'context', text: 'line 7', oldLine: 7, newLine: 7 })
    expect(lines.at(-1)).toMatchObject({ oldLine: 19, newLine: 19 })

    // Trailing gap: runs to EOF, offset between sides preserved (old is one behind here).
    const trailing = contextGaps(hunks, true).at(-1)!
    const tail = contextLinesForGap(trailing, fileLines)
    expect(tail[0]).toEqual({ kind: 'context', text: 'line 24', oldLine: 23, newLine: 24 })
    expect(tail.at(-1)).toMatchObject({ newLine: 30, oldLine: 29 })
  })
})

describe('buildUnifiedRows', () => {
  const { hunks } = parsePatch(TWO_HUNKS)

  it('emits hunk headers, gap rows and lines in document order', () => {
    const rows = buildUnifiedRows(hunks, contextGaps(hunks))
    expect(rows.map((row) => row.type)).toEqual([
      'gap', 'hunk', 'line', 'line', 'line', 'line', 'line',
      'gap', 'hunk', 'line', 'line', 'line', 'line',
    ])
  })

  it('attaches word spans to paired del/add lines and only to them', () => {
    const rows = buildUnifiedRows(hunks)
    const lines = rows.filter((row) => row.type === 'line')
    const del = lines.find((row) => row.cell.line.kind === 'del')!
    const add = lines.find((row) => row.cell.line.kind === 'add')!
    // `const two = 2` → `const two = 3`: exactly the numeral is marked on both sides.
    expect(del.cell.spans!.filter((span) => span.changed).map((span) => span.text)).toEqual(['2'])
    expect(add.cell.spans!.filter((span) => span.changed).map((span) => span.text)).toEqual(['3'])
    // The unpaired `+added()` (no del counterpart) carries no spans.
    const lone = lines.find((row) => row.cell.line.text === 'added()')!
    expect(lone.cell.spans).toBeUndefined()
    for (const row of lines.filter((r) => r.cell.line.kind === 'context')) {
      expect(row.cell.spans).toBeUndefined()
    }
  })

  it('splices expanded context lines in place of their gap row', () => {
    const gaps = contextGaps(hunks)
    const expansion: HunkLine[] = [
      { kind: 'context', text: 'line 1', oldLine: 1, newLine: 1 },
      { kind: 'context', text: 'line 2', oldLine: 2, newLine: 2 },
    ]
    const rows = buildUnifiedRows(hunks, gaps, new Map([[0, expansion]]))
    expect(rows[0]).toEqual({ type: 'line', cell: { line: expansion[0] } })
    expect(rows[1]).toEqual({ type: 'line', cell: { line: expansion[1] } })
    // The other gap is untouched.
    expect(rows.filter((row) => row.type === 'gap')).toHaveLength(1)
  })
})

describe('buildSplitRows', () => {
  const { hunks } = parsePatch(TWO_HUNKS)

  it('pairs context on both sides and del/add on one row', () => {
    const rows = buildSplitRows(hunks)
    const pairs = rows.filter((row) => row.type === 'pair')
    const context = pairs[0]!
    expect(context.left!.line).toBe(context.right!.line) // same HunkLine object, both sides

    const change = pairs[1]!
    expect(change.left!.line.kind).toBe('del')
    expect(change.right!.line.kind).toBe('add')
    expect(change.left!.spans).toBeDefined()
    expect(change.right!.spans).toBeDefined()
  })

  it('leaves the counterpart cell empty for unbalanced blocks', () => {
    const rows = buildSplitRows(hunks)
    const lone = rows.find((row) => row.type === 'pair' && row.right?.line.text === 'added()')!
    expect(lone.type === 'pair' && lone.left).toBeUndefined()
  })
})
