import { useQueryClient } from '@tanstack/react-query'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  GripVerticalIcon,
  PlayIcon,
  XIcon,
} from 'lucide-react'
import { useState, type DragEvent, type ReactNode } from 'react'

import { ApiError, createWorkflow } from '@/api/client'
import { queryKeys } from '@/api/queries'
import type { WorkflowStepDef } from '@open-mercato/cezar-api-client'
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
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import { cn } from '@/lib/utils'

import { moveStep, planTaskLine, removeStep, stepHint, type PendingPlan } from './new-task-plan'

/**
 * The plan review overlay (spec 008 parity, Implementation Plan step 14): a FULL-SCREEN surface
 * over the app — the spec moved it out of the legacy sidebar because step names and prompts
 * were truncated to uselessness there. Desktop: a roomy centered panel; mobile: an edge-to-edge
 * sheet. Numbered draggable step cards (grip / name / skill·check badges / prompt-or-command
 * hint / ✕), then ▶ Start · Save as chain · Discard.
 *
 * Reordering: HTML5 drag-and-drop, exactly the legacy mechanism — nothing heavier is installed
 * (no dnd-kit in the tree) and a ≤5-item list doesn't justify a new dependency. HTML5 DnD never
 * fires on touch, so every card also carries ↑/↓ move buttons — the touch- and keyboard-honest
 * path, and the one the e2e drives.
 */
export interface PlanReviewProps {
  plan: PendingPlan
  /** True while ▶ Start's POST is in flight. */
  starting: boolean
  /** Provider status has confirmed at least one backend can start the reviewed plan. */
  startAvailable: boolean
  startUnavailableReason?: string
  startUnavailableAction?: ReactNode
  onStepsChange: (steps: WorkflowStepDef[]) => void
  onStart: () => void
  /** Also fired by Escape and the ×. The parent keeps the draft — discard loses nothing. */
  onDiscard: () => void
}

export function PlanReview({
  plan,
  starting,
  startAvailable,
  startUnavailableReason,
  startUnavailableAction,
  onStepsChange,
  onStart,
  onDiscard,
}: PlanReviewProps) {
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)

  const endDrag = () => {
    setDragIndex(null)
    setOverIndex(null)
  }
  const drop = (event: DragEvent, to: number) => {
    event.preventDefault()
    if (dragIndex !== null && dragIndex !== to) onStepsChange(moveStep(plan.steps, dragIndex, to))
    endDrag()
  }

  const empty = plan.steps.length === 0

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onDiscard())}>
      <DialogContent
        data-slot="plan-review"
        showCloseButton={false}
        className={cn(
          // Mobile: an edge-to-edge full-screen sheet (100dvh grid, only the steps scroll).
          'top-0 left-0 flex h-dvh w-full max-w-full translate-x-0 translate-y-0 flex-col gap-0 rounded-none p-0',
          // Desktop: the roomy centered panel.
          'sm:top-1/2 sm:left-1/2 sm:h-auto sm:max-h-[85dvh] sm:max-w-[680px] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl',
        )}
      >
        <DialogHeader className="gap-1 border-b border-border px-5 pt-4 pb-3.5 text-left sm:text-left">
          <div className="flex items-start justify-between gap-3">
            <DialogTitle className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
              Proposed chain
            </DialogTitle>
            <DialogClose
              aria-label="Discard the plan"
              className="-mt-1 -mr-1 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <XIcon aria-hidden="true" className="size-4" />
            </DialogClose>
          </div>
          <DialogDescription
            data-slot="plan-task"
            title={plan.task}
            className="truncate text-[13.5px] font-medium text-foreground"
          >
            {planTaskLine(plan.task)}
          </DialogDescription>
          {plan.fallback ? (
            <p data-slot="plan-fallback" className="text-xs text-soft-foreground italic">
              planner unavailable — single-step plan
            </p>
          ) : plan.rationale !== '' ? (
            <p data-slot="plan-rationale" className="text-xs text-muted-foreground">
              {plan.rationale}
            </p>
          ) : null}
        </DialogHeader>

        <ol data-slot="plan-steps" className="flex-1 space-y-2 overflow-y-auto px-5 py-4">
          {empty ? (
            <li className="py-6 text-center text-sm text-muted-foreground">
              (no steps left — discard and plan again)
            </li>
          ) : (
            plan.steps.map((step, index) => (
              <li
                key={step.id}
                data-slot="plan-step"
                data-step-id={step.id}
                draggable
                onDragStart={() => setDragIndex(index)}
                onDragOver={(event) => {
                  event.preventDefault()
                  setOverIndex(index)
                }}
                onDragLeave={() => setOverIndex((current) => (current === index ? null : current))}
                onDrop={(event) => drop(event, index)}
                onDragEnd={endDrag}
                className={cn(
                  'flex items-center gap-2.5 rounded-lg border border-border bg-card-2 px-3 py-2.5',
                  dragIndex === index && 'opacity-50',
                  overIndex === index && dragIndex !== null && dragIndex !== index && 'border-ring',
                )}
              >
                <GripVerticalIcon
                  aria-hidden="true"
                  className="size-3.5 shrink-0 cursor-grab text-soft-foreground"
                />
                <span className="w-5 shrink-0 font-mono text-[11px] text-soft-foreground tabular-nums">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-semibold">
                      {step.name ?? step.id}
                    </span>
                    {step.skill ? (
                      <span
                        data-slot="plan-badge-skill"
                        title="skill"
                        className="shrink-0 rounded-full bg-violet/15 px-1.5 py-px font-mono text-[10.5px] font-medium text-violet"
                      >
                        {step.skill}
                      </span>
                    ) : null}
                    {step.command ? (
                      <span
                        data-slot="plan-badge-check"
                        className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10.5px] font-medium text-muted-foreground"
                      >
                        check
                      </span>
                    ) : null}
                  </div>
                  <p className="truncate font-mono text-[11.5px] text-muted-foreground">
                    {stepHint(step)}
                  </p>
                </div>
                <span className="flex shrink-0 items-center">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    data-slot="plan-step-up"
                    aria-label={`Move step ${index + 1} up`}
                    disabled={index === 0}
                    className="size-7 text-muted-foreground"
                    onClick={() => onStepsChange(moveStep(plan.steps, index, index - 1))}
                  >
                    <ArrowUpIcon aria-hidden="true" className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    data-slot="plan-step-down"
                    aria-label={`Move step ${index + 1} down`}
                    disabled={index === plan.steps.length - 1}
                    className="size-7 text-muted-foreground"
                    onClick={() => onStepsChange(moveStep(plan.steps, index, index + 1))}
                  >
                    <ArrowDownIcon aria-hidden="true" className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    data-slot="plan-step-remove"
                    aria-label={`Remove step ${index + 1}`}
                    className="size-7 text-muted-foreground hover:text-danger"
                    onClick={() => onStepsChange(removeStep(plan.steps, index))}
                  >
                    <XIcon aria-hidden="true" className="size-3.5" />
                  </Button>
                </span>
              </li>
            ))
          )}
        </ol>

        {!startAvailable && startUnavailableReason ? (
          <p
            id="plan-start-guidance"
            className="flex flex-wrap items-center gap-1.5 border-t border-border px-5 pt-3 text-xs text-muted-foreground"
          >
            <span>{startUnavailableReason}</span>
            {startUnavailableAction}
          </p>
        ) : null}
        <div className="flex items-center gap-2 px-5 py-3.5 pb-[max(14px,env(safe-area-inset-bottom))]">
          <Button
            type="button"
            data-slot="plan-start"
            disabled={empty || starting || !startAvailable}
            title={!startAvailable ? startUnavailableReason : undefined}
            aria-describedby={
              !startAvailable && startUnavailableReason ? 'plan-start-guidance' : undefined
            }
            onClick={onStart}
          >
            <PlayIcon aria-hidden="true" className="size-3.5" />
            {starting ? 'Starting…' : 'Start'}
          </Button>
          <SaveAsChain steps={plan.steps} disabled={empty} />
          <Button type="button" variant="ghost" className="ml-auto" onClick={onDiscard}>
            Discard
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Save as chain: a Dialog asks for the name (never a native prompt), `POST /api/workflows`
 * saves; a 409 (`exists`) opens the overwrite confirm and a Yes retries with `overwrite: true`.
 * The review stays open afterwards — saving and starting are independent decisions.
 */
