import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link as GlobalLink } from 'react-router'

import { cancelAutoResume } from '@/api/client'
import { queryKeys } from '@/api/queries'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { StatusDot } from '@/components/status-dot'
import { toast } from '@/components/ui/toaster'

/**
 * "This task is not over — it is waiting out a usage limit" (spec
 * 2026-08-03-auto-resume-after-usage-limit).
 *
 * A run stopped by a provider limit is `failed`, so without this the thread reads exactly like a
 * task that broke: a red footer and a Continue button nobody presses, while a timer they cannot
 * see is about to resume it. The hint lives in the DOCK, beside the paused/queued hints, because
 * that is where the thread already answers "what is expected of me right now?" — and the answer
 * here is "nothing".
 *
 * The absolute instant is the source of truth (`<time dateTime>`), not a relative countdown: the
 * wait is routinely hours, the deadline is server-computed, and a ticking number would say less
 * while re-rendering more. It is shown to the SECOND with the zone named, matching the monitoring
 * schedule line — a minute-precision "6:41 PM" cannot tell a wait that is nearly over from one
 * that just started.
 *
 * Two ways out, and both belong here rather than in Settings: **Don't resume** retires the
 * promise for THIS task (archiving the task does the same implicitly — that is what resigning
 * from a task means), and the settings link governs every future one. An automation the user did
 * not ask for has to be one click from being switched off, per task and per machine.
 *
 * Rendered only when the server actually armed a resume: `autoResumeAt` is absent whenever the
 * feature is off, the provider named no reset, the safety cap is spent, or the run failed for any
 * other reason — so this component never has to reason about any of those cases.
 */
export function AutoResumeHint({ run }: { run: ApiRun }) {
  const queryClient = useQueryClient()
  const cancel = useMutation({
    mutationFn: () => cancelAutoResume(run.id),
    onSuccess: () => {
      // The record's own update rides the run SSE, but the detail query is what this view reads
      // and an invalidate is the honest barrier for a mutation the user just clicked.
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.detail(run.id) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.list() })
      toast('This task will not resume itself')
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  if (run.status !== 'failed' || !run.autoResumeAt) return null
  const at = new Date(run.autoResumeAt)
  if (!Number.isFinite(at.getTime())) return null
  const label = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'long' }).format(at)
  return (
    <div
      data-slot="auto-resume-hint"
      role="status"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs text-muted-foreground"
    >
      <StatusDot tone="pending" pulse />
      <span>
        Usage limit reached — this task resumes automatically at{' '}
        <time dateTime={run.autoResumeAt} className="font-medium text-foreground">
          {label}
        </time>
      </span>
      <button
        type="button"
        data-action="auto-resume-cancel"
        disabled={cancel.isPending}
        onClick={() => cancel.mutate()}
        className="font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground disabled:opacity-50"
      >
        Don’t resume
      </button>
      {/* Global settings live OUTSIDE every project scope, so this is react-router's own Link:
          the scope-aware one would prefix it into `/p/<id>/settings/global/…`, which is not a
          route. Same reason `clone-project-dialog.tsx` reaches for `RouterLink`. */}
      <GlobalLink
        to="/settings/global/resources"
        data-slot="auto-resume-settings-link"
        className="font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
      >
        Auto-resume settings
      </GlobalLink>
    </div>
  )
}
