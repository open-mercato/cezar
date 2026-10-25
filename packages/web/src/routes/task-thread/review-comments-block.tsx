import { FileIcon } from 'lucide-react'
import { useParams } from 'react-router'

import { Link } from '@/lib/project-router'

import type { ReviewItem } from './diff-comments'

/**
 * A sent review, as the transcript shows it: one card per comment — the file (a link that opens
 * the Changes tab at that line), the code it was left on, and the note, each visibly its own part.
 * As plain Markdown the three ran together, and the note read as more of the quoted code.
 *
 * The link is built from the route's task id; outside a task route (a fixture, a preview) the
 * path is plain text rather than a link to nowhere.
 */
export function ReviewCommentsBlock({ items }: { items: readonly ReviewItem[] }) {
  const { id } = useParams<{ id: string }>()
  return (
    <div data-slot="review-comments" className="mt-1 flex flex-col gap-2 text-left">
      <p className="text-[12px] font-medium text-muted-foreground">
        {items.length} {items.length === 1 ? 'comment' : 'comments'} on the diff
      </p>
      {items.map((item, index) => (
        <div
          key={index}
          data-slot="review-comment"
          className="overflow-hidden rounded-lg border border-border bg-background/60"
        >
          <div className="flex min-w-0 items-center gap-1.5 border-b border-border/60 px-2.5 py-1.5 text-[12px]">
            <FileIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            {id ? (
              <Link
                to={reviewTarget(id, item)}
                className="min-w-0 truncate font-mono font-medium text-foreground underline-offset-2 hover:underline"
                title={`Open ${item.path} on the Changes tab`}
              >
                {item.path}
              </Link>
            ) : (
              <span className="min-w-0 truncate font-mono font-medium">{item.path}</span>
            )}
            <span className="shrink-0 text-muted-foreground">· {item.label}</span>
          </div>
          {item.excerpt !== '' ? (
            <pre
              data-slot="review-comment-code"
              className="max-h-48 overflow-auto border-b border-border/60 bg-muted/40 px-2.5 py-1.5 font-mono text-[12px] leading-[1.6] whitespace-pre text-muted-foreground"
            >
              {item.excerpt}
            </pre>
          ) : null}
          <p data-slot="review-comment-body" className="px-2.5 py-2 break-words whitespace-pre-wrap text-foreground">
            {item.body}
          </p>
        </div>
      ))}
    </div>
  )
}

/** The Changes tab, asked to reveal this comment (or line) — it reads these params on arrival. */
export function reviewTarget(
  runId: string,
  at: { path: string; side: 'old' | 'new'; line?: number; commentId?: string },
): string {
  const params = new URLSearchParams({ file: at.path, side: at.side })
  if (at.line !== undefined) params.set('line', String(at.line))
  if (at.commentId !== undefined) params.set('comment', at.commentId)
  return `/tasks/${runId}/changes?${params.toString()}`
}

/** The reveal target a Changes-tab URL asks for (`reviewTarget`'s inverse), if any. */
export function revealFromSearch(search: URLSearchParams):
  | { path: string; side: 'old' | 'new'; line?: number; commentId?: string }
  | undefined {
  const path = search.get('file')
  if (!path) return undefined
  const line = Number(search.get('line'))
  const comment = search.get('comment')
  return {
    path,
    side: search.get('side') === 'old' ? 'old' : 'new',
    ...(Number.isInteger(line) && line > 0 ? { line } : {}),
    ...(comment ? { commentId: comment } : {}),
  }
}
