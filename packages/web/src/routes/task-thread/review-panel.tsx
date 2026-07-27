import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  CheckIcon,
  CopyIcon,
  CornerUpLeftIcon,
  ExternalLinkIcon,
  EyeIcon,
  GitPullRequestIcon,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { ApiError, continueRun, createRunPr } from '@/api/client'
import { queryKeys } from '@/api/queries'
import type { ApiRun, RunStatus } from '@open-mercato/cezar-api-client'
import { TwinkleBackdrop } from '@/components/centered-state'
import { RunDiff } from '@/components/run-diff'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { Link } from '@/lib/project-router'
import { isSubmitShortcut } from '@/lib/use-submit-shortcut'
import { isHttpUrl } from '@/lib/utils'

import { finishTitle } from './run-actions'
import { useContinuationProvider } from './continuation-provider'
import { useFinishRun } from './use-finish-run'

/**
 * The review gate (spec 009, §"Task thread" review bullet) on the new surface — cezar's core
 * promise that nothing auto-merges. The flow is UNCHANGED from web/app.js `renderReviewPanel`;
 * only the surface is redesigned: a violet review banner, the diff as collapsible per-file
 * sections (`RunDiff` in components/run-diff.tsx — shared with the variants compare view),
 * a notes box with ↩ Send back (`POST /continue` with the `Review feedback:` prefix
 * — legacy semantics verbatim), Draft PR (`POST /pr`; 409 → the copyable `git merge` manual
 * fallback), and ✓ Accept (the shared finish action from use-finish-run.ts).
 */
export function ReviewPanel({ run }: { run: ApiRun }) {
  return (
    <section data-slot="review-panel" aria-label="Review the changes" className="flex flex-col gap-3">
      <div
        data-slot="review-banner"
        className="flex items-center gap-2.5 rounded-md border border-violet/30 bg-violet/10 px-3.5 py-2.5"
      >
        <EyeIcon className="size-4 shrink-0 text-violet" aria-hidden="true" />
        <p className="min-w-0 text-[13px]">
          <span className="font-semibold">Review the changes before anything lands.</span>{' '}
          <span className="text-muted-foreground">
            Read the diff, send notes back, draft a PR — or accept. Nothing merges on its own.
          </span>
        </p>
      </div>

      <RunDiff runId={run.id} />
      <ReviewActions run={run} />
    </section>
  )
}

// ---- notes + exits --------------------------------------------------------------------------

