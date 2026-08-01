import type {
  CreateRunInput,
  ImageInput,
  PlanResponse,
  Runner,
  WorkflowStepDef,
} from '@open-mercato/cezar-api-client'

import { runnerOverride } from './new-task-form'

/**
 * Plan-mode logic (spec 008 / Implementation Plan step 14), kept pure so every rule is
 * table-testable: the pending-plan shape the /new route holds while the review overlay is up,
 * the list operations the overlay's reorder/remove controls apply, and the exact
 * `POST /api/runs` body a "▶ Start" sends — mirrored from the legacy `startPlannedRun`
 * (web/app.js) with the new form's runner rule.
 */

/** What the review overlay edits: the planner's answer plus what the user had typed/attached
 *  at submit time. Images captured here ride into the started run (legacy parity — the plan
 *  request itself never carries them). */
export interface PendingPlan {
  task: string
  steps: WorkflowStepDef[]
  rationale: string
  fallback: boolean
  images: ImageInput[]
}

export function pendingPlanOf(
  task: string,
  images: readonly ImageInput[],
  response: PlanResponse,
): PendingPlan {
  return {
    task,
    steps: [...response.steps],
    rationale: response.rationale,
    fallback: response.fallback,
    images: [...images],
  }
}

/** Remove the step at `index`. Out-of-range answers the input unchanged — a stale click on a
 *  card that just moved must not eat a neighbor. */
export function removeStep(steps: readonly WorkflowStepDef[], index: number): WorkflowStepDef[] {
  if (!Number.isInteger(index) || index < 0 || index >= steps.length) return [...steps]
  return steps.filter((_, i) => i !== index)
}

/** Move the step at `from` so it lands at `to` (legacy splice semantics: remove, then insert).
 *  `to` is clamped into the list; an invalid `from` or a no-op move answers the input order. */
export function moveStep(
  steps: readonly WorkflowStepDef[],
  from: number,
  to: number,
): WorkflowStepDef[] {
  const copy = [...steps]
  if (!Number.isInteger(from) || from < 0 || from >= copy.length) return copy
  const target = Math.max(0, Math.min(copy.length - 1, to))
  if (target === from) return copy
  const [moved] = copy.splice(from, 1)
  copy.splice(target, 0, moved!)
  return copy
}

/** The quiet second line of a step card — what the step will DO: the shell command for a
 *  check step, the prompt otherwise (exactly legacy's `s.command ?? s.prompt ?? ''`). */
export function stepHint(step: WorkflowStepDef): string {
  return step.command ?? step.prompt ?? ''
}

/** First line of the task, capped — the overlay's title line (legacy `oneLine`). */
export function planTaskLine(task: string, max = 120): string {
  const first = task.split('\n')[0] ?? ''
  return first.length > max ? `${first.slice(0, max - 1)}…` : first
}

/**
 * The exact `POST /api/runs` body for an approved plan: the edited steps INLINE (never a
 * workflow name — the chain may be unsaved), plus the composer's current picker choices under
 * the same rules as `buildCreateRunBody`: `model`/`variants`/`images` only when they say
 * something, explicit/sticky `runner` choices always sent (untouched defaults may be omitted),
 * `generateFollowups`
 * only when off (#444), and `todoId` only when the composer was prefilled from an inbox entry (#374 —
 * planning the follow-up first still starts it, so the entry must still be marked started).
 */
export function buildPlannedRunBody(opts: {
  task: string
  steps: readonly WorkflowStepDef[]
  model: string
  /** Native coding-agent settings stay visible, but a locked model is never a request override. */
  modelsLocked?: boolean
  runner: Runner
  /** True when the draft contains a sticky/user runner choice rather than an untouched default. */
  runnerExplicit?: boolean
  defaultRunner?: Runner
  variants: number
  images: readonly ImageInput[]
  generateFollowups?: boolean
  todoId?: string
}): CreateRunInput {
  const { task, steps, model, modelsLocked, runner, runnerExplicit, defaultRunner, variants, images, generateFollowups, todoId } =
    opts
  return {
    task,
    steps: [...steps],
    model: modelsLocked ? undefined : model || undefined,
    runner: runnerOverride(runner, defaultRunner, runnerExplicit),
    variants: variants > 1 ? variants : undefined,
    images: images.length > 0 ? [...images] : undefined,
    generateFollowups: generateFollowups === false ? false : undefined,
    todoId: todoId || undefined,
  }
}
