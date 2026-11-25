import type { ChangedFile, GithubReviewComment } from '@open-mercato/cezar-api-client'
import { ChevronRightIcon, ExternalLinkIcon } from 'lucide-react'

import { createAnchorResolver, type DiffExternalThread, type DiffLineAnchor } from '@/components/diff'
import { GithubIcon } from '@/components/icons'
import { shortAge } from '@/lib/format'
import { cn } from '@/lib/utils'

import { GithubAvatar } from '../github/github-avatar'
import { GithubMarkdown } from '../github/github-markdown'

/**
 * GitHub inline review comments on the task Changes tab (spec 2026-07-18-github-comment-threads,
 * follow-up). Read-only: they are drawn here and never enter the self-review store
 * (`useDiffComments`), so they can be neither edited nor sent to the agent.
 */

/** A root comment and its replies, oldest first. */
export interface ReviewThread {
  root: GithubReviewComment
  replies: GithubReviewComment[]
}

/** Why a thread is listed apart from the diff instead of under a line. */
export type OffDiffReason = 'outdated' | 'file' | 'not-in-diff'

export interface PlacedThreads {
  /** Threads the diff draws under a row, keyed by `DiffExternalThread.id`. */
  anchored: Map<string, { anchor: DiffExternalThread; thread: ReviewThread }>
  /** Everything else, never dropped. */
  offDiff: { thread: ReviewThread; reason: OffDiffReason }[]
}

/** Replies under their root by `inReplyTo`; a reply whose root is missing stands as its own root. */
export function groupReviewThreads(comments: readonly GithubReviewComment[]): ReviewThread[] {
  const ids = new Set(comments.map((comment) => comment.id))
  const threads = new Map<number, ReviewThread>()
  for (const comment of comments) {
    if (comment.inReplyTo === undefined || !ids.has(comment.inReplyTo)) threads.set(comment.id, { root: comment, replies: [] })
  }
  for (const comment of comments) {
    if (comment.inReplyTo !== undefined && ids.has(comment.inReplyTo)) threads.get(comment.inReplyTo)?.replies.push(comment)
  }
  return [...threads.values()]
}

/**
 * Anchors each thread by path + side + line in the task's displayed hunks. Outdated threads,
 * file-level ones, and lines outside the hunks (or files outside the diff) go to `offDiff`.
 */
export function placeReviewThreads(threads: readonly ReviewThread[], files: readonly ChangedFile[]): PlacedThreads {
  const resolvers = new Map<string, ReturnType<typeof createAnchorResolver>>()
  const resolverFor = (path: string) => {
    if (resolvers.has(path)) return resolvers.get(path)
    const file = files.find((candidate) => candidate.path === path)
    const resolver = file && !file.binary ? createAnchorResolver(file) : undefined
    if (resolver) resolvers.set(path, resolver)
    return resolver
  }
  const placed: PlacedThreads = { anchored: new Map(), offDiff: [] }
  for (const thread of threads) {
    const { root } = thread
    if (root.subjectType === 'file') {
      placed.offDiff.push({ thread, reason: root.outdated ? 'outdated' : 'file' })
      continue
    }
    if (root.outdated || root.line === undefined) {
      placed.offDiff.push({ thread, reason: 'outdated' })
      continue
    }
    const resolve = resolverFor(root.path)
    const anchor: DiffLineAnchor | undefined = resolve?.(root.side, root.line)
    if (!anchor) {
      placed.offDiff.push({ thread, reason: 'not-in-diff' })
      continue
    }
    const startAnchor =
      root.startLine !== undefined ? resolve?.(root.startSide ?? root.side, root.startLine) : undefined
    const id = `gh-${root.id}`
    placed.anchored.set(id, {
      anchor: { ...anchor, id, ...(startAnchor ? { start: { side: startAnchor.side, line: startAnchor.line } } : {}) },
      thread,
    })
  }
  return placed
}