function ReviewActions({ run }: { run: ApiRun }) {
  const queryClient = useQueryClient()
  const notesRef = useRef<HTMLTextAreaElement>(null)
  const [notes, setNotes] = useState('')
  const [manual, setManual] = useState<string | null>(null)
  const finish = useFinishRun(run.id)
  const continuation = useContinuationProvider(run)
  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })

  // Legacy send-back semantics verbatim (web/app.js `data-action="send-back"`): the notes go
  // back into the SAME session via continue, prefixed `Review feedback:` — the run leaves
  // `review`, works, and gates again. On success the status flip unmounts this panel.
  const sendBack = useMutation({
    mutationFn: async (text: string) => {
      if (!continuation.canContinue) return null
      return continueRun(run.id, {
        text: `Review feedback:\n${text}`,
        runner: continuation.runnerOverride,
      })
    },
    onSuccess: (result) => {
      if (result === null) return
      setNotes('')
      invalidate()
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  const draftPr = useMutation({
    mutationFn: () => createRunPr(run.id),
    onSuccess: (result) => {
      toast(`Draft PR created — ${result.url}`)
      invalidate() // the run completed as done with `pullRequestUrl` — refetch shows PR ↗
    },
    onError: (error: Error) => {
      if (error instanceof ApiError && error.manual !== undefined) setManual(error.manual)
      toast(error.message, { tone: 'danger' })
    },
  })

  const submitNotes = () => {
    const text = notes.trim()
    if (text.length === 0) {
      // Legacy `alertBar('Write what to change first.')` + focus.
      toast('Write what to change first.')
      notesRef.current?.focus()
      return
    }
    sendBack.mutate(text)
  }

  return (
    <div data-slot="review-actions" className="flex flex-col gap-2">
      <Textarea
        ref={notesRef}
        data-slot="review-notes"
        aria-label="Notes for the agent"
        placeholder="Notes for the agent — what should change?"
        rows={2}
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
        onKeyDown={(event) => {
          // The spec's cross-surface chord: ⌘↵ / Ctrl+↵ submit review notes. Unlike the
          // composer, plain Enter stays a newline — notes are multi-line prose, and this box
          // has no legacy Enter-sends muscle memory to keep.
          const submits = isSubmitShortcut({
            key: event.key,
            shiftKey: event.shiftKey,
            metaKey: event.metaKey,
            ctrlKey: event.ctrlKey,
            altKey: event.altKey,
            repeat: event.repeat,
            isComposing: event.nativeEvent.isComposing,
          })
          if (submits && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            submitNotes()
          }
        }}
        className="min-h-[52px] text-[13px]"
      />
      {!continuation.canContinue ? (
        <p
          id="review-provider-guidance"
          className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
        >
          <span>{continuation.reason}</span>
          {!continuation.providerPending ? (
            <Link
              to="/settings/agents#providers"
              className="font-medium text-foreground underline underline-offset-4"
            >
              Configure providers
            </Link>
          ) : null}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          data-slot="review-send-back"
          variant="outline"
          size="sm"
          title={continuation.reason ?? "Send the notes back into the agent's session"}
          aria-describedby={!continuation.canContinue ? 'review-provider-guidance' : undefined}
          disabled={sendBack.isPending || !continuation.canContinue}
          onClick={submitNotes}
        >
          <CornerUpLeftIcon aria-hidden="true" />
          Send back
        </Button>
        {isHttpUrl(run.pullRequestUrl) ? (
          // A PR already exists (agent-opened, spotted in the transcript) — a second Draft PR
          // click would open a duplicate. Legacy parity: the link replaces the button.
          // href protocol guard (#431): the URL is scraped from the agent transcript, so link
          // only for http(s) — a non-http value falls through to the Draft PR button.
          <Button asChild variant="outline" size="sm">
            <a
              data-slot="pr-link"
              href={run.pullRequestUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="The PR for this task is already open"
            >
              <ExternalLinkIcon aria-hidden="true" />
              PR ↗
            </a>
          </Button>
        ) : (
          <Button
            data-slot="review-draft-pr"
            variant="outline"
            size="sm"
            title="Push the branch and open a draft PR"
            disabled={draftPr.isPending}
            onClick={() => draftPr.mutate()}
          >
            <GitPullRequestIcon aria-hidden="true" />
            Draft PR
          </Button>
        )}
        <Button
          data-slot="review-accept"
          variant="contrast"
          size="sm"
          className="ml-auto"
          title={finishTitle('review')}
          disabled={finish.isPending}
          onClick={() => finish.mutate()}
        >
          <CheckIcon aria-hidden="true" />
          Accept
        </Button>
      </div>
      {manual !== null ? <ManualMergeLine command={manual} /> : null}
    </div>
  )
}

/** The 409 fallback: the PR could not be opened, but the branch is real — show the merge
 *  command copyable, like the header's resume hint. */
function ManualMergeLine({ command }: { command: string }) {
  return (
    <button
      type="button"
      data-slot="review-manual"
      title="Copy the command"
      onClick={() => {
        void navigator.clipboard
          .writeText(command)
          .then(() => toast('Command copied to clipboard.'))
          .catch(() => toast(`Run manually: ${command}`))
      }}
      className="flex w-full min-w-0 items-center gap-1.5 rounded-sm px-1 py-0.5 text-left font-mono text-[11px] text-soft-foreground hover:bg-muted hover:text-foreground"
    >
      <CopyIcon className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">manual path: {command}</span>
    </button>
  )
}

// ---- the accept celebration -----------------------------------------------------------------

/** True when the OS asks for reduced motion — the celebration renders nothing at all then
 *  (spec: "reduced-motion-safe"). False where `matchMedia` is missing (old jsdom, SSR). */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

const CELEBRATION_MS = 1500

/**
 * The brief twinkle moment when a review is accepted (spec §"Design system": lifecycle
 * surfaces may twinkle): watches the run's status and, on the review → done transition —
 * however it was triggered: the panel's ✓ Accept, the header's Finish, a Draft PR — shows a
 * one-shot ~1.5s overlay of the brand scatter. Purely decorative (`aria-hidden`,
 * pointer-transparent); the status pill is the accessible record of what happened.
 */
export function AcceptCelebration({ status }: { status: RunStatus }) {
  const previous = useRef(status)
  const [celebrating, setCelebrating] = useState(false)

  useEffect(() => {
    const before = previous.current
    previous.current = status
    if (before !== 'review' || status !== 'done') return
    if (prefersReducedMotion()) return
    setCelebrating(true)
    const timer = setTimeout(() => setCelebrating(false), CELEBRATION_MS)
    return () => clearTimeout(timer)
  }, [status])

  if (!celebrating) return null
  return (
    <div
      data-slot="accept-celebration"
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 isolate z-40"
    >
      <TwinkleBackdrop />
      <div className="flex justify-center pt-24">
        <span className="rounded-full border border-violet/30 bg-violet/15 px-4 py-1.5 text-[13px] font-medium text-violet shadow-modal">
          ✓ Changes accepted
        </span>
      </div>
    </div>
  )
}
