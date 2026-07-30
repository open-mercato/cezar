import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'

import { continueRun } from '@/api/client'
import { queryKeys, useConfig, useRunnerModels } from '@/api/queries'
import type { ApiRun, ContinueResponse, ImageInput, Runner } from '@open-mercato/cezar-api-client'
import { PickerPill, RunnerPill } from '@/components/picker-pill'
import {
  modelsForRunner,
  modelCatalogStatus,
  resolveModel,
} from '@/routes/new-task-form'
import { useContinuationProvider } from './continuation-provider'
import { runActionFlags } from './run-actions'

/** What the thread needs to offer Continue from its composer. */
export interface ContinueAction {
  /** Is there a session to reopen at all? (`runActionFlags.continueRun` — the same gate the
   *  header's Continue button uses.) Everything else is inert when this is false. */
  available: boolean
  /** Whether provider discovery currently permits reopening the session. */
  canContinue: boolean
  /** Fixed recovery copy when no provider can continue the run. */
  reason?: string
  /** True while provider status is still loading. */
  providerPending: boolean
  /** The runner + model pills — which backend and model the reopened session runs on. */
  pills: ReactNode
  /**
   * Reopen the session, starting it on this prompt. An empty draft is the legacy one-click
   * Continue: the engine opens with its own "Continue.". REJECTS with the server's message
   * rather than toasting itself, so the composer can restore the draft it optimistically
   * cleared — nothing the user typed is lost to a 409.
   */
  continueWith: (text: string, images: ImageInput[]) => Promise<ContinueResponse>
}

/**
 * The follow-up composer's Continue (#401): the same runner + model pills the /new composer
 * offers, so a follow-up can pick which backend and model reopen the session. The pills DEFAULT
 * to the run's current backend/model — untouched, the POST omits both and the server keeps the
 * run's engine (backward compat).
 *
 * A hook rather than a self-contained button, because the composer owns the draft: the prompt
 * the user typed and the engine they picked have to reach `POST /continue` in ONE request, and
 * the pills' state lives here.
 */
export function useContinueAction(run: ApiRun): ContinueAction {
  const queryClient = useQueryClient()
  const available = runActionFlags(run).continueRun
  const config = useConfig()
  // Only a run that can actually be continued needs the model catalog — every other thread
  // (running, queued, or closed with no session) would be fetching it to render nothing.
  const catalog = useRunnerModels(available)
  // null = "not touched": the pills fall back to the run's current backend/model, so an
  // untouched Continue behaves exactly as before this feature existed.
  const [pickedRunner, setPickedRunner] = useState<Runner | null>(null)
  const [pickedModel, setPickedModel] = useState<string | null>(null)

  const continuation = useContinuationProvider(run, pickedRunner)
  const { runners, canContinue, currentRunner, runner } = continuation
  const modelsLocked = config.data?.modelsLocked === true
  // While the runner is unchanged, the model pill starts on the run's own pin; switching the
  // runner invalidates that pin and falls back to the new backend's configured default / auto.
  const runnerChanged = runner !== currentRunner
  const modelDefaults =
    !modelsLocked && !runnerChanged && run.model
      ? { ...config.data?.defaultModels, [runner]: run.model }
      : config.data?.defaultModels
  const effectivePickedModel = modelsLocked ? null : pickedModel
  const models = modelsForRunner(runner, catalog.data, [effectivePickedModel, modelDefaults?.[runner]])
  const model = resolveModel(effectivePickedModel, runner, modelDefaults, catalog.data)

  const mutation = useMutation({
    mutationFn: ({ text, images }: { text: string; images: ImageInput[] }) => {
      if (!canContinue) {
        return Promise.reject(new Error(continuation.reason ?? 'Connect an agent provider to continue.'))
      }
      return continueRun(run.id, {
        // An empty draft posts no `text` at all, so the server's default opening prompt
        // ("Continue.") still applies — one-click Continue, unchanged.
        text: text.trim() ? text : undefined,
        images: images.length ? images : undefined,
        // Send an override only for a pill the user actually touched; otherwise omit it so the
        // server keeps the run's current backend/model. If that backend disconnected, the
        // connected fallback must be explicit even when the pills were untouched.
        runner: continuation.runnerOverride,
        model: !modelsLocked && pickedModel !== null ? model : undefined,
      })
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
  })

  return {
    available,
    canContinue,
    reason: continuation.reason,
    providerPending: continuation.providerPending,
    pills: (
      <div data-slot="follow-up-engine" className="flex flex-wrap items-center gap-1.5">
        {runners.length > 1 ? (
          <RunnerPill
            runners={runners}
            value={runner}
            onPick={(next) => {
              setPickedRunner(next)
              setPickedModel(null) // a runner switch invalidates the previous model pick
            }}
          />
        ) : null}
        <PickerPill
          slot="follow-up-model-pill"
          ariaLabel="Model"
          label={models.find((m) => m.id === model)?.label ?? 'auto'}
          value={model}
          readOnly={modelsLocked}
          disabledHint="Model selection is locked to native coding-agent settings."
          onPick={(next) => setPickedModel(next)}
          options={models.map((m) => ({ value: m.id, label: m.label, desc: m.desc }))}
          status={modelCatalogStatus(runner, catalog.data, catalog.isError)}
        />
      </div>
    ),
    continueWith: (text, images) => mutation.mutateAsync({ text, images }),
  }
}
