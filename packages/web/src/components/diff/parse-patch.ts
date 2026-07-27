/**
 * Pure parsing + row building for the `<Diff>` facade: one file's unified-diff section
 * (the server's `ChangedFile.patch` — `diff --git` headers plus `@@` hunks) → hunks with
 * per-side line numbers → renderable rows for the unified and split layouts, with
 * word-level spans attached to paired del/add lines and context gaps materialized for
 * expansion. No DOM, no git library — the same house rule as `lib/unified-diff.ts`.
 */

import { diffWords, type WordSpan } from './word-diff'

export interface HunkLine {
  kind: 'context' | 'add' | 'del'
  /** Line text without its `+`/`-`/space marker. */
  text: string
  /** 1-based position in the old file — absent for adds. */
  oldLine?: number
  /** 1-based position in the new file — absent for dels. */
  newLine?: number
}

export interface Hunk {
  /** The raw `@@ -a,b +c,d @@ …` header line. */
  header: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: HunkLine[]
}

export interface ParsedPatch {
  hunks: Hunk[]
  /** The server capped the patch (`… (patch truncated)` marker) — tell the reader. */
  truncated: boolean
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
const TRUNCATION_MARKER = '… (patch truncated)'

export function parsePatch(patch: string): ParsedPatch {
  const hunks: Hunk[] = []
  let truncated = false
  let current: Hunk | null = null
  let oldLine = 0
  let newLine = 0

  const raw = patch.split('\n')
  // git ends every section with a newline; the split leaves a phantom '' that would
  // otherwise count as one extra empty context line.
  if (raw.at(-1) === '') raw.pop()

  for (const line of raw) {
    const match = HUNK_RE.exec(line)
    if (match) {
      current = {
        header: line,
        oldStart: Number(match[1]),
        oldCount: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newCount: match[4] === undefined ? 1 : Number(match[4]),
        lines: [],
      }
      oldLine = current.oldStart
      newLine = current.newStart
      hunks.push(current)
      continue
    }
    if (line.includes(TRUNCATION_MARKER)) {
      truncated = true
      current = null // the cap may have cut mid-hunk — stop attributing lines to it
      continue
    }
    if (!current) continue // diff --git / index / ---/+++ headers, or non-diff preamble
    if (line.startsWith('+')) {
      current.lines.push({ kind: 'add', text: line.slice(1), newLine: newLine++ })
    } else if (line.startsWith('-')) {
      current.lines.push({ kind: 'del', text: line.slice(1), oldLine: oldLine++ })
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" — metadata, not content on either side.
    } else {
      // Context: ' ' + text, or a completely empty line (some tools emit '' for blank context).
      current.lines.push({ kind: 'context', text: line.slice(1), oldLine: oldLine++, newLine: newLine++ })
    }
  }
  return { hunks, truncated }
}

// ---- context gaps -------------------------------------------------------------------------

/** An unchanged region the patch skipped: before the first hunk, between hunks, after the last. */
export interface ContextGap {
  /** Index of the hunk this gap precedes; `hunks.length` for the trailing gap. */
  beforeHunk: number
  /** Hidden line count — undefined for the trailing gap (the patch doesn't know EOF). */
  count?: number
  /** First hidden line, old side. */
  oldStart: number
  /** First hidden line, new side. */
  newStart: number
}

/** The expandable gaps of a hunk list. `includeTrailing` — the after-last-hunk region has an
 *  unknown length, so it is only worth a row when a loader can actually expand it. */
export function contextGaps(hunks: Hunk[], includeTrailing = false): ContextGap[] {
  const gaps: ContextGap[] = []
  const first = hunks[0]
  if (!first) return gaps
  if (first.newStart > 1) {
    gaps.push({ beforeHunk: 0, count: first.newStart - 1, oldStart: 1, newStart: 1 })
  }
  for (let i = 1; i < hunks.length; i++) {
    const prev = hunks[i - 1]!
    const next = hunks[i]!
    const prevOldEnd = prev.oldStart + prev.oldCount
    const prevNewEnd = prev.newStart + prev.newCount
    const count = next.newStart - prevNewEnd
    if (count > 0) gaps.push({ beforeHunk: i, count, oldStart: prevOldEnd, newStart: prevNewEnd })
  }
  if (includeTrailing) {
    const last = hunks[hunks.length - 1]!
    gaps.push({
      beforeHunk: hunks.length,
      oldStart: last.oldStart + last.oldCount,
      newStart: last.newStart + last.newCount,
    })
  }
  return gaps
}

/**
 * Materialize a gap's hidden lines as context rows from the file's current (new-side) text.
 * Old-side numbers follow at the gap's constant old/new offset — the region is unchanged,
 * so both sides advance in lockstep.
 */
export function contextLinesForGap(gap: ContextGap, fileLines: readonly string[]): HunkLine[] {
  const lastNewLine = gap.count === undefined ? fileLines.length : gap.newStart + gap.count - 1
  const offset = gap.oldStart - gap.newStart
  const lines: HunkLine[] = []
  for (let newLine = gap.newStart; newLine <= Math.min(lastNewLine, fileLines.length); newLine++) {
    lines.push({ kind: 'context', text: fileLines[newLine - 1] ?? '', oldLine: newLine + offset, newLine })
  }
  return lines
}

// ---- renderable rows ----------------------------------------------------------------------

/** A line plus its word-level marks (only paired del/add lines carry spans). */
export interface DiffCell {
  line: HunkLine
  spans?: WordSpan[]
}

export type UnifiedRow =
  | { type: 'hunk'; hunk: Hunk }
  | { type: 'gap'; gap: ContextGap }
  | { type: 'line'; cell: DiffCell }

export type SplitRow =
  | { type: 'hunk'; hunk: Hunk }
  | { type: 'gap'; gap: ContextGap }
  | { type: 'pair'; left?: DiffCell; right?: DiffCell }

/** Expanded gaps, keyed by `ContextGap.beforeHunk` — the component's expansion state. */
export type ExpandedGaps = ReadonlyMap<number, readonly HunkLine[]>

/** A change block: the consecutive del run and the add run that immediately follows it. */
interface ChangeBlock {
  dels: HunkLine[]
  adds: HunkLine[]
  delSpans: (WordSpan[] | undefined)[]
  addSpans: (WordSpan[] | undefined)[]
}

/** Pair del[i] ↔ add[i] and compute word-level marks for each pair (null-safe past min length). */
function pairBlock(dels: HunkLine[], adds: HunkLine[]): ChangeBlock {
  const delSpans: (WordSpan[] | undefined)[] = new Array<WordSpan[] | undefined>(dels.length)
  const addSpans: (WordSpan[] | undefined)[] = new Array<WordSpan[] | undefined>(adds.length)
  const pairs = Math.min(dels.length, adds.length)
  for (let i = 0; i < pairs; i++) {
    const words = diffWords(dels[i]!.text, adds[i]!.text)
    if (words) {
      delSpans[i] = words.del
      addSpans[i] = words.add
    }
  }
  return { dels, adds, delSpans, addSpans }
}

/** Walk a hunk's lines as context runs and change blocks, in order. */
function walkHunk(hunk: Hunk, onContext: (line: HunkLine) => void, onBlock: (block: ChangeBlock) => void): void {
  let i = 0
  while (i < hunk.lines.length) {
    const line = hunk.lines[i]!
    if (line.kind === 'del' || line.kind === 'add') {
      const dels: HunkLine[] = []
      const adds: HunkLine[] = []
      while (i < hunk.lines.length && hunk.lines[i]!.kind === 'del') dels.push(hunk.lines[i++]!)
      while (i < hunk.lines.length && hunk.lines[i]!.kind === 'add') adds.push(hunk.lines[i++]!)
      onBlock(pairBlock(dels, adds))
    } else {
      onContext(line)
      i++
    }
  }
}

export function buildUnifiedRows(hunks: Hunk[], gaps: ContextGap[] = [], expanded?: ExpandedGaps): UnifiedRow[] {
  const gapBefore = new Map(gaps.map((gap) => [gap.beforeHunk, gap]))
  const rows: UnifiedRow[] = []
  const pushGap = (position: number) => {
    const gap = gapBefore.get(position)
    if (!gap) return
    const lines = expanded?.get(position)
    if (lines) for (const line of lines) rows.push({ type: 'line', cell: { line } })
    else rows.push({ type: 'gap', gap })
  }
  hunks.forEach((hunk, index) => {
    pushGap(index)
    rows.push({ type: 'hunk', hunk })
    walkHunk(
      hunk,
      (line) => rows.push({ type: 'line', cell: { line } }),
      (block) => {
        block.dels.forEach((line, i) => rows.push({ type: 'line', cell: { line, spans: block.delSpans[i] } }))
        block.adds.forEach((line, i) => rows.push({ type: 'line', cell: { line, spans: block.addSpans[i] } }))
      },
    )
  })
  pushGap(hunks.length)
  return rows
}

export function buildSplitRows(hunks: Hunk[], gaps: ContextGap[] = [], expanded?: ExpandedGaps): SplitRow[] {
  const gapBefore = new Map(gaps.map((gap) => [gap.beforeHunk, gap]))
  const rows: SplitRow[] = []
  const pushGap = (position: number) => {
    const gap = gapBefore.get(position)
    if (!gap) return
    const lines = expanded?.get(position)
    if (lines) for (const line of lines) rows.push({ type: 'pair', left: { line }, right: { line } })
    else rows.push({ type: 'gap', gap })
  }
  hunks.forEach((hunk, index) => {
    pushGap(index)
    rows.push({ type: 'hunk', hunk })
    walkHunk(
      hunk,
      (line) => rows.push({ type: 'pair', left: { line }, right: { line } }),
      (block) => {
        const height = Math.max(block.dels.length, block.adds.length)
        for (let i = 0; i < height; i++) {
          const del = block.dels[i]
          const add = block.adds[i]
          rows.push({
            type: 'pair',
            ...(del ? { left: { line: del, spans: block.delSpans[i] } } : {}),
            ...(add ? { right: { line: add, spans: block.addSpans[i] } } : {}),
          })
        }
      },
    )
  })
  pushGap(hunks.length)
  return rows
}
