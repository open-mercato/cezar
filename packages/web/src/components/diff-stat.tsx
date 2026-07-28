import type { DiffStat } from '@open-mercato/cezar-api-client'
import { cn } from '@/lib/utils'

/**
 * `+128 −14` — a run's aggregate diff numbers, the mockup's `.adds`/`.dels` pair
 * (`tasks-home.html`): mono, tabular, adds in the success token, deletions in the danger token.
 * One component so the table's ± column, the sidebar quick-list and the mobile cards can never
 * disagree about what a diff stat looks like.
 *
 * Renders only when a `DiffStat` exists — the caller owns its own absent state (the table's
 * honest `—`, the quick-list's nothing), because what absence means differs per surface.
 * The `−` is U+2212 (minus sign), as in the mockup — a hyphen is not a math sign.
 */
export function DiffStatLabel({ stat, className }: { stat: DiffStat; className?: string }) {
  return (
    <span
      data-slot="diff-stat"
      title={`+${stat.adds} −${stat.dels} across ${stat.files} ${stat.files === 1 ? 'file' : 'files'}`}
      className={cn('font-mono text-xs font-semibold tabular-nums', className)}
    >
      <span className="text-success">+{stat.adds}</span> <span className="text-danger">−{stat.dels}</span>
    </span>
  )
}
