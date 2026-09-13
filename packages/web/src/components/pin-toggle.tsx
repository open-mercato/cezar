import { PinIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * The pin control (#935) — one button, shared by every surface that lists a task: the sidebar
 * quick-list row, the Tasks table row, the mobile card. (The thread header spells the same
 * action as a labelled button beside Archive, because a header has room for the word.)
 *
 * Shared rather than re-styled per surface for the reason the status dot is: a pin is one idea,
 * and three hand-rolled variants of it would drift into three different meanings of "filled".
 * The filled pin means pinned, the outline one means "pinnable"; the surface decides only when
 * the outline is *visible* (a row reveals it on hover so it is not permanently busy — see the
 * width-priority rule in `task-quick-list.tsx`) by passing its own classes.
 *
 * `stopPropagation` because two of the three surfaces are row-click navigation targets: the
 * click belongs to the pin, not to "open the task".
 */
export function PinToggle({
  pinned,
  onToggle,
  className,
}: {
  pinned: boolean
  /** Called with the state the user is asking for — `true` to pin, `false` to unpin. */
  onToggle: (pinned: boolean) => void
  className?: string
}) {
  return (
    <button
      type="button"
      data-slot="pin-toggle"
      data-pinned={pinned ? 'true' : undefined}
      // A toggle, so `aria-pressed` — the same call `ViewTab` and the column headers make.
      aria-pressed={pinned}
      aria-label={pinned ? 'Unpin task' : 'Pin task'}
      title={pinned ? 'Unpin from the top of the list' : 'Pin to the top of the list'}
      // Deliberately never disabled while the mutation is in flight: `usePinRun` invalidates
      // rather than patching optimistically, so a row's `run.pinned` is stale until the refetch
      // lands, and a second click would only re-send an idempotent `{pinned: true}`. Greying the
      // control out for the length of a round trip would cost more than the duplicate it saves.
      onClick={(event) => {
        event.stopPropagation()
        onToggle(!pinned)
      }}
      className={cn(
        'inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-soft-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
        pinned && 'text-violet hover:text-violet',
        className,
      )}
    >
      <PinIcon className={cn('size-3', pinned && 'fill-current')} aria-hidden="true" />
    </button>
  )
}
