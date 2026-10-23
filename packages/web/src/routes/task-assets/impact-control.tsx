import { FileSearchIcon, LoaderCircleIcon, RefreshCwIcon } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useMemo, useState } from 'react'

import { impactSubjectKey } from '@/api/client'
import { queryKeys, useImpactForSubject, useRuns, useStartImpact } from '@/api/queries'
import type { ApiRun, ImpactSubjectInput } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Link, useNavigate } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { impactAssetsPath, impactState } from './impact-model'

/**
 * Assess / Assessing… / Open impact / Stale — ONE control for every entry point (spec
 * 2026-10-22-html-artifacts-and-impact § UI/UX: PR detail, Git → Files). `unavailable` is a
 * prerequisite the host already knows is missing (no GitHub): the actions render disabled with that
 * reason as visible text, as does a refused `POST /impact`.
 */
export function ImpactControl({
  subject,
  unavailable,
  className,
}: {
  subject: ImpactSubjectInput
  unavailable?: string
  className?: string
}) {
  const key = impactSubjectKey(subject)
  const answer = useImpactForSubject(subject)
  const runId = answer.data?.run?.id
  // The stream-patched runs list moves first; the subject answer is only refetched on demand.
  const liveStatus = useRuns(
    useMemo(() => (runs: ApiRun[]) => (runId ? runs.find((run) => run.id === runId)?.status : undefined), [runId]),
  ).data
  const state = impactState(answer.data, { pending: answer.isPending, error: answer.error, liveStatus })
  // The live status moved past the answer's (Assessing… → done): one authoritative refetch picks up
  // `stale` and anything the artifacts frame did not carry. Event-driven, never a poll.
  const queryClient = useQueryClient()
  const answerStatus = answer.data?.run?.status
  useEffect(() => {
    if (liveStatus === undefined || answerStatus === undefined || liveStatus === answerStatus) return
    void queryClient.invalidateQueries({ queryKey: queryKeys.runs.impactSubject(key) })
  }, [answerStatus, key, liveStatus, queryClient])
  const reasonId = useId()

  const start = useStartImpact()
  // A refusal belongs to the subject it was about; another PR or spec starts clean.
  const [refusal, setRefusal] = useState<{ key: string; message: string } | null>(null)
  const refused = refusal?.key === key ? refusal.message : undefined
  const blocked = unavailable ?? refused
  const navigate = useNavigate()

  const assess = () => {
    if (blocked || start.isPending) return
    start.mutate(
      { subject },
      { onError: (error) => setRefusal({ key, message: error instanceof Error ? error.message : String(error) }) },
    )
  }

  const assessButton = (label: string, variant: 'primary' | 'outline') => (
    <Button
      type="button"
      size="sm"
      variant={variant}
      data-action="impact-assess"
      disabled={Boolean(blocked) || start.isPending}
      aria-busy={start.isPending || undefined}
      aria-describedby={blocked ? reasonId : undefined}
      onClick={assess}
    >
      {start.isPending ? (
        <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />
      ) : label === 'Re-assess' ? (
        <RefreshCwIcon aria-hidden="true" />
      ) : (
        <FileSearchIcon aria-hidden="true" />
      )}
      {label}
    </Button>
  )

  return (
    <div
      data-slot="impact-control"
      data-state={state.kind === 'open' && state.stale ? 'stale' : state.kind}
      className={cn('flex flex-wrap items-center gap-2 text-xs', className)}
    >
      {state.kind === 'loading' ? (
        <span className="text-soft-foreground">Checking impact…</span>
      ) : state.kind === 'error' ? (
        <span data-slot="impact-error" className="text-danger">Could not check impact: {state.message}</span>
      ) : state.kind === 'assessing' ? (
        <>
          <span
            data-slot="impact-assessing"
            role="status"
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2 py-0.5 font-medium"
          >
            <LoaderCircleIcon aria-hidden="true" className="size-3 motion-safe:animate-spin" />
            Assessing…
          </span>
          <Button asChild size="sm" variant="outline">
            <Link data-action="impact-go-to-task" to={`/tasks/${state.runId}`}>
              Go to task
            </Link>
          </Button>
        </>
      ) : state.kind === 'open' ? (
        <>
          {state.stale ? (
            <span
              data-slot="impact-stale"
              title="The subject changed since this assessment"
              className="rounded-full border border-pending-strong/45 bg-pending-strong/10 px-2 py-0.5 font-medium text-pending-strong"
            >
              Stale
            </span>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant={state.stale ? 'outline' : 'primary'}
            data-action="impact-open"
            onClick={() => navigate(impactAssetsPath(state.runId))}
          >
            Open impact
          </Button>
          {assessButton('Re-assess', state.stale ? 'primary' : 'outline')}
          <span data-slot="impact-meta" className="font-mono text-[11px] text-soft-foreground">
            {state.meta}
          </span>
        </>
      ) : (
        <>
          {assessButton('Assess impact', 'primary')}
          {state.note ? (
            <span data-slot="impact-note" className="text-soft-foreground">
              {state.note}{' '}
              {state.runId ? (
                <Link to={`/tasks/${state.runId}`} className="underline underline-offset-2 hover:text-foreground">
                  Go to task
                </Link>
              ) : null}
            </span>
          ) : null}
        </>
      )}
      {blocked && state.kind !== 'loading' && state.kind !== 'error' && state.kind !== 'assessing' ? (
        <span id={reasonId} data-slot="impact-reason" className="basis-full text-soft-foreground">
          {blocked}
        </span>
      ) : null}
    </div>
  )
}
