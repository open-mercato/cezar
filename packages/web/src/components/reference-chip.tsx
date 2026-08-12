import { ArrowUpRightIcon } from 'lucide-react'

import { GithubIcon } from '@/components/icons'
import { cn, isHttpUrl } from '@/lib/utils'

/** A github.com link earns the mark; other forges stay neutral until they have their own. */
function isGithub(url: string | undefined): boolean {
  if (!url) return false
  try {
    return new URL(url).hostname.endsWith('github.com')
  } catch {
    return false
  }
}

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
  // NEUTRAL, deliberately (purple = action/active/Cezar only): a violet outline made every
  // reference id compete with the real accents. It is metadata that happens to link out.
  const chipClass = cn(
    'inline-flex h-[22px] items-center gap-1 rounded-full border border-border px-2 font-mono text-xs font-medium text-muted-foreground',
    className,
  )
  const label = number ? `${!compact && kind === 'Issue' ? 'Issue ' : ''}#${number}` : kind
  // The forge mark, so the chip reads as "this opens on GitHub" at a glance (compact rows skip it).
  const mark = !compact && isGithub(url) ? <GithubIcon className="size-3" aria-hidden="true" /> : null

  // href protocol guard (#431): a transcript-scraped non-http URL degrades to inert text.
  if (!url || !isHttpUrl(url)) {
    return (
      <span data-slot={kind === 'PR' ? 'pr-chip' : 'issue-chip'} className={chipClass}>
        {mark}
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
      {mark}
      {label}
      <ArrowUpRightIcon className="size-2.5" aria-hidden="true" />
    </a>
  )
}
