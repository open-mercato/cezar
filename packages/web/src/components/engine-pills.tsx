import { hasAccountChoice, useAgentAccounts } from '@/api/agent-accounts'
import { useConfig, useProviderStatus, useRunnerModels } from '@/api/queries'
import type { CreateRunInput, Runner } from '@open-mercato/cezar-api-client'
import { PickerPill, RunnerPill, type RunnerAccountChoice } from '@/components/picker-pill'
import { usableRunners } from '@/lib/provider-status'
import {
  modelsForRunner,
  modelCatalogStatus,
  resolveModel,
  resolveRunner,
  runnerOverride,
} from '@/routes/new-task-form'

/**
 * The runner + model pill pair for the surfaces that START a run outside the /new composer
 * (#401): the Inbox card's "▶ Run" and the GitHub tab's "Run agent on this issue/PR".
 *
 * It exists so those two cannot drift from the composer: the resolution quartet
 * (`usableRunners` → `resolveRunner` → `modelsForRunner` → `resolveModel`) and the
 * "hide the runner pill on a single-backend host" rule live here once, read from the same
 * provider/config queries new-task.tsx reads. The composer itself keeps its own inline copy —
 * it threads the pills through a persisted draft and a variants pill this pair has no notion of.
 *
 * The caller owns the pick (`null` = never touched, so the configured default shows through);
 * this component only resolves and renders. `useResolvedEngine` hands back what the POST body
 * needs, so the pick and the thing sent to the server can never disagree.
 */

/** What the user actually touched. `null` on any field means "never touched". */
export interface EnginePick {
  runner: Runner | null
  model: string | null
  /**
   * Which login of that agent runs it (spec 2026-07-29-agent-profiles). Three states, and the
   * first two are NOT the same thing: `null` follows the project's selection (and keeps following
   * it if the setting changes before the task starts), `DEFAULT_AGENT_ACCOUNT_ID` names the
   * discovered account *explicitly* — which beats the project selection server-side — and any
   * other value is that account's id.
   */
  account: string | null
}

/** The effective backend, plus what the body rules need to decide what to send. */
export interface ResolvedEngine {
  runner: Runner
  /** A sticky/user pick must ride the request even when it currently equals the default. */
  runnerExplicit: boolean
  model: string
  /** The backends this host offers — the runner pill renders only when there is a choice. */
  runners: readonly Runner[]
  /** What the active project's server context would pick from its authoritative config. */
  defaultRunner?: Runner
  /** True only after provider status confirms at least one connected backend. */
  canRun: boolean
  /** Native agent settings are authoritative; model overrides must be omitted. */
  modelsLocked?: boolean
  providerPending: boolean
  providerError: boolean
  /** Every login for every runner. Empty on the zero-config host, which is why it renders as
   *  the same single-row-per-agent list it always did. */
  accounts: readonly RunnerAccountChoice[]
  /** The per-task account override, already filtered to the RESOLVED runner — see the hook. */
  account: string | null
  /** What the project's setting resolves to per runner, i.e. the row selected until overridden. */
  repoAccount?: Partial<Record<Runner, string>>
}

