import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Fragment, useState } from 'react'

import { putConfig } from '@/api/client'
import {
  queryKeys,
  useAgentProfiles,
  useConfig,
  useProjects,
  useProviderStatus,
  useRepo,
  useRunnerModelCatalogs,
  useSelectAgentProfile,
} from '@/api/queries'
import { useProjectScope } from '@/api/project-scope-context'
import type { ConfigResponse, Runner, SetConfigInput } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { providerStatusFor } from '@/lib/provider-status'
import {
  DefaultAgentPicker,
  agentPickerRows,
  hasAgentAccounts,
} from '@/components/default-agent-picker'
import { modelCatalogStatus, modelsForRunner, RUNNERS } from '@/routes/new-task-form'
import { ProviderSettings } from './provider-settings'
import {
  SettingsError,
  SettingsField,
  SettingsGroup,
  SettingsLoading,
  SettingsNote,
  SettingsPane,
  SettingsSelect,
} from './settings-field'

/**
 * Settings → Agents (R6 Step 1.5, spec §"Settings"): today's scattered `PUT /api/config` knobs
 * in one place — default runner, per-runner model presets, THE system prompt (this is its
 * single edit surface: the /new composer intentionally has none, user decision in R4), and the
 * base branch (also settable from the Git view's branch picker; both write the same key).
 *
 * Copy stays coding-agent-agnostic by rule: the section describes capabilities (`runner`,
 * `model`, `system prompt`), never vendor config formats.
 *
 * Persistence: every control PUTs a partial patch; the server merges it into the raw
 * config.json so user keys survive. The PUT answers the full knob shape, which lands straight
 * in the `config` query — the readback is the server's own truth, not an optimistic guess.
 */

/** The server's validation cap for the system prompt (src/config.ts) — enforced here too so an
 *  over-limit draft is a disabled Save with a reason, not a 400 round-trip. */
const SYSTEM_PROMPT_MAX = 20_000

export function AgentsSection() {
  const config = useConfig()
  // One row per runner here, so every runner's own host catalog is needed at once (#794) —
  // unlike the composer, which only ever renders the runner the user picked.
  const catalogs = useRunnerModelCatalogs()
  const providerStatus = useProviderStatus()

  if (config.isPending) {
    return <SettingsLoading data-slot="agents-loading" label="Loading agent settings…" />
  }
  if (config.isError) {
    return <SettingsError title="Agent settings did not load">{config.error.message}</SettingsError>
  }
  return <AgentsForm config={config.data} catalogs={catalogs} providerStatus={providerStatus} />
}