/** One GitHub review thread as a card: collapsed to a summary line once resolved. */
export function GithubReviewThreadCard({
  thread,
  reason,
}: {
  thread: ReviewThread
  /** Set for a thread listed apart from the diff — says why and shows the code it was left on. */
  reason?: OffDiffReason
}) {
  const { root, replies } = thread
  return (
    <details
      data-slot="gh-review-thread"
      data-resolved={root.resolved ? 'true' : undefined}
      open={!root.resolved}
      className="group/gh rounded-md border border-border bg-card text-ui leading-normal shadow-xs"
    >
      <summary
        aria-label={`GitHub review thread by ${root.author}${root.resolved ? ', resolved' : ''}`}
        className="flex cursor-pointer list-none items-center gap-1.5 rounded-md px-3 py-2 text-meta text-soft-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
      >
        <ChevronRightIcon aria-hidden="true" className="size-3 shrink-0 transition-transform group-open/gh:rotate-90" />
        <GithubIcon aria-hidden="true" className="size-3.5 shrink-0 text-foreground" />
        <span className="font-medium text-foreground">GitHub review</span>
        {root.resolved ? <Chip>Resolved</Chip> : null}
        {reason ? <ReasonChip comment={root} reason={reason} /> : null}
        <span className="min-w-0 truncate">
          {replies.length > 0 ? `${replies.length + 1} comments` : root.author}
        </span>
      </summary>
      <div className="flex flex-col gap-2.5 px-3 pb-2.5">
        {reason && root.diffHunk ? (
          <pre
            data-slot="gh-review-hunk"
            className="max-h-32 overflow-auto rounded-sm border border-border/60 bg-muted/40 px-2 py-1 font-mono text-label whitespace-pre text-muted-foreground"
          >
            {root.diffHunk}
          </pre>
        ) : null}
        <ReviewComment comment={root} />
        {replies.length > 0 ? (
          <ol data-slot="gh-review-replies" className="flex flex-col gap-2.5 border-l border-border pl-3">
            {replies.map((reply) => (
              <li key={reply.id}>
                <ReviewComment comment={reply} />
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </details>
  )
}

function ReviewComment({ comment }: { comment: GithubReviewComment }) {
  return (
    <div data-slot="gh-review-comment" data-comment-id={comment.id} className="min-w-0">
      <div className="mb-1 flex items-center gap-1.5 font-mono text-meta text-soft-foreground">
        <GithubAvatar url={comment.avatarUrl} login={comment.author} />
        <span className="font-sans font-medium text-foreground">{comment.author}</span>
        <span>{shortAge(comment.createdAt)}</span>
        <a
          href={comment.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${comment.author}'s comment on GitHub`}
          className="ml-auto inline-flex shrink-0 items-center gap-1 font-sans text-muted-foreground hover:text-foreground"
        >
          View on GitHub
          <ExternalLinkIcon aria-hidden="true" className="size-2.5" />
        </a>
      </div>
      <div data-slot="gh-review-body" className="text-sm">
        {comment.body ? <GithubMarkdown>{comment.body}</GithubMarkdown> : <p className="text-soft-foreground">(no body)</p>}
      </div>
    </div>
  )
}

function Chip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn('shrink-0 rounded-full border border-border px-1.5 py-px font-sans text-micro font-medium text-muted-foreground', className)}>
      {children}
    </span>
  )
}

function ReasonChip({ comment, reason }: { comment: GithubReviewComment; reason: OffDiffReason }) {
  if (reason === 'file') return <Chip>File comment</Chip>
  if (reason === 'outdated') {
    return (
      <Chip className="border-warning/40 text-warning">
        Outdated{comment.originalLine !== undefined ? ` · originally line ${comment.originalLine}` : ''}
      </Chip>
    )
  }
  return <Chip>{comment.line !== undefined ? `Line ${comment.line} · not in these changes` : 'Not in these changes'}</Chip>
}

/**
 * The GitHub threads the diff cannot place under a line — outdated, file-level, or outside the
 * displayed hunks — grouped per file, so none of them vanishes.
 */
export function GithubCommentsOffDiff({ items }: { items: PlacedThreads['offDiff'] }) {
  if (items.length === 0) return null
  const byPath = new Map<string, PlacedThreads['offDiff']>()
  for (const item of items) byPath.set(item.thread.root.path, [...(byPath.get(item.thread.root.path) ?? []), item])
  return (
    <details data-slot="gh-review-off-diff" className="group/off mb-3 rounded-md border border-border bg-muted/30">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md px-3 py-2 text-label text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon aria-hidden="true" className="size-3 shrink-0 transition-transform group-open/off:rotate-90" />
        <GithubIcon aria-hidden="true" className="size-3.5 shrink-0" />
        {items.length} GitHub {items.length === 1 ? 'comment' : 'comments'} not on this diff
      </summary>
      <div className="flex flex-col gap-3 px-3 pb-3">
        {[...byPath].map(([path, group]) => (
          <section key={path} data-slot="gh-review-off-diff-file" data-path={path} className="flex flex-col gap-2">
            <h3 className="truncate font-mono text-label text-foreground">{path}</h3>
            {group.map(({ thread, reason }) => (
              <GithubReviewThreadCard key={thread.root.id} thread={thread} reason={reason} />
            ))}
          </section>
        ))}
      </div>
    </details>
  )
}
