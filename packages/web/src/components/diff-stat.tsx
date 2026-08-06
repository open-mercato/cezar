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
 *
 * `stat.repointed` (#751) marks a number that covers uncommitted work only, because the agent
 * checked another branch out into the task's worktree — every review and QA run does. Before
 * the fix those runs reported the reviewed branch's entire diff; the number is right now, but
 * it is right for a *different* reason than the one next to it, so it says so: a dotted
 * underline and `cursor-help` advertise the explanation, the `title` carries it, and
 * `data-repointed` lets a surface style or assert on it without re-deriving the rule.
 *
 * That caveat also gets an `aria-label`, which the plain case deliberately does NOT: `title`
 * is unreliable for screen readers and unreachable on touch, and here it carries meaning
 * (*what these numbers measure*) rather than a restatement of the visible text. Without it,
 * assistive tech would read the narrowed number as if it were an ordinary one.
 *
 * The wording is deliberately past-tense ("measured with…") rather than a claim about the
 * worktree right now. `diffStat` is a snapshot taken at turn-end and is never recomputed or
 * cleared afterwards — not when the run finishes, and not when retention reclaims the
 * worktree — so a present-tense sentence would keep asserting a checkout that may have
 * stopped existing hours ago. What the flag can honestly say is what was true when the
 * numbers were taken.
 */
export function DiffStatLabel({ stat, className }: { stat: DiffStat; className?: string }) {
  const counts = `+${stat.adds} −${stat.dels} across ${stat.files} ${stat.files === 1 ? 'file' : 'files'}`
  const caveat = stat.repointed
    ? `${counts} — uncommitted changes only, measured with another branch checked out in this task's worktree`
    : undefined
  return (
    <span
      data-slot="diff-stat"
      {...(caveat ? { 'data-repointed': 'true', 'aria-label': caveat } : {})}
      title={caveat ?? counts}
      className={cn(
        'font-mono text-xs font-semibold tabular-nums',
        stat.repointed && 'cursor-help underline decoration-dotted underline-offset-2',
        className
      )}
    >
      <span className="text-success">+{stat.adds}</span> <span className="text-danger">−{stat.dels}</span>
    </span>
  )
}