function AgentsForm({
  config,
  catalogs,
  providerStatus,
}: {
  config: ConfigResponse
  catalogs: ReturnType<typeof useRunnerModelCatalogs>
  providerStatus: ReturnType<typeof useProviderStatus>
}) {
  const repo = useRepo()
  const queryClient = useQueryClient()

  const save = useMutation({
    mutationFn: (patch: SetConfigInput) => putConfig(patch),
    onSuccess: (result) => {
      // The PUT already answers the merged knobs — no refetch needed for this section. The
      // same knobs surface elsewhere though: defaultRunner in /api/health, baseBranch in
      // /api/repo — refresh both so the composer and the Git view agree immediately.
      queryClient.setQueryData(queryKeys.config, result)
      void queryClient.invalidateQueries({ queryKey: queryKeys.health })
      void queryClient.invalidateQueries({ queryKey: queryKeys.repo })
    },
    // 400/409/500 alike: the server's own words, verbatim (the repo-wide error doctrine).
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  // The system prompt edits locally and saves explicitly — a textarea that PUT-ed 20k
  // characters on every keystroke would be a worse control, not a simpler one.
  const [prompt, setPrompt] = useState(config.systemPrompt ?? '')
  const trimmedPrompt = prompt.trim()
  const promptSaved = trimmedPrompt === (config.systemPrompt ?? '')
  const promptOverLimit = trimmedPrompt.length > SYSTEM_PROMPT_MAX
  const savePrompt = () =>
    save.mutate(
      { systemPrompt: trimmedPrompt === '' ? null : trimmedPrompt },
      {
        onSuccess: () =>
          toast(trimmedPrompt === '' ? 'System prompt cleared' : 'System prompt saved'),
      },
    )

  return (
    <SettingsPane data-slot="agents-section">
      <ProviderSettings />

      <SettingsGroup title="Defaults" description="What a new task in this project starts with.">
        <DefaultAgentField
          defaultRunner={config.defaultRunner}
          providerStatus={providerStatus}
          saving={save.isPending}
          onPick={(runner) => save.mutate({ defaultRunner: runner })}
        />

        <SettingsField
          title="Default models"
          hint={
            config.modelsLocked
              ? 'Models are locked to the defaults configured in the native coding-agent settings.'
              : 'The model preselected in the composer for each runner. Auto lets the runner decide per task.'
          }
        >
          <div className="grid gap-x-6 gap-y-2.5 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center">
            {RUNNERS.map((runner) => {
              const provider = providerStatusFor(providerStatus.data, runner.id)
              const providerConnected =
                !providerStatus.isPending &&
                !providerStatus.isError &&
                provider?.enabled === true &&
                provider.status === 'connected'
              const providerReason = providerStatus.isPending
                ? 'Checking provider authentication…'
                : providerStatus.isError
                  ? 'Provider authentication could not be verified.'
                  : provider?.enabled === false
                    ? 'This provider is disabled. Enable it above or choose another provider.'
                  : providerConnected
                    ? undefined
                    : 'Connect this provider before selecting it.'
              const catalog = catalogs[runner.id]
              const catalogStatus = modelCatalogStatus(runner.id, catalog.data, catalog.isError)
              const modelOptions = modelsForRunner(runner.id, catalog.data, [
                config.defaultModels[runner.id],
              ])
              const configuredModel = config.defaultModels[runner.id] ?? ''
              const configuredModelLabel =
                modelOptions.find((model) => model.id === configuredModel)?.label ??
                configuredModel ??
                'auto (default)'
              return (
                <Fragment key={runner.id}>
                  <span className="text-[13px] text-muted-foreground">{runner.label}</span>
                  {config.modelsLocked ? (
                    <output
                      aria-label={`Default model for ${runner.label}`}
                      data-slot="agents-model"
                      data-runner={runner.id}
                      title="Model selection is locked to native coding-agent settings."
                      className="flex h-9 w-full items-center rounded-md border border-input bg-muted/40 px-3 text-sm text-muted-foreground sm:max-w-sm"
                    >
                      {configuredModelLabel}
                    </output>
                  ) : (
                    <SettingsSelect
                      aria-label={`Default model for ${runner.label}`}
                      data-slot="agents-model"
                      data-runner={runner.id}
                      value={configuredModel}
                      title={providerReason ?? runner.desc}
                      disabled={save.isPending || !providerConnected}
                      onChange={(value) =>
                        // Picking auto is a CHOICE, not the absence of one (#906): clearing the
                        // preset alone let the coding agent's own settings file show through again,
                        // so the select snapped straight back to the model it names. The additive
                        // override says "ignore that default"; picking a real model clears it.
                        save.mutate({
                          defaultModels: { [runner.id]: value || null } as Partial<
                            Record<Runner, string | null>
                          >,
                          defaultModelsAuto: { [runner.id]: value === '' } as Partial<
                            Record<Runner, boolean>
                          >,
                        })
                      }
                      options={modelOptions.map((model) => ({
                        value: model.id,
                        label: model.id === '' ? 'auto (default)' : model.label,
                      }))}
                      footer={catalogStatus || undefined}
                      className="sm:w-full sm:max-w-sm"
                    />
                  )}
                </Fragment>
              )
            })}
          </div>
        </SettingsField>

        <SettingsField
          title="Base branch"
          hint="New task worktrees branch from this and draft PRs target it. Also settable from the Git view."
          control={
            repo.data?.info ? (
              <SettingsSelect
                aria-label="Base branch"
                data-slot="agents-base-branch"
                value={config.baseBranch ?? ''}
                disabled={save.isPending}
                onChange={(value) => save.mutate({ baseBranch: value || null })}
                options={[
                  { value: '', label: 'follow checked-out branch (default)' },
                  ...repo.data.branches.map((name) => ({ value: name, label: name })),
                ]}
                className="sm:w-72"
              />
            ) : undefined
          }
        >
          {repo.data?.info ? null : (
            <SettingsNote data-slot="agents-base-branch-unavailable">
              {repo.isPending ? 'Loading branches…' : 'Not a git repository — tasks run in place, no branching.'}
            </SettingsNote>
          )}
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Behaviour">
        <SettingsField
          title="System prompt"
          hint="Extra instructions appended to every run, whichever runner executes it. This is the only place it is edited."
        >
          <Textarea
            aria-label="System prompt"
            data-slot="agents-system-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Extra rules for every agent run — conventions, tone, review requirements…"
            className="min-h-32"
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-action="agents-save-prompt"
              disabled={promptSaved || promptOverLimit || save.isPending}
              onClick={savePrompt}
            >
              Save
            </Button>
            {promptOverLimit ? (
              <SettingsNote tone="danger" data-slot="agents-prompt-limit">
                {trimmedPrompt.length.toLocaleString()} characters — the limit is{' '}
                {SYSTEM_PROMPT_MAX.toLocaleString()}.
              </SettingsNote>
            ) : (
              <SettingsNote>Leave empty and save to clear. Applied to new runs only.</SettingsNote>
            )}
          </div>
        </SettingsField>

        <SettingsField
          title="Live title updates"
          hint="Refresh a task's short title through the namer model as the run progresses. A manual rename always wins and stops updates for that task."
          control={
            <>
              <span className="text-xs text-muted-foreground">
                {(config.liveTitleUpdates ?? true) ? 'On' : 'Off'}
                {config.liveTitleUpdates === null && ' (default)'}
              </span>
              <Switch
                aria-label="Live title updates"
                data-slot="agents-live-title-updates"
                checked={config.liveTitleUpdates ?? true}
                disabled={save.isPending}
                onCheckedChange={(checked) =>
                  save.mutate(
                    { liveTitleUpdates: checked },
                    { onSuccess: () => toast(checked ? 'Live title updates on' : 'Live title updates off') },
                  )
                }
              />
            </>
          }
        />

        <SettingsField
          title="Review changes before finishing"
          hint="When on, a task with changes pauses so you can Accept, Send back, or open a Draft PR. Autonomous tasks always skip this and finish on their own. Default: off — tasks finish without asking."
          control={
            <>
              <span className="text-xs text-muted-foreground">
                {(config.reviewGate ?? false) ? 'On' : 'Off'}
                {config.reviewGate === null && ' (default)'}
              </span>
              <Switch
                aria-label="Review changes before finishing"
                data-slot="agents-review-gate"
                checked={config.reviewGate ?? false}
                disabled={save.isPending}
                onCheckedChange={(checked) =>
                  save.mutate(
                    { reviewGate: checked },
                    { onSuccess: () => toast(checked ? 'Review gate on' : 'Review gate off') },
                  )
                }
              />
            </>
          }
        />
      </SettingsGroup>
    </SettingsPane>
  )
}

/**
 * The repo's default AGENT — and, when that agent has more than one login, which account (spec
 * 2026-07-29-agent-profiles).
 *
 * One flat list, the same shape the composer's runner pill uses:
 *
 *     claude · Default
 *     claude · Klaudiusz
 *     codex
 *
 * Not a runner control with an account control beside it. Both answers are the same decision —
 * "what does this repo run by default" — and splitting them meant reading two fields to learn one
 * fact. An agent with a single login stays a single row, so a machine with no extra accounts sees
 * exactly the control it always saw.
 *
 * The two halves land in DIFFERENT stores, and that is deliberate rather than incidental: the runner
 * is a team decision and goes in the repo's committable config, while the account is personal and
 * per-machine (`~/.cezar/agent-accounts.json`) — committing it would publish which login someone
 * works under. Hence two writes for one click, and the copy says so.
 */
function DefaultAgentField({
  defaultRunner,
  providerStatus,
  saving,
  onPick,
}: {
  defaultRunner: Runner
  providerStatus: ReturnType<typeof useProviderStatus>
  saving: boolean
  onPick: (runner: Runner) => void
}) {
  const profiles = useAgentProfiles()
  const projects = useProjects()
  const scope = useProjectScope()
  const repo = useRepo()
  const select = useSelectAgentProfile()

  // `projectId: null` is the boot project, which every route addresses by the reserved `default`
  // alias. The repo ROOT is the key the account store uses, and `useRepo` is project-scoped so it
  // already answers for the ACTIVE project.
  const projectId = scope.projectId ?? 'default'
  const repoRoot = repo.data?.info?.root
  // Repo first, then the machine-wide default — the same order the server resolves in, so the
  // checked row is the account a task would really run under rather than a guess.
  const selection = repoRoot ? profiles.data?.selections[repoRoot] : undefined
  const machine = profiles.data?.defaults
  const rows = agentPickerRows(profiles.data?.profiles ?? [])
  const hasAccounts = hasAgentAccounts(rows)

  return (
    <SettingsField
      title={hasAccounts ? 'Default agent' : 'Default runner'}
      hint={
        hasAccounts
          ? 'Preselected for new tasks in THIS repo, and used by the chain planner. Each task can still pick another agent or account. The account is stored on this machine only — it is never committed, so a teammate keeps their own.'
          : 'Preselected for new tasks in THIS repo, and used by the chain planner. Each task can still pick another runner.'
      }
    >
      {/* The picker is one unbroken row; on a phone it scrolls instead of pushing the page wide. */}
      <div className="-mx-1 overflow-x-auto px-1 py-0.5 [scrollbar-width:none]">
        <DefaultAgentPicker
          rows={rows}
          runner={defaultRunner}
          accountFor={(id) => selection?.[id] ?? machine?.[id] ?? null}
          providerStatus={providerStatus}
          disabled={saving}
          // The account half needs a project to write against; the runner half does not, so only an
          // account row waits on the registry.
          accountDisabled={select.isPending || projects.data === undefined}
          onPick={(runner, account, hasAccountChoice) => {
            if (runner !== defaultRunner) onPick(runner)
            // Only when this agent HAS a choice of accounts: a single-login agent must not write a
            // selection, or the store would fill up with rows that say nothing.
            if (hasAccountChoice) {
              select.mutate(
                { projectId, provider: runner, profileId: account },
                { onError: (error: Error) => toast(error.message, { tone: 'danger' }) },
              )
            }
          }}
        />
      </div>
      {!providerStatus.isPending &&
      !providerStatus.isError &&
      providerStatusFor(providerStatus.data, defaultRunner)?.enabled === false ? (
        <p className="text-xs text-muted-foreground">
          This provider is disabled. Enable it above or choose another provider.
        </p>
      ) : null}
      {hasAccounts ? (
        <p className="text-xs text-pretty text-muted-foreground">
          Tasks already started under another account can’t be resumed here — their sessions live in
          that account’s folder.
        </p>
      ) : null}
    </SettingsField>
  )
}
