import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckIcon, ChevronRightIcon, ScaleIcon, SearchXIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useParams } from 'react-router'

import { Link, useNavigate } from '@/lib/project-router'

import { ApiError, pickVariant } from '@/api/client'
import { queryKeys, useGroup, useHealth, useRuns } from '@/api/queries'
import type { GroupVariant } from '@open-mercato/cezar-api-client'
import { DirectionalUsage } from '@/components/directional-usage'
import { ListEmpty, ListFrame, TaskStatusBadge } from '@/components/list-view'
import { Page, PageBody, PageHeader, PageSection } from '@/components/page'
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
      <Page data-route="compare">
        <PageBody className="flex flex-col pt-8">
          <ListEmpty
            icon={notFound ? <SearchXIcon /> : <ScaleIcon />}
            tone={notFound ? 'neutral' : 'danger'}
            title={notFound ? 'No such variant group' : 'Could not load the variants'}
            description={
              notFound
                ? 'No runs share this group id. The group may have been deleted, or a winner was already picked and the others removed.'
                : group.error.message
            }
            action={
              <Button asChild variant="outline">
                <Link to="/">Back to tasks</Link>
              </Button>
            }
          />
        </PageBody>
      </Page>
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
    <Page data-route="compare">
      <PageHeader
        eyebrow={
          <span className="inline-flex items-center gap-1.5">
            <ScaleIcon className="size-3.5" aria-hidden="true" />
            Compare variants
          </span>
        }
        title={<span title={title}>{title}</span>}
        description={
          <>
            {variants.length} variants of the same task, each in its own worktree. Pick the one you want to
            keep — the others are cancelled and archived, their worktrees and branches removed.
          </>
        }
      />

      <PageBody>
        <div
          data-slot="compare-columns"
          className={cn('grid grid-cols-1 gap-4', variants.length >= 3 ? 'lg:grid-cols-3' : 'md:grid-cols-2')}
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
        {allTerminal ? null : (
          <p data-slot="compare-wait-note" className="pt-3 text-[13px] text-muted-foreground">
            You can pick once every variant has finished.
          </p>
        )}

        <PageSection title="Full diffs" description="Every change each variant made, file by file.">
          <ListFrame aria-label="Full diffs" className="divide-y divide-border">
            {variants.map((variant) => (
              <VariantDiff key={variant.id} variant={variant} />
            ))}
          </ListFrame>
        </PageSection>
      </PageBody>

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
    </Page>
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
      className="flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-card p-5 shadow-xs"
    >
      <div className="flex items-center gap-2">
        <span
          data-slot="variant-letter"
          aria-label={`Variant ${variant.variant}`}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-[13px] font-semibold text-foreground"
        >
          {variant.variant}
        </span>
        <span className="text-[15px] font-semibold text-foreground">Variant {variant.variant}</span>
        <TaskStatusBadge attention={attention} className="ml-auto" />
      </div>

      {/* Honestly labeled: this block is git's own `git diff --stat` output from the variant's
          worktree, not this UI's ± stat — the numbers can disagree with a partial fetch. */}
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">Changes, from git diff --stat</span>
        <pre
          data-slot="variant-diffstat"
          className="max-h-40 overflow-auto rounded-md bg-muted/60 px-3 py-2.5 font-mono text-[11px] leading-[1.7] whitespace-pre text-muted-foreground"
        >
          {variant.diffStat.trimEnd() || 'No changes'}
        </pre>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">Progress notes</span>
        {variant.handoffExcerpt ? (
          <div
            data-slot="variant-progress"
            className="max-h-32 min-w-0 overflow-hidden text-[13px] text-muted-foreground [mask-image:linear-gradient(to_bottom,black_75%,transparent)]"
          >
            <Markdown>{variant.handoffExcerpt}</Markdown>
          </div>
        ) : (
          <p data-slot="variant-progress" className="text-[13px] text-soft-foreground">
            No progress notes
          </p>
        )}
      </div>

      {(showTokens && hasDirectionalUsage) || (showCost && cost) ? (
        <span
          data-slot="variant-token-metrics"
          className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
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

      <Button
        variant="outline"
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
      className="min-w-0"
    >
      <CollapsibleTrigger className="flex min-h-11 w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm font-medium hover:bg-muted/50 sm:px-5">
        <ChevronRightIcon
          className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
          aria-hidden="true"
        />
        Variant {variant.variant}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t border-border px-3 py-3 sm:px-4">
          <RunDiff runId={variant.id} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
