import { ChevronRightIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

/**
 * The "N subtasks" chip, grown into the accordion's handle (#1110): a parent row's one control
 * for folding and unfolding the dispatched rows beneath it. Collapsed is the default everywhere
 * — `taskTreeRows`' `isExpanded` predicate does the actual folding; this is only the handle.
 *
 * A real BUTTON in the chip's old clothes, because the chip now does something: the chevron says
 * "there is more here", its rotation says which way the next click goes, and `aria-expanded`
 * says the same to a screen reader. Every row that hosts it (the table row, the card, the global
 * row) already routes its own click around `a, button`, so the toggle never doubles as a
 * navigation.
 */
export function SubtaskToggle({
  label,
  expanded,
  onToggle,
  className,
}: {
  /** `subtaskLabel(childCount)` — the caller only renders the handle when it is non-null. */
  label: string
  expanded: boolean
  onToggle: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      data-slot="subtask-toggle"
      aria-expanded={expanded}
      aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
      onClick={onToggle}
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-0.5 rounded-full bg-muted pr-2 pl-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
        className,
      )}
    >
      <ChevronRightIcon
        className={cn('size-3 transition-transform', expanded && 'rotate-90')}
        aria-hidden="true"
      />
      {label}
    </button>
  )
}
