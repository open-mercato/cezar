import type { DiffFileChange } from './types'

/**
 * The diff's rendering-cost rules — pure data, no DOM (the wiring lives in `diff-view.tsx`,
 * so these stay table-testable). The sibling of `routes/task-thread/thread-scroll.ts`, and
 * deliberately the SAME doctrine, because the failure mode is the same one: a list whose
 * total size is unbounded by anything the user controls.
 *
 * THE PERFORMANCE RULE (mirrors thread-scroll.ts §"THE PERFORMANCE RULE"): up to
 * {@link DIFF_VIRTUALIZE_THRESHOLD} rendered rows the diff renders every file card flat, each
 * carrying `content-visibility: auto` — the browser skips style/layout/paint for off-screen
 * cards with zero behavior risk. Past the threshold the same cards go through virtua's
 * `<Virtualizer>`, which bounds the DOM itself.
 *
 * WHY THE FILE CARD IS THE VIRTUALIZED UNIT, not the line. Three properties of this view make
 * the card the honest granularity:
 *  - Sticky file headers survive. virtua absolutely-positions each item; a sticky header stays
 *    sticky because its containing block is still its own card box, exactly as in flat mode.
 *    Virtualizing individual LINES would put each header in its own item box, leaving it a
 *    zero-height sticky range — the header would stop tracking the file under the reader.
 *  - Syntax highlighting becomes lazy for free. Shiki tokenizes per file inside the card body
 *    (`useFileTokens`); an unmounted off-screen card tokenizes nothing. Tokenizing every file
 *    of a large changeset up front is the single biggest CPU cost this view had.
 *  - Per-file state (collapse, expanded context gaps) is the thing a reader actually mutates,
 *    so lifting it out of the card — which unmount now requires — is a small, closed change.
 * The remaining case the card granularity does NOT bound is ONE enormous file, whose rows are
 * a single item. That is what the per-block `content-visibility` in the card body covers.
 */

/** Rendered rows across all files, past which the file list goes through virtua. */
export const DIFF_VIRTUALIZE_THRESHOLD = 1500

/**
 * One unwrapped diff row's height at `text-xs`/`leading-[1.7]`: 12px × 1.7. A PLACEHOLDER — it
 * seeds `contain-intrinsic-block-size` for never-yet-rendered content and virtua's first
 * estimate, and both correct themselves on real measurement. Exact rather than rounded, because
 * thousands of skipped rows multiply the error: 0.4px a row was ~1,500px over a 3,700-line file.
 */
export const DIFF_ROW_ESTIMATE_PX = 20.4

/** The card chrome above/below a body (sticky header + padding), for the same estimate. */
const DIFF_CARD_CHROME_PX = 44

/**
 * How many rows a file will render, WITHOUT parsing it: the patch's line count, minus the
 * `diff --git`/`---`/`+++` preamble git puts before the first `@@`. An over-estimate on
 * files whose patch carries extra metadata lines, which is the safe direction — it only ever
 * makes a placeholder slightly too tall.
 */
export function estimateFileRows(file: DiffFileChange): number {
  if (file.binary === true || file.patch === '') return 1 // the one-line "no text diff" note
  const lines = file.patch.split('\n')
  const firstHunk = lines.findIndex((line) => line.startsWith('@@'))
  return firstHunk === -1 ? lines.length : lines.length - firstHunk
}

/** A card's placeholder height for `contain-intrinsic-block-size` / virtua's estimate. A closed
 *  card is its header plus at most the one-line note. */
export function estimateFileHeight(file: DiffFileChange, open = true): number {
  return Math.round((open ? estimateFileRows(file) : 1) * DIFF_ROW_ESTIMATE_PX) + DIFF_CARD_CHROME_PX
}

/** Total rows across the changeset, open or not — the number the threshold rule is about. */
export function diffRowCount(files: readonly DiffFileChange[]): number {
  return files.reduce((sum, file) => sum + estimateFileRows(file), 0)
}

/** Changed lines past which a file opens collapsed behind "Load diff". One such file's rows are
 *  a single virtualized item, so it is what made opening a big change freeze the cockpit. */
export const LARGE_DIFF_LINES = 400

/** Lockfiles and build output: machine-written, rarely reviewed line by line. */
const GENERATED_PATH = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|composer\.lock|Gemfile\.lock|go\.sum)$|\.min\.(js|css)$|\.map$/

/** Whether a file opens collapsed: too many changed lines, or generated. Binary and image files
 *  render no rows, so they never need holding back. */
export function isLargeDiff(file: DiffFileChange): boolean {
  if (file.binary === true || file.image === true) return false
  return file.adds + file.dels > LARGE_DIFF_LINES || GENERATED_PATH.test(file.path)
}

/**
 * Which renderer the diff uses. `search` is the location's query string: `?diff=flat` and
 * `?diff=virtual` force a mode — the honest measurement seam (the e2e perf comparison loads
 * the same changeset both ways, exactly as `?thread=` does for the transcript) and a
 * debugging escape hatch; anything else is `auto`, the threshold rule above.
 */
export function diffRenderMode(search: string, rowCount: number): 'flat' | 'virtual' {
  const forced = new URLSearchParams(search).get('diff')
  if (forced === 'flat' || forced === 'virtual') return forced
  return rowCount > DIFF_VIRTUALIZE_THRESHOLD ? 'virtual' : 'flat'
}

/** Stable identity for a file across refetches — the renderer's key and its state map's key. */
export function fileKey(file: DiffFileChange): string {
  return `${file.oldPath ?? ''}→${file.path}`
}

/**
 * The widest line in a patch, in characters. In no-wrap mode the card body scrolls
 * horizontally, and `content-visibility` size-contains off-screen rows — so without a floor
 * the body's scrollWidth would be whatever the CURRENTLY VISIBLE rows happen to be, and the
 * horizontal scrollbar would resize under a reader who had scrolled right. The body pins a
 * `min-inline-size` of this many `ch` instead, which is exact for the monospace ASCII that
 * dominates diffs and merely a floor everywhere else (a wider real row still widens the box).
 */
export function widestLineChars(patch: string): number {
  let widest = 0
  for (const line of patch.split('\n')) if (line.length > widest) widest = line.length
  return widest
}
