import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'

import { hasAccountChoice } from '@/api/agent-accounts'
import { continueRun } from '@/api/client'
import { queryKeys, useConfig, useModelPickerActions, useRunnerModels } from '@/api/queries'
import { DEFAULT_AGENT_ACCOUNT_ID, runnerSupportsReasoningEffort } from '@open-mercato/cezar-api-client'
import type { ApiRun, ContinueResponse, AttachmentEntry, Runner } from '@open-mercato/cezar-api-client'
import { PickerPill, RunnerPill, engineLeftClass, engineRightClass, modelPillClass } from '@/components/picker-pill'
import { ReasoningEffortPill, reasoningEffortOffered } from '@/components/reasoning-effort-pill'
import {
  modelsForRunner,
  modelCatalogStatus,
  reasoningEffortsForModel,
  resolveReasoningEffort,
  resolveModel,
} from '@/routes/new-task-form'
import { useContinuationProvider } from './continuation-provider'
import { runActionFlags } from './run-actions'

/** What the thread needs to offer Continue from its composer. */
export interface ContinueAction {
  /** Is there a session to reopen at all? (`runActionFlags.continueRun` — the one gate every
   *  Continue entry point shares.) Everything else is inert when this is false. */
  available: boolean
  /** Whether provider discovery currently permits reopening the session. */
  canContinue: boolean
  canChooseEngine: boolean
  /** Fixed recovery copy when no provider can continue the run. */
  reason?: string
  /** True while provider status is still loading. */
  providerPending: boolean
  /** The runner + model + effort pills in one row — the header's agent badge. */
  pills: ReactNode
  /** The same runner + model pickers as ONE `agent · model` chip — the composer's control row. */
  engine: ReactNode
  /** The effort picker alone, value-only — the composer's Options row (absent when
   *  `effortOffered` is false: effort belongs only to a concrete model of a capable runner). */
  effort: ReactNode
  effortOffered: boolean
  /**
   * Reopen the session, starting it on this prompt. An empty draft is the legacy one-click
   * Continue: the engine opens with its own "Continue.". REJECTS with the server's message
   * rather than toasting itself, so the composer can restore the draft it optimistically
   * cleared — nothing the user typed is lost to a 409. A retry passes the first attempt's
   * `idempotencyKey`, so a Continue that already landed is not continued twice.
   */
  continueWith: (text: string, images: AttachmentEntry[], idempotencyKey?: string) => Promise<ContinueResponse>
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
  // null = "not touched": the pills fall back to the run's current backend/model/account, so an
  // untouched Continue behaves exactly as before this feature existed.
  const [pickedRunner, setPickedRunner] = useState<Runner | null>(null)
  const [pickedModel, setPickedModel] = useState<string | null>(null)
  // `null` preserves the existing session's effort; `''` deliberately resets
  // the resumed Codex turn to its native default.
  const [pickedReasoningEffort, setPickedReasoningEffort] = useState<string | null>(null)
  const [pickedAccount, setPickedAccount] = useState<string | null>(null)

  const continuation = useContinuationProvider(run, pickedRunner, pickedAccount)
  const { runners, currentRunner, runner, entry } = continuation
  // The catalog belongs to the runner this continuation would use (#794), so switching the
  // runner pill re-reads that backend's own models. Only a run that can actually be continued
  // fetches at all — every other thread (running, queued, closed with no session) would be
  // fetching it to render nothing.
  const catalog = useRunnerModels(runner, available && (runner !== 'kimi' || !continuation.providerPending), continuation.catalogAccount)
  const modelActions = useModelPickerActions(runner, continuation.catalogAccount)
  const modelsLocked = config.data?.modelsLocked === true
  // While the runner is unchanged, the model pill starts on the run's own pin; switching the
  // runner invalidates that pin and falls back to the new backend's configured default / auto.
  const runnerChanged = runner !== currentRunner
  const modelDefaults =
    !modelsLocked && !runnerChanged && run.model
      ? { ...config.data?.defaultModels, [runner]: run.model }
      : config.data?.defaultModels
  const effectivePickedModel = modelsLocked ? null : pickedModel
  const models = modelsForRunner(runner, catalog.data, [effectivePickedModel, modelDefaults?.[runner]], entry)
  // An untouched replay keeps the recorded model. A changed login must offer the model it inherits.
  const accountChanged = pickedAccount !== null && pickedAccount !== continuation.recordedAccount
  const replayModel = !modelsLocked && !runnerChanged && !accountChanged && pickedModel === null ? run.model : undefined
  const model = replayModel ?? resolveModel(effectivePickedModel, runner, modelDefaults, catalog.data, entry)
  const requestedModel = pickedModel ?? (!runnerChanged && accountChanged ? run.model : undefined)
  const validateModel = !modelsLocked && !!entry?.configured && !!requestedModel
  const missingModel = validateModel && requestedModel !== model
  const canContinue = continuation.canContinue && !missingModel && !(validateModel && catalog.isPending)
  const reason = continuation.reason ?? (missingModel ? 'Choose a model available to the selected provider.' : undefined)
  const carriedReasoningEffort = !runnerChanged
    ? [...run.steps].reverse().find((step) => step.sessionId)?.reasoningEffort ?? run.reasoningEffort
    : undefined
  const reasoningEfforts = reasoningEffortsForModel(runner, model, catalog.data)
  const reasoningEffort = resolveReasoningEffort(
    pickedReasoningEffort ?? carriedReasoningEffort ?? null,
    runner,
    model,
    catalog.data,
  )

