/** Ordinary transcripts follow the user's reading-width preference. */
export const RUN_SHELL_NARROW = 'mx-auto w-full max-w-[var(--measure)]'
/** Harness views reserve room for the evidence rail while capping ultrawide layouts. */
export const RUN_SHELL_WIDE = 'mx-auto w-full max-w-[min(100%,1920px)]'

export function runShellClass(wide = false): string {
  return wide ? RUN_SHELL_WIDE : RUN_SHELL_NARROW
}

/** Workspace columns can be narrower than the viewport, so the rail follows its container. */
export const RUN_RAIL_CONTAINER = '@container/run'
export const RUN_RAIL_GRID =
  'grid grid-cols-1 items-start gap-5 @5xl/run:grid-cols-[minmax(0,1fr)_336px] @7xl/run:grid-cols-[minmax(0,1fr)_400px]'
