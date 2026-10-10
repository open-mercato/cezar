import { MessageSquareIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

/**
 * "💬 2" — how many drafted line comments for the agent sit in a file (or a collapsed folder).
 * One badge for the Changes sidebar and the diff's file headers, so the two always read alike.
 * Renders nothing at zero.
 */
export function CommentCount({ count, className }: { count: number; className?: string }) {
  if (count === 0) return null
  const label = `${count} ${count === 1 ? 'comment' : 'comments'}`
  return (
    <span
      data-slot="comment-count"
      title={`${label} for the agent`}
      aria-label={label}
      className={cn('flex shrink-0 items-center gap-1 text-[11px] font-medium text-primary tabular-nums', className)}
    >
      <MessageSquareIcon aria-hidden="true" className="size-3" />
      {count}
    </span>
  )
}
