import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckIcon, ChevronRightIcon, ScaleIcon, SearchXIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useParams } from 'react-router'

import { Link, useNavigate } from '@/lib/project-router'

import { ApiError, pickVariant } from '@/api/client'
import { queryKeys, useGroup, useHealth, useRuns } from '@/api/queries'
import type { GroupVariant } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { DirectionalUsage } from '@/components/directional-usage'
import { Pill } from '@/components/pill'
import { RunDiff } from '@/components/run-diff'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { toast } from '@/components/ui/toaster'
import { deriveAttention } from '@/lib/attention'
import { groupTitle } from '@/lib/task-groups'
import { TERMINAL_STATUSES, formatCost } from '@/lib/tasks-table'
import { usageMetricVisibility } from '@/lib/token-metrics'
import { cn } from '@/lib/utils'

import { Markdown } from './task-thread/markdown'
import { CompareLoading } from './compare-loading'

/**
 * `/compare/:groupId` — the variants compare view (spec 010, §"Task thread" variants bullet),
 * the legacy `renderCompareView` restyled: a column per variant — letter badge, status pill
 * (the ONE `deriveAttention`), tokens/cost, the server's `git diff --stat` text (labeled as
 * git's own summary — it is NOT this UI's ± stat), the handoff Progress excerpt — and the full
 * diffs below as collapsibles per variant, reusing the review gate's file cards (`RunDiff`).
 *
 * "✔ Pick this one" is the single accent CTA per column. It stays disabled until EVERY variant
 * is terminal, mirroring the server's gate (`POST /pick` 409s while the picked run is active;
 * picking early would also cancel siblings mid-work) — and always behind a confirm, because the
 * losers' worktrees and branches are removed with no undo. The winner parks at `review`, so on
 * success this navigates to its thread, where the review gate renders.
 */
export function CompareVariantsRoute() {
  const { groupId } = useParams<{ groupId: string }>()
  const group = useGroup(groupId)
  const health = useHealth()
  const metricVisibility = usageMetricVisibility(health.data)
  const queryClient = useQueryClient()

  // Freshness without polling (the sync doctrine): the group endpoint is not on the SSE stream,
  // but the runs list IS (stream-patched in place). Watching the members' status/archived pairs
  // there and invalidating the group query when they move keeps the columns and the pick gate
  // live while variants finish — one refetch per real transition, zero timers.
  const runs = useRuns()
  const memberStates = (runs.data ?? [])
    .filter((run) => run.groupId === groupId)
    .map((run) => `${run.id}:${run.status}:${run.archived}`)
    .sort()
    .join(',')
  useEffect(() => {
    if (!groupId) return
    void queryClient.invalidateQueries({ queryKey: queryKeys.groups.detail(groupId) })
  }, [queryClient, groupId, memberStates])

  if (group.isPending) return <CompareLoading />

  if (group.isError) {
    const notFound = group.error instanceof ApiError && group.error.status === 404
    return (
      <div data-route="compare" className="flex min-h-full flex-col">
        <CenteredState
          icon={notFound ? <SearchXIcon /> : <ScaleIcon />}
          tone={notFound ? 'neutral' : 'danger'}
          title={notFound ? 'No such variant group' : 'Could not load the variants'}
          subtitle={
            notFound
              ? 'No runs share this group id. The group may have been deleted, or a winner was already picked and the others removed.'
              : group.error.message
          }
          actions={
            <Button asChild variant="outline">
              <Link to="/">Back to tasks</Link>
            </Button>
          }
        />
      </div>
    )
  }

  return (
    <CompareView
      groupId={groupId as string}
      variants={group.data.runs}
      showTokens={metricVisibility.tokens}
      showCost={metricVisibility.cost}
    />
  )
}