function SaveAsChain({ steps, disabled }: { steps: WorkflowStepDef[]; disabled: boolean }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [confirmOverwrite, setConfirmOverwrite] = useState(false)
  const [saving, setSaving] = useState(false)

  const save = async (overwrite: boolean) => {
    const trimmed = name.trim()
    if (trimmed === '' || saving) return
    setSaving(true)
    try {
      const saved = await createWorkflow({
        name: trimmed,
        steps,
        ...(overwrite ? { overwrite: true } : {}),
      })
      toast(`Saved — ${saved.path.split('/').pop() ?? saved.path}`)
      // The picker on /new lists workflows from this cache — the new chain must appear.
      void queryClient.invalidateQueries({ queryKey: queryKeys.workflows })
      setConfirmOverwrite(false)
      setOpen(false)
      setName('')
    } catch (error) {
      if (error instanceof ApiError && error.exists === true) {
        setConfirmOverwrite(true)
      } else {
        toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        data-slot="plan-save"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        Save as chain
      </Button>

      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : setOpen(false))}>
        <DialogContent data-slot="plan-save-dialog" className="sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Save as chain</DialogTitle>
            <DialogDescription>
              Saves these steps as a reusable workflow — it joins the picker like any other chain.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void save(false)
            }}
          >
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-label="Chain name"
              placeholder="e.g. fix-and-verify-v2"
              maxLength={80}
              autoFocus
            />
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={name.trim() === '' || saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirmOverwrite}
        onOpenChange={(next) => (next ? undefined : setConfirmOverwrite(false))}
      >
        <AlertDialogContent data-slot="plan-overwrite-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Overwrite “{name.trim()}”?</AlertDialogTitle>
            <AlertDialogDescription>
              A chain with this name already exists. Overwriting replaces its steps with this
              plan.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep the existing chain</AlertDialogCancel>
            <AlertDialogAction onClick={() => void save(true)}>Overwrite</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
