import { useAgentProfiles, useConfig, useRunnerModels } from '@/api/queries'
import { DEFAULT_AGENT_ACCOUNT_ID, type ApiRun } from '@open-mercato/cezar-api-client'
import { chipClass } from '@/components/chip'
import { modelsForRunner } from '@/routes/new-task-form'
import { cn } from '@/lib/utils'

/**
 * Which agent, account and model a run is ON — the one resolution the header's agent badge and
 * the composer's read-only engine chip both read, so the two can never name different engines.
 */
export function useRunEngine(run: ApiRun) {
  // The record keeps only what the caller ASKED for: `POST /api/runs` persists the raw optional
  // `runner` (`src/runs/store.ts`), while the run actually executes as
  // `input.runner ?? config.defaultRunner` (`src/workflows/run.ts`). Mirror that resolution —
  // hardcoding 'claude' would name the wrong agent on a repo whose `defaultRunner` is
  // codex/opencode. 'claude' stays the last resort only while the active project's config is in
  // flight. (`/api/health` describes the boot project and can name the wrong runner on scoped
  // routes.)
  const config = useConfig()
  const profiles = useAgentProfiles()
  const runner = run.runner ?? config.data?.defaultRunner ?? 'claude'
  const model = run.model ?? 'auto'
  // The account is read from the STEP that actually spawned, never from the run's composer
  // override or the project's current selection (spec 2026-07-29-agent-profiles): the override is
  // absent whenever the run just followed the project, and the project's selection can have been
  // changed since — both would name an account this run may never have touched. The last step that
  // recorded one is what ran; `sessionId` and `profileId` are a pair for exactly this reason.
  const accountId = [...run.steps].reverse().find((step) => step.profileId)?.profileId
  const account = accountId === undefined
    ? undefined
    : accountId === DEFAULT_AGENT_ACCOUNT_ID
      ? 'default'
      // A deleted account still names the folder this run's sessions live in, so the id is shown
      // rather than swallowed — "gone" is the useful half of that answer.
      : profiles.data?.profiles.find((p) => p.id === accountId)?.label ?? `${accountId} (removed)`
  // The canonical `provider/model` the run actually resolved to (#405), shown only when it says
  // something `model` does not (#546). Absent on pre-#405 records and skipped when it merely
  // repeats `model` — an identity nothing wrote down is not one a reader may invent.
  const identity = run.modelIdentity && run.modelIdentity !== model ? run.modelIdentity : undefined
  const summary = [runner, account, model].filter(Boolean).join(' · ')
  return { runner, account, model, identity, summary }
}

/**
 * The composer's `agent · model` chip while there is nothing to pick: a live session cannot change
 * engine mid-turn, and a closed run with no session has nothing to reopen. The same shape as the
 * editable chip (`follow-up-engine.tsx`) in its read-only form, so the chat box always says which
 * agent and model it is talking to — and the editable one simply takes its place once a Continue
 * can choose.
 */
export function RunEnginePills({ run }: { run: ApiRun }) {
  const engine = useRunEngine(run)
  // The catalog only turns the pinned id into its display name ("opus" → "Opus 5.5"), so the chip
  // reads exactly as the editable one will once the session closes.
  const catalog = useRunnerModels(engine.runner)
  const models = modelsForRunner(engine.runner, catalog.data, [run.model])
  const modelLabel = models.find((preset) => preset.id === engine.model)?.label ?? engine.model
  const hint = 'The session’s engine — pick another when you continue it'
  return (
    <span
      data-slot="run-engine"
      title={engine.identity ? `${hint} (served as ${engine.identity})` : hint}
      className={cn(chipClass, 'cursor-default hover:bg-card hover:text-muted-foreground')}
    >
      <span data-slot="run-engine-runner" aria-label="Agent">
        {engine.account && engine.account !== 'default' ? `${engine.runner} · ${engine.account}` : engine.runner}
      </span>
      <span aria-hidden="true" className="text-soft-foreground">·</span>
      <span data-slot="run-engine-model" aria-label="Model">{modelLabel}</span>
    </span>
  )
}
