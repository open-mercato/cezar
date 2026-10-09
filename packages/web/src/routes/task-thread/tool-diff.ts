import type { FileDiff } from '@open-mercato/cezar-api-client'
import type { DiffFileChange } from '@/components/diff'

/**
 * An edit tool's `FileDiff` → the `<Diff>` facade's `DiffFileChange`, so the thread renders tool
 * edits with the SAME diff surface as the Changes tab (word-level marks, syntax highlighting)
 * instead of a second, plainer renderer.
 *
 * The protocol carries an edit one of three ways, and each becomes a patch `parsePatch` reads:
 *  - `unified` with `@@` hunks — used as-is;
 *  - `unified` without hunk headers (bare `+`/`-` lines) — wrapped in one synthetic hunk;
 *  - `oldText`/`newText` only — one hunk, trimmed to the lines that actually differ plus a little
 *    context. Those texts are usually the edited SNIPPET, not the whole file, so the line numbers
 *    are relative to the snippet; the content is exact.
 */

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m
/** File-header lines a bare unified body may still carry; never content. */
const HEADER_RE = /^(?:diff --git |index |--- |\+\+\+ |new file mode |deleted file mode |similarity index |rename (?:from|to) )/
const CONTEXT_LINES = 3

function splitLines(text: string | null | undefined): string[] {
  if (text === null || text === undefined || text === '') return []
  return text.replace(/\n$/, '').split('\n')
}

function countChanges(patch: string): { adds: number; dels: number } {
  let adds = 0
  let dels = 0
  for (const line of patch.split('\n')) {
    if (HEADER_RE.test(line)) continue
    if (line.startsWith('+')) adds += 1
    else if (line.startsWith('-')) dels += 1
  }
  return { adds, dels }
}

function range(start: number, count: number): string {
  return `${count === 0 ? 0 : start},${count}`
}

function patchFromTexts(oldLines: string[], newLines: string[]): string {
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1
  }
  const dels = oldLines.slice(prefix, oldLines.length - suffix)
  const adds = newLines.slice(prefix, newLines.length - suffix)
  if (dels.length === 0 && adds.length === 0) return ''
  const start = Math.max(0, prefix - CONTEXT_LINES)
  const before = oldLines.slice(start, prefix)
  const after = oldLines.slice(oldLines.length - suffix, oldLines.length - suffix + Math.min(suffix, CONTEXT_LINES))
  const context = before.length + after.length
  return [
    `@@ -${range(start + 1, context + dels.length)} +${range(start + 1, context + adds.length)} @@`,
    ...before.map((line) => ` ${line}`),
    ...dels.map((line) => `-${line}`),
    ...adds.map((line) => `+${line}`),
    ...after.map((line) => ` ${line}`),
  ].join('\n')
}

function patchFromBareUnified(unified: string): string {
  const body = unified.replace(/\n$/, '').split('\n').filter((line) => !HEADER_RE.test(line))
  let oldCount = 0
  let newCount = 0
  for (const line of body) {
    if (line.startsWith('+')) newCount += 1
    else if (line.startsWith('-')) oldCount += 1
    else if (!line.startsWith('\\')) {
      oldCount += 1
      newCount += 1
    }
  }
  if (body.length === 0) return ''
  return [`@@ -${range(1, oldCount)} +${range(1, newCount)} @@`, ...body].join('\n')
}

export function toDiffFileChange(diff: FileDiff): DiffFileChange {
  const patch =
    diff.unified !== undefined && diff.unified.trim() !== ''
      ? HUNK_RE.test(diff.unified)
        ? diff.unified
        : patchFromBareUnified(diff.unified)
      : patchFromTexts(splitLines(diff.oldText), splitLines(diff.newText))
  return {
    path: diff.path,
    status: diff.oldText === null ? 'added' : 'modified',
    ...countChanges(patch),
    patch,
  }
}

/** `+adds −dels` across one tool call's diffs — the collapsed row's at-a-glance size. */
export function diffTotals(diffs: readonly FileDiff[] | undefined): { adds: number; dels: number; files: number } | undefined {
  if (diffs === undefined || diffs.length === 0) return undefined
  let adds = 0
  let dels = 0
  for (const diff of diffs) {
    const file = toDiffFileChange(diff)
    adds += file.adds
    dels += file.dels
  }
  return { adds, dels, files: diffs.length }
}