function CompareView({
  groupId,
  variants,
  showTokens,
  showCost,
}: {
  groupId: string
  variants: GroupVariant[]
  showTokens: boolean
  showCost: boolean
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState<GroupVariant | null>(null)

  const allTerminal = variants.every((variant) => TERMINAL_STATUSES.has(variant.status))
  const title = variants[0] ? groupTitle(variants[0]) : ''

  const pick = useMutation({
    mutationFn: (runId: string) => pickVariant(groupId, runId),
    onSuccess: (result, runId) => {
      // The losers changed (cancelled/archived/worktree-less) and the winner may now be at
      // review — refetch everything derived from runs, then land on the winner's thread.
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
      void queryClient.invalidateQueries({ queryKey: queryKeys.groups.detail(groupId) })
      void navigate(`/tasks/${result.winner?.id ?? runId}`)
    },
    // The server's words verbatim — "this variant is still active — wait for it to finish
    // first" was written for the person reading it.
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  return (
    <div data-route="compare" className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-5 md:px-6">
      <header className="flex flex-col gap-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <ScaleIcon className="size-5 shrink-0 text-violet" aria-hidden="true" />
          <span className="min-w-0 truncate" title={title}>
            {title}
          </span>
        </h1>
        <p className="text-[13px] text-muted-foreground">
          {variants.length} variants of the same task, each in its own worktree — pick the diff you
          want to keep. The others are cancelled and archived, their worktrees and branches removed.
        </p>
      </header>

      <div
        data-slot="compare-columns"
        className={cn(
          'grid grid-cols-1 gap-3',
          variants.length >= 3 ? 'md:grid-cols-3' : 'md:grid-cols-2',
        )}
      >
        {variants.map((variant) => (
          <VariantColumn
            key={variant.id}
            variant={variant}
            allTerminal={allTerminal}
            pickPending={pick.isPending}
            onPick={() => setConfirming(variant)}
            showTokens={showTokens}
            showCost={showCost}
          />
        ))}
      </div>

      <section aria-label="Full diffs" className="flex flex-col gap-2">
        {variants.map((variant) => (
          <VariantDiff key={variant.id} variant={variant} />
        ))}
      </section>

      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Pick variant {confirming?.variant}?</AlertDialogTitle>
            <AlertDialogDescription>
              Variant {confirming?.variant}'s changes go to the review gate. The other{' '}
              {variants.length - 1 === 1 ? 'variant is' : `${variants.length - 1} variants are`}{' '}
              cancelled if still open, archived, and their worktrees and branches removed. There is
              no undo.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep comparing</AlertDialogCancel>
            <AlertDialogAction
              data-slot="confirm-pick"
              onClick={() => {
                if (confirming) pick.mutate(confirming.id)
                setConfirming(null)
              }}
            >
              <CheckIcon aria-hidden="true" />
              Pick variant {confirming?.variant}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** One variant column: letter, status, spend, git's own --stat summary, the Progress excerpt,
 *  and the accent CTA. */
function VariantColumn({
  variant,
  allTerminal,
  pickPending,
  onPick,
  showTokens,
  showCost,
}: {
  variant: GroupVariant
  allTerminal: boolean
  pickPending: boolean
  onPick: () => void
  showTokens: boolean
  showCost: boolean
}) {
  const attention = deriveAttention(variant)
  const cost = formatCost(variant.costUsd)
  const hasDirectionalUsage = variant.inputTokens !== undefined || variant.outputTokens !== undefined
  return (
    <article
      data-slot="variant-column"
      data-variant={variant.variant}
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-3.5 shadow-xs"
    >
      <div className="flex items-center gap-2">
        <span
          data-slot="variant-letter"
          aria-label={`Variant ${variant.variant}`}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-violet/15 font-mono text-xs font-semibold text-violet"
        >
          {variant.variant}
        </span>
        <Pill dot={attention.tone} pulse={attention.pulse}>
          {attention.label}
        </Pill>
        {(showTokens && hasDirectionalUsage) || (showCost && cost) ? (
          <span
            data-slot="variant-token-metrics"
            className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] text-soft-foreground"
          >
            {showTokens ? (
              <DirectionalUsage
                inputTokens={variant.inputTokens}
                outputTokens={variant.outputTokens}
              />
            ) : null}
            {showTokens && hasDirectionalUsage && showCost && cost ? (
              <span aria-hidden="true">·</span>
            ) : null}
            {showCost && cost ? <span className="font-mono tabular-nums">{cost}</span> : null}
          </span>
        ) : null}
      </div>

      {/* Honestly labeled: this block is git's own `git diff --stat` output from the variant's
          worktree, not this UI's ± stat — the numbers can disagree with a partial fetch. */}
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-[10.5px] font-semibold tracking-[0.04em] text-soft-foreground uppercase">
          git diff --stat
        </span>
        <pre
          data-slot="variant-diffstat"
          className="max-h-36 overflow-auto rounded-md bg-muted/60 px-2.5 py-2 font-mono text-[11px] leading-[1.6] whitespace-pre text-muted-foreground"
        >
          {variant.diffStat.trimEnd() || '(no changes)'}
        </pre>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-[10.5px] font-semibold tracking-[0.04em] text-soft-foreground uppercase">
          Progress
        </span>
        {variant.handoffExcerpt ? (
          <div
            data-slot="variant-progress"
            className="max-h-28 min-w-0 overflow-hidden text-[12.5px] text-muted-foreground [mask-image:linear-gradient(to_bottom,black_75%,transparent)]"
          >
            <Markdown>{variant.handoffExcerpt}</Markdown>
          </div>
        ) : (
          <p data-slot="variant-progress" className="text-xs text-soft-foreground">
            (no progress notes)
          </p>
        )}
      </div>

      <Button
        data-slot="variant-pick"
        title={
          allTerminal
            ? `Keep variant ${variant.variant}'s changes and archive the others`
            : 'Every variant must finish before you can pick'
        }
        disabled={!allTerminal || pickPending}
        onClick={onPick}
      >
        <CheckIcon aria-hidden="true" />
        Pick this one
      </Button>
    </article>
  )
}

/** A variant's full worktree diff, collapsed by default — `RunDiff` mounts (and fetches) only
 *  on first expand, so opening the compare view costs three stats, not three full diffs. */
function VariantDiff({ variant }: { variant: GroupVariant }) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      data-slot="variant-diff"
      data-variant={variant.variant}
      className="min-w-0 overflow-hidden rounded-lg border border-border bg-card"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-[13px] font-medium hover:bg-muted/50">
        <ChevronRightIcon
          className={cn('size-3.5 shrink-0 text-soft-foreground transition-transform', open && 'rotate-90')}
          aria-hidden="true"
        />
        Variant {variant.variant} — full diff
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t border-border/50 px-3 py-3">
          <RunDiff runId={variant.id} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
