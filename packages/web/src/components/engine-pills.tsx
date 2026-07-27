import { useConfig, useHealth, useProviderStatus, useRunnerModels } from '@/api/queries'
import type { CreateRunInput, Runner } from '@open-mercato/cezar-api-client'
import { PickerPill, RunnerPill } from '@/components/picker-pill'
import { usableRunners } from '@/lib/provider-status'
import {
  modelsForRunner,
  modelCatalogStatus,
  resolveModel,
  resolveRunner,
} from '@/routes/new-task-form'

/**
 * The runner + model pill pair for the surfaces that START a run outside the /new composer
 * (#401): the Inbox card's "▶ Run" and the GitHub tab's "Run agent on this issue/PR".
 *
 * It exists so those two cannot drift from the composer: the resolution quartet
 * (`usableRunners` → `resolveRunner` → `modelsForRunner` → `resolveModel`) and the
 * "hide the runner pill on a single-backend host" rule live here once, read from the same
 * provider/health/config queries new-task.tsx reads. The composer itself keeps its own inline copy —
 * it threads the pills through a persisted draft and a variants pill this pair has no notion of.
 *
 * The caller owns the pick (`null` = never touched, so the configured default shows through);
 * this component only resolves and renders. `useResolvedEngine` hands back what the POST body
 * needs, so the pick and the thing sent to the server can never disagree.
 */

/** What the user actually touched. `null` on either field means "never touched". */
export interface EnginePick {
  runner: Runner | null
  model: string | null
}

/** The effective backend, plus what the body rules need to decide what to send. */
export interface ResolvedEngine {
  runner: Runner
  model: string
  /** The backends this host offers — the runner pill renders only when there is a choice. */
  runners: readonly Runner[]
  /** What the server would pick on its own, once health has authoritatively reported it. */
  defaultRunner?: Runner
  /** True only after provider status confirms at least one connected backend. */
  canRun: boolean
  providerPending: boolean
  providerError: boolean
}

export function useResolvedEngine(pick: EnginePick): ResolvedEngine {
  const health = useHealth()
  const providers = useProviderStatus()
  const config = useConfig()
  const catalog = useRunnerModels()
  const runners = usableRunners(providers.data)
  const defaultRunner = health.data?.defaultRunner
  const runner = resolveRunner(pick.runner, runners, defaultRunner ?? runners[0] ?? 'claude')
  return {
    runner,
    model: resolveModel(pick.model, runner, config.data?.defaultModels, catalog.data),
    runners,
    defaultRunner,
    canRun: providers.isSuccess && runners.length > 0,
    providerPending: providers.isPending,
    providerError: providers.isError,
  }
}

/**
 * The runner/model fields of a create-run body. The one place these rules live, so the Inbox
 * and the GitHub tab cannot disagree.
 *
 *  - `model`: auto (`''`) stays implicit — the composer's rule, verbatim.
 *  - `runner`: omitted only when it IS what the server would choose anyway.
 *
 * That second rule is deliberately NOT the composer's `runnerCount > 1 ? runner : undefined`.
 * Counting backends answers "is there a choice to make", which is the right question for
 * *rendering the pill* and the wrong one for *omitting the field*: the two diverge exactly
 * when the configured `defaultRunner` is disconnected. Then `resolveRunner` falls back to a
 * connected backend and the model pill lists ITS presets — but the count is 1, so no runner is
 * sent, and the server resolves the omitted field back to the disconnected default. Comparing
 * against the authoritative health default preserves omission when it is safe and explicitly
 * sends the provider-status fallback when it is not.
 *
 * `buildCreateRunBody` still has the original hole; this only fixes the surfaces it feeds.
 */
export function engineBody(resolved: ResolvedEngine): Pick<CreateRunInput, 'runner' | 'model'> {
  return {
    runner:
      resolved.defaultRunner !== undefined && resolved.runner === resolved.defaultRunner
        ? undefined
        : resolved.runner,
    model: resolved.model || undefined,
  }
}

export function EnginePills({
  pick,
  onChange,
  disabled = false,
}: {
  pick: EnginePick
  onChange: (pick: EnginePick) => void
  disabled?: boolean
}) {
  const { runner, model, runners, canRun } = useResolvedEngine(pick)
  const config = useConfig()
  const catalog = useRunnerModels()
  const models = modelsForRunner(runner, catalog.data, [pick.model, config.data?.defaultModels?.[runner]])
  const unavailable = disabled || !canRun

  return (
    <>
      {runners.length > 1 ? (
        <RunnerPill
          runners={runners}
          value={runner}
          disabled={unavailable}
          // Switching backend drops the model pick: the presets are per-runner, so a kept
          // model would be a preset the new runner does not have (composer rule).
          onPick={(next) => onChange({ runner: next, model: null })}
        />
      ) : null}
      <PickerPill
        slot="model-pill"
        ariaLabel="Model"
        // `resolveModel` only ever returns a member of `models` ('' is the auto preset), so
        // the lookup cannot miss.
        label={models.find((m) => m.id === model)!.label}
        value={model}
        disabled={unavailable}
        onPick={(next) => onChange({ ...pick, model: next })}
        options={models.map((m) => ({ value: m.id, label: m.label, desc: m.desc }))}
        status={modelCatalogStatus(runner, catalog.data, catalog.isError)}
      />
    </>
  )
}
