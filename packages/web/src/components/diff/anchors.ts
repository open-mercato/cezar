import { parsePatch, type HunkLine } from './parse-patch'
import type { DiffFileChange, DiffLineAnchor } from './types'

/**
 * Resolves a (side, line) from outside the diff — a GitHub review comment — to the anchor the
 * diff draws it under, or `undefined` when that line is not in the file's hunks. A context line
 * exists on both sides but is anchored by its NEW number (`anchorForLine`), so an old-side
 * reference to it maps across.
 */
export function createAnchorResolver(
  file: Pick<DiffFileChange, 'path' | 'patch'>,
): (side: 'old' | 'new', line: number) => DiffLineAnchor | undefined {
  const lines: HunkLine[] = parsePatch(file.patch).hunks.flatMap((hunk) => hunk.lines)
  const byOld = new Map<number, HunkLine>()
  const byNew = new Map<number, HunkLine>()
  for (const line of lines) {
    if (line.oldLine !== undefined) byOld.set(line.oldLine, line)
    if (line.newLine !== undefined) byNew.set(line.newLine, line)
  }
  return (side, n) => {
    const line = side === 'old' ? byOld.get(n) : byNew.get(n)
    if (!line) return undefined
    if (line.kind === 'del') return { path: file.path, side: 'old', line: line.oldLine! }
    return { path: file.path, side: 'new', line: line.newLine! }
  }
}
