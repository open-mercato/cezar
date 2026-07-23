import { useMutation, useQueryClient } from '@tanstack/react-query'
import { PlayIcon } from 'lucide-react'
import { useState } from 'react'

import { continueRun } from '@/api/client'
import { queryKeys, useConfig, useProviderStatus, useRunnerModels } from '@/api/queries'
import type { ApiRun, Runner } from '@/api/types'
import { PickerPill, RunnerPill } from '@/components/picker-pill'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { connectedRunners } from '@/lib/provider-status'
import { Link } from '@/lib/project-router'
import {
  modelsForRunner,
  modelCatalogStatus,
  resolveModel,
  resolveRunner,
} from '@/routes/new-task-form'
import { runActionFlags } from './run-actions'

/**
 * The follow-up composer's "Continue" control (#401): the same runner + model pills the /new
 * composer offers, so a follow-up can pick which backend and model reopen the session. The
 * pills DEFAULT to the run's current backend/model — untouched, the POST omits both and the
 * server keeps the run's engine (backward compat). Rendered as the closed composer's
 * `disabledAction`, and hidden (like the header's Continue) when the run has no session to
 * resume — `runActionFlags.continueRun`.
 */
export function ContinueAction({ run }: { run: ApiRun }) {
  const queryClient = useQueryClient()
  const providers = useProviderStatus()
  const config = useConfig()
  const catalog = useRunnerModels()
  // null = "not touched": the pills fall back to the run's current backend/model, so an
  // untouched Continue behaves exactly as before this feature existed.
  const [pickedRunner, setPickedRunner] = useState<Runner | null>(null)
  const [pickedModel, setPickedModel] = useState<string | null>(null)

  const runners = connectedRunners(providers.data)
  const canContinue = providers.isSuccess && runners.length > 0
  // Mirrors the server's continue-path resolution (`record?.runner ?? 'claude'`): a run
  // without a persisted runner predates the choice and continues on claude — NOT on the
  // host's defaultRunner, which only applies to brand-new tasks.
  const currentRunner = (run.runner ?? 'claude') as Runner
  const runner = resolveRunner(pickedRunner, runners, currentRunner)
  const currentRunnerConnected = runners.includes(currentRunner)
  // While the runner is unchanged, the model pill starts on the run's own pin; switching the
  // runner invalidates that pin and falls back to the new backend's configured default / auto.
  const runnerChanged = runner !== currentRunner
  const modelDefaults =
    !runnerChanged && run.model
      ? { ...config.data?.defaultModels, [runner]: run.model }
      : config.data?.defaultModels
  const models = modelsForRunner(runner, catalog.data, [pickedModel, modelDefaults?.[runner]])
  const model = resolveModel(pickedModel, runner, modelDefaults, catalog.data)

  const mutation = useMutation({
    mutationFn: async () => {
      if (!canContinue) return null
      return continueRun(run.id, {
        // Send an override only for a pill the user actually touched; otherwise omit it so the
        // server keeps the run's current backend/model. If that backend disconnected, the
        // connected fallback must be explicit even when the pills were untouched.
        runner: pickedRunner !== null || !currentRunnerConnected ? runner : undefined,
        model: pickedModel !== null ? model : undefined,
      })
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  if (!runActionFlags(run).continueRun) return null

  if (!canContinue) {
    return (
      <div
        data-slot="follow-up-provider-gate"
        className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
      >
        <span>
          {providers.isPending
            ? 'Checking agent providers…'
            : providers.isError
              ? 'Provider authentication could not be verified.'
              : 'Connect an agent provider to continue.'}
        </span>
        {!providers.isPending ? (
          <Link
            to="/settings/agents#providers"
            className="font-medium text-foreground underline underline-offset-4"
          >
            Configure providers
          </Link>
        ) : null}
      </div>
    )
  }

  return (
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
        onPick={(next) => setPickedModel(next)}
        options={models.map((m) => ({ value: m.id, label: m.label, desc: m.desc }))}
        status={modelCatalogStatus(runner, catalog.data, catalog.isError)}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        <PlayIcon aria-hidden="true" className="size-3.5" />
        Continue
      </Button>
    </div>
  )
}