export function useResolvedEngine(pick: EnginePick): ResolvedEngine {
  const providers = useProviderStatus()
  const config = useConfig()
  const runners = usableRunners(providers.data)
  // `/api/health` is deliberately boot-project-only. Runner policy is per project, so every
  // scoped start surface must read the active project's `/api/config` instead (#699).
  const defaultRunner = config.data?.defaultRunner
  const runner = resolveRunner(pick.runner, runners, defaultRunner ?? runners[0] ?? 'claude')
  // Resolved first: each runner has its own host catalog (#794), so the fetch follows the pick.
  const catalog = useRunnerModels(runner)
  const modelsLocked = config.data?.modelsLocked === true
  // Agent accounts (spec 2026-07-29-agent-profiles), read through the shared hook the /new composer
  // and the thread's Continue read, so no start surface can disagree about which login runs.
  const { accounts, repoAccount } = useAgentAccounts()
  // An account belonging to ANOTHER runner is dropped rather than sent: switching runner must not
  // silently carry the previous runner's login along. Same guard as the composer's.
  const account = accounts.some((choice) => choice.provider === runner && choice.id === pick.account)
    ? pick.account
    : null
  return {
    runner,
    runnerExplicit: pick.runner !== null,
    model: resolveModel(modelsLocked ? null : pick.model, runner, config.data?.defaultModels, catalog.data),
    runners,
    defaultRunner,
    canRun: providers.isSuccess && runners.length > 0,
    modelsLocked,
    providerPending: providers.isPending,
    providerError: providers.isError,
    accounts,
    account,
    repoAccount,
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
 * against the active project's authoritative config default preserves omission when it is safe
 * and explicitly sends the provider-status fallback when it is not. A sticky/user pick always
 * rides the request, so a boot-project snapshot can never erase that intent.
 */
export function engineBody(resolved: ResolvedEngine): Pick<CreateRunInput, 'runner' | 'model'> {
  return {
    runner: runnerOverride(resolved.runner, resolved.defaultRunner, resolved.runnerExplicit),
    model: resolved.modelsLocked ? undefined : resolved.model || undefined,
  }
}

/**
 * `engineBody` plus the per-task agent account, for the start surfaces whose endpoint actually
 * takes one (`POST /api/v1/runs`).
 *
 * A sibling rather than a widened `engineBody` on purpose: `inbox.tsx` SPREADS the result into
 * `startTodo`, and TypeScript does not excess-property-check a spread — widening the shared return
 * would compile there and ship an `agentProfile` that `POST /todos/:id/start` silently drops.
 *
 * Conditional spread, per the HTTP-API rule in AGENTS.md: `agentProfile: undefined` types the key
 * as always-present while `JSON.stringify` drops it, which the contract-parity tests flag. An
 * untouched pick must put no such key on the wire at all — that is what "follow the project's
 * selection" means, and it is a different request from naming the default account explicitly.
 */
export function engineRunBody(
  resolved: ResolvedEngine,
): Pick<CreateRunInput, 'runner' | 'model' | 'agentProfile'> {
  return {
    ...engineBody(resolved),
    ...(resolved.account ? { agentProfile: resolved.account } : {}),
  }
}

export function EnginePills({
  pick,
  onChange,
  disabled = false,
  accounts = false,
}: {
  pick: EnginePick
  onChange: (pick: EnginePick) => void
  disabled?: boolean
  /**
   * Offer the agent ACCOUNT as rows of the runner pill. Opt-in per surface, because it must only
   * be shown where the endpoint can honour it: rendering a picker whose choice the server drops on
   * the floor is worse than not offering it. On today's surfaces that means the GitHub tab's
   * hand-off (`POST /api/v1/runs`) but not the Inbox card (`POST /todos/:id/start`, which has no
   * `agentProfile` field yet).
   */
  accounts?: boolean
}) {
  const resolved = useResolvedEngine(pick)
  const { runner, model, runners, canRun, modelsLocked } = resolved
  const config = useConfig()
  const catalog = useRunnerModels(runner)
  const models = modelsForRunner(runner, catalog.data, [pick.model, config.data?.defaultModels?.[runner]])
  const unavailable = disabled || !canRun
  const accountChoices = accounts ? resolved.accounts : []
  // Shown when there is a choice to make: more than one runner, or — where accounts are offered —
  // more than one login for one of them. A host with neither sees no pill, exactly as before.
  const showRunnerPill =
    runners.length > 1 || runners.some((id) => hasAccountChoice(accountChoices, id))

  return (
    <>
      {showRunnerPill ? (
        <RunnerPill
          runners={runners}
          value={runner}
          accounts={accountChoices}
          account={accounts ? resolved.account : null}
          repoAccount={accounts ? resolved.repoAccount : undefined}
          disabled={unavailable}
          // Changing the AGENT drops the model pick: the presets are per-runner, so a kept model
          // would be a preset the new runner does not have (composer rule). Changing only the
          // ACCOUNT keeps it — the catalog is identical across logins of the same runner.
          // Without accounts every row IS an agent, so that surface keeps its unconditional
          // reset rather than quietly gaining the re-pick-keeps-the-model behaviour.
          onPick={(next, picked) =>
            onChange(
              accounts
                ? { runner: next, account: picked, model: next === runner ? pick.model : null }
                : { runner: next, account: null, model: null },
            )
          }
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
        readOnly={modelsLocked === true}
        disabledHint={modelsLocked ? 'Model selection is locked to native coding-agent settings.' : undefined}
        onPick={(next) => onChange({ ...pick, model: next })}
        options={models.map((m) => ({ value: m.id, label: m.label, desc: m.desc }))}
        status={modelCatalogStatus(runner, catalog.data, catalog.isError)}
      />
    </>
  )
}
