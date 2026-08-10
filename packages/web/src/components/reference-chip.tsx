import { ArrowUpRightIcon } from 'lucide-react'

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
  /**
   * The narrow sidebar row (#788, option C): the number ALONE — `#402` — with no `Issue ` word
   * and no `PR` label. There the chip is the row's leading identifier and every glyph it spends
   * is a glyph the task's name does not get, and which kind of reference it is stays carried by
   * the accessible name ("Open the pull request for …" / "Open the issue for …"), the `title`
   * (the URL) and the `data-slot`. Without a number there is nothing shorter to say, so the kind
   * is the label, exactly as in the full treatment.
   */
  compact?: boolean
}) {
  const { kind, number, url } = reference
  const chipClass = cn(
    'inline-flex h-[22px] items-center gap-1 rounded-full border border-violet/35 px-2 font-mono text-[11px] font-semibold text-violet',
    className,
  )
  const label = number ? `${!compact && kind === 'Issue' ? 'Issue ' : ''}#${number}` : kind

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
      className={cn(chipClass, 'hover:bg-violet/10')}
    >
      {label}
      <ArrowUpRightIcon className="size-2.5" aria-hidden="true" />
    </a>
  )
}
