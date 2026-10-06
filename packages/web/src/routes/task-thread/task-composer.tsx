import { useMemo, type CSSProperties, type ReactNode, type Ref } from 'react'

import { useSkills } from '@/api/queries'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { Composer } from '@/components/composer/composer'
import { toast } from '@/components/ui/toaster'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { useActiveProviderAvailability } from './active-provider'
import { useDeliverPrompt } from './deliver-prompt'
import { DiffCommentChips } from './diff-comment-chips'
import {
  commentsRideWith,
  slashCommandOf,
  messageWithReview,
  type DiffComment,
  type DiffComments,
} from './diff-comments'
import type { ContinueAction } from './follow-up-engine'
import type { Draft } from './thread-draft'

/**
 * The task's reply composer — ONE component for the Session tab's dock and the Changes tab's
 * floating dock, so the two can never disagree about what a send means: the drafted diff comments
 * folded in (and kept out of quick replies and backend slash commands), the continue/deliver
 * re-route, the provider gate, the engine pills.
 *
 * The host owns the state and passes it in: `draft` is a `useDraft` host (two hosts of one surface
 * would each keep their own copy, so a route has exactly one), and `continueAction` is shared with
 * the Session header's engine badge, which must edit the very choice this composer sends.
 * `diffComments` is the run's shared comment list — any number of hosts see the same one.
 */
export function TaskComposer({
  run,
  draft,
  diffComments,
  continueAction,
  getMentionCandidates,
  onSendingChange,
  onOpenComment,
}: {
  run: ApiRun
  draft: Draft
  diffComments: DiffComments
  continueAction: ContinueAction
  getMentionCandidates?: () => string[]
  /** A send started (`true`) or settled (`false`) — for a host that shows the composer only
   *  conditionally and must not drop it mid-send. */
  onSendingChange?: (sending: boolean) => void
  /** Passed to the chips — see `DiffCommentChips.onOpen`. */
  onOpenComment?: (comment: DiffComment) => void
}) {
  // The legacy session-open rule (web/app.js `updateDetail`): the composer can deliver while the
  // engine owns a live session — running queues the message, waiting answers it. A queued run's
  // prompt is still authorable (#472), and a closed run whose session can be reopened continues.
  const sessionOpen = run.status === 'running' || run.status === 'waiting'
  const queued = run.status === 'queued'
  const hasContinuation = !sessionOpen && !queued && continueAction.available
  const continuable = hasContinuation && continueAction.canContinue

  // One delivery path for both modes, because the record that picks between them can be stale:
  // a 409 refetches it and, when the truth names the other endpoint, delivers there instead.
  const deliverPrompt = useDeliverPrompt(run, continueAction)

  const hasDiffComments = diffComments.comments.length > 0
  // Only to tell a registry skill from a backend's own slash command (`commentsRideWith`) —
  // fetched only while there are comments to protect.
  const skillCatalog = useSkills(hasDiffComments)
  // Read defensively: the body is whatever the wire carried, and a non-list must never take the
  // view down — it only means "catalog unknown", which keeps a slash message's comments.
  const skillNames = useMemo(
    () => (Array.isArray(skillCatalog.data) ? skillCatalog.data.map((skill) => skill.name) : undefined),
    [skillCatalog.data],
  )

  const activeProvider = useActiveProviderAvailability(run)
  // A queued send only amends the persisted prompt; it invokes no provider and therefore remains
  // available even when provider discovery cannot authorize a live session. Once the session is
  // open, mirror the server's active-backend gate.
  const activeProviderBlocked = sessionOpen && !activeProvider.usable
  const continuationProviderBlocked = hasContinuation && !continueAction.canContinue
  const providerBlocked = activeProviderBlocked || continuationProviderBlocked
  const providerReason = activeProviderBlocked ? activeProvider.reason : continueAction.reason

  return (
    <Composer
      // The draft store's first host (#939). Controlled on BOTH seams — text and attachments — so
      // leaving the task mid-sentence and coming back restores the message exactly as it was left.
      // `draft.submit` wraps the real send: the optimistic clear only becomes a cleared draft once
      // the message has actually landed, and a rejection leaves the draft (and its blobs) intact.
      value={draft.text}
      onValueChange={draft.setText}
      images={draft.images}
      onImagesChange={draft.setImages}
      // The diff comments are folded in at send time and dropped only once the message has
      // landed. A quick reply (Alt+A / Alt+C, fired from anywhere on the page) never carries them:
      // the user did not see the review leave.
      onSubmit={async (text, images, meta) => {
        // A quick reply never touches the draft: it is not what the box holds, so its success
        // must not clear whatever the user had typed there.
        if (meta?.quickReply) return deliverPrompt(text, images)
        onSendingChange?.(true)
        try {
          return await draft.submit<unknown>(() => {
            if (hasDiffComments && !commentsRideWith(text, skillNames)) {
              toast(`Diff comments kept — /${slashCommandOf(text)} is a command, so they go with your next message.`)
              return deliverPrompt(text, images)
            }
            return diffComments.submit(async (held) => deliverPrompt(messageWithReview(text, held), images))
          })
        } finally {
          onSendingChange?.(false)
        }
      }}
      draftItems={
        hasDiffComments ?
          <DiffCommentChips
            runId={run.id}
            comments={diffComments.comments}
            onRemove={diffComments.remove}
            onOpen={onOpenComment}
          />
        : undefined
      }
      disabled={providerBlocked || (!sessionOpen && !queued && !continuable)}
      // Only reachable now by a closed run with NO session to resume — which is exactly the one
      // case where Continue is not on offer either.
      disabledReason={providerBlocked ? providerReason : 'Session closed — no session to resume.'}
      // The engine pills ride the enabled footer, so the picked runner/model and the typed prompt
      // reach `POST /continue` in one request.
      footerEnd={
        providerBlocked && !continueAction.providerPending ? (
          <Link to="/settings/agents#providers" className="text-xs font-medium text-foreground underline underline-offset-4">
            Configure providers
          </Link>
        ) : continuable ? continueAction.pills : undefined
      }
      // Continuing with nothing typed is the legacy one-click Continue, and pending diff comments
      // are a message on their own.
      allowEmptySubmit={continuable || hasDiffComments}
      sendAriaLabel={continuable ? 'Continue' : 'Send'}
      placeholder={
        queued ? 'Add to the prompt — sent when the run starts…'
        : continuable ? 'Continue — add a prompt, or send to just reopen the session…'
        : run.status === 'waiting' ? 'Reply — / for skills, @ for files…'
        : 'Message the agent — / for skills, @ for files…'
      }
      autocompleteSkills
      quickReplies
      getMentionCandidates={getMentionCandidates}
    />
  )
}

