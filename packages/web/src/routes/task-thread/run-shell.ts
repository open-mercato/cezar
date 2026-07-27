/**
 * ONE shell width for a run's whole detail view (review 2026-07-27).
 *
 * The header capped its inner block at 820px while the harness body capped at
 * 1120px, so at any viewport above 820px the two were visibly misaligned —
 * measured at 1600px: header block at x=518, content cards at x=368. Every
 * surface under `RunHeader` now takes its width from here.
 *
 * Two widths, because they answer different questions:
 *
 *  - `narrow` (820px) is a READING MEASURE. An ordinary run is a transcript of
 *    prose, and prose past ~90 characters per line is measurably harder to read.
 *  - `wide` (1240px) is the harness shell: the transcript keeps its measure and
 *    the run rail (phase / council / models) takes the rest, so watching a run
 *    no longer means leaving the tab you are watching. Below `xl` the rail
 *    becomes a drawer and this collapses back to the reading measure on its own.
 */

export const RUN_SHELL_NARROW = 'mx-auto w-full max-w-[820px]'
export const RUN_SHELL_WIDE = 'mx-auto w-full max-w-[1240px]'

/** The shell container class for a run detail surface. `wide` is the harness
 *  layout — pass `Boolean(run.harness)`. */
export function runShellClass(wide = false): string {
  return wide ? RUN_SHELL_WIDE : RUN_SHELL_NARROW
}

/** The harness body grid: transcript + a sticky rail that folds away under xl.
 *  Kept here so the header, the body and the composer dock cannot drift apart. */
export const RUN_RAIL_GRID =
  // `items-start` matters: without it the rail stretches to the full grid-row
  // height and `position: sticky` can never engage (a 93,000px-tall element has
  // nothing left to stick within).
  'grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_336px]'
