import type { ApiRun, ModelUsage } from '@open-mercato/cezar-api-client'

/**
 * The model a run ACTUALLY ran on, as its agent reported it (`RunRecord.actualModel`,
 * `StepState.actualModel`/`modelsUsed`), next to the model it asked for (`run.model`, '' or
 * absent = auto). The server folds the reports (`src/runs/reported-model.ts`); this is display.
 */

/** `anthropic/claude-opus-5-5`, `claude-opus-5-5[1m]` and `claude-opus-5-5` name one model. */
export function baseModelId(model: string): string {
  return model.trim().replace(/\[[^\]]*\]$/, '').replace(/^[^/]+\//, '').toLowerCase()
}

export function sameModelId(a: string, b: string): boolean {
  return baseModelId(a) === baseModelId(b)
}

/** The run's actual model: the record's, else a fallback (the thread's `session.started` on runs
 *  recorded before the field existed). */
export function runActualModel(run: Pick<ApiRun, 'actualModel'>, fallback?: string): string | undefined {
  return run.actualModel || fallback || undefined
}

/** "auto → claude-opus-5-5", "opus → claude-opus-5-5"; just the model when the two agree or
 *  nothing was reported. */
export function requestedToActual(requested: string, actual: string | undefined): string {
  if (!actual || sameModelId(requested, actual)) return requested
  return `${requested} → ${actual}`
}

export interface StepModelRow {
  stepId: string
  name: string
  actual: string
  /** The step's other models (a Haiku sub-call, an earlier model before a switch). */
  others: ModelUsage[]
}

/** One row per step that reported a model, in step order — the badge menu's per-step list. */
export function stepModelRows(run: Pick<ApiRun, 'steps'>): StepModelRow[] {
  return run.steps.flatMap((step) => {
    const actual = step.actualModel ?? step.modelsUsed?.[0]?.model
    if (!actual) return []
    const others = (step.modelsUsed ?? []).filter((entry) => !sameModelId(entry.model, actual))
    return [{ stepId: step.id, name: step.name, actual, others }]
  })
}

/** Every model the run used other than the current one — earlier mains and side models. */
export function otherRunModels(run: Pick<ApiRun, 'modelsUsed'>, actual: string | undefined): string[] {
  return (run.modelsUsed ?? []).filter((model) => !actual || !sameModelId(model, actual))
}

/** "Model: auto → claude-opus-5-5" for a row's hover, or undefined when no agent reported one. */
export function runModelLine(run: Pick<ApiRun, 'model' | 'actualModel'>): string | undefined {
  if (!run.actualModel) return undefined
  return `Model: ${requestedToActual(run.model || 'auto', run.actualModel)}`
}

/** A row's hover title with the actual-model line beneath it, when one is known. */
export function titleWithModel(title: string, run: Pick<ApiRun, 'model' | 'actualModel'>): string {
  const line = runModelLine(run)
  return line ? `${title}\n${line}` : title
}
