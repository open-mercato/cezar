import { ArchiveIcon, ArchiveRestoreIcon } from 'lucide-react'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import { cn } from '@/lib/utils'

/**
 * The row-level archive control — `PinToggle`'s sibling in a list row's hover actions. Archive in
 * the active view, restore in the archived one; the record says which. `stopPropagation` for the
 * same reason as the pin: the row behind it is a navigation target.
 */
export function ArchiveToggle({
  archived,
  onToggle,
  className,
}: {
  archived: boolean
  /** Called with the state the user is asking for — `true` to archive, `false` to restore. */
  onToggle: (archived: boolean) => void
  className?: string
}) {
  const Icon = archived ? ArchiveRestoreIcon : ArchiveIcon
  return (
    <IconTooltip label={archived ? 'Move back to the active list' : 'Move to the archived list'}>
      <button
        type="button"
        data-slot="archive-toggle"
        aria-label={archived ? 'Unarchive task' : 'Archive task'}
        onClick={(event) => {
          event.stopPropagation()
          onToggle(!archived)
        }}
        className={cn(
          'inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-soft-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
          className,
        )}
      >
        <Icon className="size-3" aria-hidden="true" />
      </button>
    </IconTooltip>
  )
}
