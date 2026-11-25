import * as React from 'react'

import { useAnswerCardGate, useApproveCardGate, usePatchCard, useRerunCard } from '@/api/frameworks'
import { useHealth } from '@/api/queries'
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
import { toast } from '@/components/ui/toaster'
import { nextStage, stageName, type CardRun, type OpenGate, type StageNames } from '@/lib/cards'

/**
 * The card actions that need a confirmation (spec 2026-11-15-framework-board): Approve & continue
 * (D9 names the change id and the stage for a framework gate) and Re-run from a stage. The board's
 * drops and the wizard's buttons go through the same dialog, so a drag never does more than a click.
 */

export type PendingCardAction =
  | { kind: 'approve'; run: CardRun; gate: OpenGate }
  | { kind: 'rerun'; run: CardRun; fromStage: string }

/** The change id the framework knows the card by (D9): its state, else the card's slug field. */
export function cardChangeId(run: CardRun): string | undefined {
  const slug = run.card.fields?.slug
  return run.card.frameworkState?.changeId ?? (typeof slug === 'string' ? slug : undefined)
}

export function useCardActions() {
  const [pending, setPending] = React.useState<PendingCardAction | null>(null)
  const approveFramework = useApproveCardGate()
  const answerGate = useAnswerCardGate()
  const rerun = useRerunCard()
  const patch = usePatchCard()
  const localHandoff = useHealth().data?.capabilities?.localHandoff !== false
  const fail = (error: Error) => toast(error.message, { tone: 'danger' })

  const confirm = () => {
    const action = pending
    setPending(null)
    if (!action) return
    if (action.kind === 'rerun') {
      rerun.mutate({ runId: action.run.id, fromStage: action.fromStage }, { onError: fail })
    } else if (action.gate.kind === 'framework') {
      approveFramework.mutate(action.run.id, { onError: fail })
    } else {
      answerGate.mutate({ run: action.run, decision: 'approve' }, { onError: fail })
    }
  }

  return {
    pending,
    setPending,
    confirm,
    localHandoff,
    busy: approveFramework.isPending || answerGate.isPending || rerun.isPending || patch.isPending,
    requestChanges: (run: CardRun, comment: string) => answerGate.mutate({ run, decision: 'reject', comment }, { onError: fail }),
    patch: (runId: string, body: Parameters<typeof patch.mutate>[0]['patch']) => patch.mutateAsync({ runId, patch: body }),
  }
}

export function CardConfirmDialog({
  pending,
  names,
  localHandoff,
  onCancel,
  onConfirm,
}: {
  pending: PendingCardAction | null
  names?: StageNames
  localHandoff: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const name = (id: string) => stageName(names, id)
  let title = ''
  let body: React.ReactNode = null
  let action = 'Confirm'
  let blocked: string | undefined
  if (pending?.kind === 'rerun') {
    title = `Re-run from ${name(pending.fromStage)}?`
    body = `“${pending.run.card.title}” goes back to ${name(pending.fromStage)} on the same branch. Loop counters are kept, so a re-run cannot loop forever.`
    action = `Re-run from ${name(pending.fromStage)}`
  } else if (pending?.kind === 'approve') {
    const next = nextStage(pending.run, pending.gate.stage)
    title = `Approve ${name(pending.gate.stage)}${next ? ` and start ${name(next)}` : ''}?`
    action = next ? `Approve & continue → ${name(next)}` : 'Approve'
    if (pending.gate.kind === 'framework') {
      const changeId = cardChangeId(pending.run) ?? 'this change'
      body = (
        <>
          cezar approves stage <strong>{name(pending.gate.stage)}</strong> of change <code className="font-mono">{changeId}</code> through the
          framework’s own script (non-interactive), then commits it on {pending.run.branch ? <code className="font-mono">{pending.run.branch}</code> : 'the card’s branch'}. The
          card’s history records you as the approver.
        </>
      )
      if (!localHandoff) blocked = 'Approving a framework gate runs a script in the checkout — do it from the machine that owns it.'
    } else {
      body = `“${pending.run.card.title}” continues${next ? ` with ${name(next)}` : ''}.`
    }
  }
  return (
    <AlertDialog open={pending !== null} onOpenChange={(open) => (open ? undefined : onCancel())}>
      <AlertDialogContent data-slot="card-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-2">
              <p>{body}</p>
              {blocked ? <p className="text-danger">{blocked}</p> : null}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={Boolean(blocked)} onClick={onConfirm}>
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
