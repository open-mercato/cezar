import { FileIcon, XIcon } from 'lucide-react'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Link } from '@/lib/project-router'

import { linesLabel, sortDiffComments, type DiffComment } from './diff-comments'
import { reviewTarget } from './review-comments-block'

/**
 * The diff comments as draft items in the thread composer — one chip per comment, `file +line`,
 * the way a review tool shows pending review notes beside the reply box. The label links back to
 * the Changes tab (where the comment lives in context); the ✕ drops just that comment.
 */
export function DiffCommentChips({
  runId,
  comments,
  onRemove,
  onOpen,
}: {
  runId: string
  comments: readonly DiffComment[]
  onRemove: (id: string) => void
  /** Given, the label is a button that calls this — the Changes tab, where a link to itself would
   *  do nothing, scrolls the diff to the comment's file instead. Absent, it links to the tab. */
  onOpen?: (comment: DiffComment) => void
}) {
  if (comments.length === 0) return null
  return (
    // The cockpit's own tooltip, not the browser's `title`: themed, shown on keyboard focus as well
    // as hover, and able to lay out a multi-line comment instead of one run-on line.
    <TooltipProvider delayDuration={300}>
      {sortDiffComments(comments).map((comment) => {
        const name = comment.path.split('/').at(-1) ?? comment.path
        const sign = (side: 'old' | 'new') => (side === 'old' ? '−' : '+')
        const span =
          comment.start && (comment.start.side !== comment.side || comment.start.line !== comment.line) ?
            comment.start.side === comment.side ?
              `${sign(comment.side)}${comment.start.line}–${comment.line}`
            : `${sign(comment.start.side)}${comment.start.line}–${sign(comment.side)}${comment.line}`
          : `${sign(comment.side)}${comment.line}`
        const label = `${name} ${span}`
        // Spoken: the side in words (`−4` and `+4` must not sound alike) and never the body —
        // a 4000-character note read out on every chip. The body is the tooltip.
        const where = linesLabel(comment)
        return (
          <Tooltip key={comment.id}>
            <TooltipTrigger asChild>
              <span
                data-slot="diff-comment-chip"
                className="flex h-8 max-w-[260px] items-center overflow-hidden rounded-md border border-border bg-muted/40 text-xs text-foreground"
              >
                <span aria-hidden="true" className="flex h-full items-center border-r border-border px-2 text-muted-foreground">
                  <FileIcon className="size-3.5" />
                </span>
                {onOpen ? (
                  <button
                    type="button"
                    onClick={() => onOpen(comment)}
                    className="min-w-0 truncate px-2 font-medium hover:underline"
                    aria-label={`Show comment on ${comment.path} ${where}`}
                  >
                    {label}
                  </button>
                ) : (
                  <Link
                    // Straight to THIS comment on the Changes tab, not the top of its file.
                    to={reviewTarget(runId, {
                      path: comment.path,
                      side: comment.side,
                      line: comment.line,
                      commentId: comment.id,
                    })}
                    className="min-w-0 truncate px-2 font-medium hover:underline"
                    aria-label={`Comment on ${comment.path} ${where}`}
                  >
                    {label}
                  </Link>
                )}
                <button
                  type="button"
                  aria-label={`Remove comment on ${name} ${where}`}
                  onClick={() => onRemove(comment.id)}
                  className="flex h-full items-center px-1.5 text-soft-foreground hover:bg-muted hover:text-foreground"
                >
                  <XIcon aria-hidden="true" className="size-3.5" />
                </button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6} className="max-w-[320px] text-left">
              <div data-slot="diff-comment-tooltip" className="flex flex-col gap-1">
                <span className="font-mono text-[11px] text-contrast-foreground/80">
                  {comment.path} · {where}
                </span>
                <span className="line-clamp-6 break-words whitespace-pre-wrap">{comment.body}</span>
              </div>
            </TooltipContent>
          </Tooltip>
        )
      })}
    </TooltipProvider>
  )
}