/**
 * The bottom dock the composer lives in — the Session tab's and the Changes tab's, from ONE
 * markup, so switching tabs leaves the chat box exactly where it was: stuck to the bottom of the
 * shared scroller, centred on the thread's reading measure. `bottom: var(--kb)` is the iOS
 * keyboard lift. `overlay` floats above the dock (the thread's jump-to-latest pill).
 */
export function TaskDock({
  children,
  overlay,
  floating = false,
  className,
  style,
  ref,
}: {
  children: ReactNode
  overlay?: ReactNode
  /** Float OVER the content instead of sitting on a band of its own: no background, no divider,
   *  and clicks pass through everywhere but the box itself — the Changes tab, where the diff and
   *  the file tree should stay visible around and behind the composer. */
  floating?: boolean
  className?: string
  style?: CSSProperties
  ref?: Ref<HTMLDivElement>
}) {
  return (
    <div
      ref={ref}
      data-slot="thread-dock"
      data-floating={floating || undefined}
      style={style}
      className={cn(
        'sticky bottom-[var(--kb,0px)] z-10 bg-background px-3 pt-1 pb-2 max-md:border-t max-md:border-border md:px-6 md:pt-1.5 md:pb-4',
        floating && 'pointer-events-none bg-transparent max-md:border-t-0 [&_[data-slot=composer]]:shadow-lg',
        className,
      )}
    >
      {overlay}
      <div
        className={cn(
          'mx-auto flex w-full max-w-[var(--measure)] flex-col gap-1.5 md:gap-2.5',
          floating && 'pointer-events-auto',
        )}
      >
        {children}
      </div>
    </div>
  )
}
