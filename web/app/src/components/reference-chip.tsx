import { ArrowUpRightIcon } from 'lucide-react'

import { chipVariants } from '@/components/ui/chip'
import { cn, isHttpUrl } from '@/lib/utils'

/** A task's out-of-app tracker link. The record carries no open/closed state, so PR and issue
 * references deliberately share one neutral treatment. */
export function ReferenceChip({
  reference,
  taskTitle,
  className,
  compact = false,
}: {
  reference: { kind: 'PR' | 'Issue'; number?: number; url?: string }
  taskTitle: string
  className?: string
  /** The narrow sidebar keeps its established `PR` label instead of spelling out a number. */
  compact?: boolean
}) {
  const { kind, number, url } = reference
  const chipClass = cn(
    chipVariants({ variant: 'outline' }),
    'h-5 gap-1 px-2 font-mono text-2xs font-semibold',
    className,
  )
  const label =
    compact && kind === 'PR'
      ? 'PR'
      : number
        ? `${kind === 'Issue' ? 'Issue ' : ''}#${number}`
        : kind

  // href protocol guard (#431): a transcript-scraped non-http URL degrades to inert text.
  if (!url || !isHttpUrl(url)) {
    return (
      <span data-slot={kind === 'PR' ? 'pr-chip' : 'issue-chip'} className={chipClass}>
        {label}
      </span>
    )
  }
  return (
    <a
      data-slot={kind === 'PR' ? 'pr-chip' : 'issue-chip'}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={url}
      aria-label={`Open the ${kind === 'PR' ? 'pull request' : 'issue'} for ${taskTitle}`}
      className={cn(chipClass, 'hover:bg-muted hover:text-foreground')}
    >
      {label}
      <ArrowUpRightIcon className="size-2.5" aria-hidden="true" />
    </a>
  )
}