  // Agent accounts (spec 2026-07-29-agent-profiles): rows of the RUNNER pill, exactly as the /new
  // composer offers them — `claude · Default` / `claude · Klaudiusz` / `codex`. Without them a
  // thread could switch agent but not login, so "continue this on my other Claude account" was
  // unsayable anywhere except at task creation.
  const { accounts, repoAccount, accountId } = continuation
  const accountDefaults = { ...repoAccount, [runner]: accountId }
  // An explicit account belongs to the runner picked with it. Let the server reject a
  // subsequently removed account instead of omitting the pick and using a different login.
  const account = pickedRunner === runner ? pickedAccount : null

  const mutation = useMutation({
    mutationFn: ({ text, images, idempotencyKey }: { text: string; images: AttachmentEntry[]; idempotencyKey?: string }) => {
      if (!canContinue) {
        return Promise.reject(new Error(reason ?? 'Connect an agent provider to continue.'))
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
        reasoningEffort:
          !modelsLocked && runnerSupportsReasoningEffort(runner) && pickedReasoningEffort !== null
            ? reasoningEffort
            : undefined,
        // Only a login the user actually picked rides the request. Omitted, the run keeps the
        // account it is on — and the reopened session still resumes, which an explicit switch
        // deliberately does not (a session id lives inside ONE account's config dir).
        agentProfile: account ?? undefined,
        idempotencyKey,
      })
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
  })

  // Shown when there is a choice to make: more than one runner, or more than one login for one of
  // them. A host with neither sees no runner pill, exactly as before.
  const runnerChoice = continuation.removedAccount || runners.length > 1 || runners.some((id) => hasAccountChoice(accounts, id))
  const modelLabel = missingModel ? 'Choose a model' : models.find((m) => m.id === model)?.label ?? (model || 'auto')
  const runnerPill = runnerChoice ? (
    <RunnerPill
      runners={runners}
      value={runner}
      accounts={accounts}
      account={account}
      repoAccount={accountDefaults}
      className={engineLeftClass}
      onPick={(next, picked) => {
        setPickedAccount(picked ?? (next === runner && continuation.removedAccount ? DEFAULT_AGENT_ACCOUNT_ID : null))
        setPickedRunner(next)
        // Changing the backend also invalidates its model and effort.
        if (next !== runner) {
          setPickedModel(null)
          setPickedReasoningEffort(null)
        }
      }}
    />
  ) : null
  const modelPill = (
    <PickerPill
      slot="follow-up-model-pill"
      ariaLabel="Model"
      // One `agent · model` chip: without a runner pill the agent's name rides the model's label.
      label={runnerChoice ? modelLabel : `${runner} · ${modelLabel}`}
      value={model}
      readOnly={modelsLocked}
      className={runnerChoice ? engineRightClass : modelPillClass}
      // The full id, for the hover: the pill truncates a long one (#composer-row-wrap).
      hint={modelLabel}
      disabledHint="Model selection is locked to native coding-agent settings."
      onPick={(next) => {
        setPickedModel(next)
        // A model change invalidates the carried effort. Keep an explicit native-default
        // pick so the label and the request agree instead of displaying an old level while
        // the server silently clears it (#815 review).
        setPickedReasoningEffort('')
      }}
      options={models.map((m) => ({ value: m.id, label: m.label, desc: m.desc }))}
      status={modelCatalogStatus(runner, catalog.data, catalog.isError)}
      {...modelActions}
    />
  )
  const effortPill = (
    <ReasoningEffortPill
      runner={runner}
      model={model}
      value={reasoningEffort}
      options={reasoningEfforts}
      modelsLocked={modelsLocked}
      onPick={setPickedReasoningEffort}
    />
  )

  return {
    available,
    canContinue,
    canChooseEngine: runnerChoice || missingModel,
    reason,
    providerPending: continuation.providerPending,
    pills: (
      <div data-slot="follow-up-engine" className="flex flex-wrap items-center gap-1.5">
        {runnerPill}
        {modelPill}
        {effortPill}
      </div>
    ),
    engine: (
      <span data-slot="follow-up-engine" className="inline-flex min-w-0 max-w-full items-center">
        {runnerPill}
        {modelPill}
      </span>
    ),
    effortOffered: reasoningEffortOffered(runner, model, reasoningEfforts),
    effort: (
      <ReasoningEffortPill
        runner={runner}
        model={model}
        value={reasoningEffort}
        options={reasoningEfforts}
        modelsLocked={modelsLocked}
        onPick={setPickedReasoningEffort}
        bare
      />
    ),
    continueWith: (text, images, idempotencyKey) => mutation.mutateAsync({ text, images, idempotencyKey }),
  }
}
