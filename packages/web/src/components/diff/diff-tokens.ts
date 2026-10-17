import type { SynHighlight, SynToken } from '@/lib/highlighter'

import type { HunkLine } from './parse-patch'

/** Tokens aligned to `lines`, each contiguous run highlighted per side, so lexer state never
 *  crosses hidden lines or a `-`/`+` pair. Null while the grammar is not loaded. */
export function tokenizeDiffLines(
  lines: readonly HunkLine[],
  highlightText: (text: string) => SynHighlight | null,
): SynToken[][] | null {
  const out: SynToken[][] = new Array(lines.length)
  for (const segment of contiguousSegments(lines)) {
    const sides: Array<(line: HunkLine) => boolean> = [
      (line) => line.kind !== 'add',
      (line) => line.kind !== 'del',
    ]
    for (const onSide of sides) {
      const indexes = segment.filter((index) => onSide(lines[index]!))
      if (indexes.length === 0) continue
      const result = highlightText(indexes.map((index) => lines[index]!.text).join('\n'))
      if (!result) return null
      // A context line sits on both sides; the new side, highlighted second, wins.
      indexes.forEach((index, at) => {
        out[index] = result.tokens[at] ?? [{ content: lines[index]!.text }]
      })
    }
  }
  return out
}

/** Index runs of `lines` whose old/new line numbers follow on from the previous line. */
function contiguousSegments(lines: readonly HunkLine[]): number[][] {
  const segments: number[][] = []
  let current: number[] = []
  let lastOld: number | undefined
  let lastNew: number | undefined
  lines.forEach((line, index) => {
    const follows =
      current.length > 0 &&
      (line.oldLine === undefined || lastOld === undefined || line.oldLine === lastOld + 1) &&
      (line.newLine === undefined || lastNew === undefined || line.newLine === lastNew + 1)
    if (!follows && current.length > 0) {
      segments.push(current)
      current = []
      lastOld = undefined
      lastNew = undefined
    }
    current.push(index)
    if (line.oldLine !== undefined) lastOld = line.oldLine
    if (line.newLine !== undefined) lastNew = line.newLine
  })
  if (current.length > 0) segments.push(current)
  return segments
}
