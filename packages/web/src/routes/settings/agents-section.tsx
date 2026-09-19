import { useMutation, useQueryClient } from '@tanstack/react-query'
import { BotIcon } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

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
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { providerStatusFor } from '@/lib/provider-status'
import {
  DEFAULT_PERMISSION_PRESET,
  formatPermissionRulesText,
  parsePermissionRulesText,
  PERMISSION_MODES,
  type PermissionChoice,
  type PermissionMode,
} from '@/lib/permission-modes'
import {
  DefaultAgentPicker,
  agentPickerRows,
  hasAgentAccounts,
} from '@/components/default-agent-picker'
import { modelCatalogStatus, modelsForRunner, RUNNERS } from '@/routes/new-task-form'
import { ProviderSettings } from './provider-settings'

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
    return (
      <p data-slot="agents-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
        Loading agent settings…
      </p>
    )
  }
  if (config.isError) {
    return (
      <CenteredState
        icon={<BotIcon />}
        tone="danger"
        title="Agent settings did not load"
        subtitle={config.error.message}
        heading="h2"
      />
    )
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
    <div
      data-slot="agents-section"
      className="mx-auto flex w-full max-w-2xl flex-col gap-7 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
    >
      <ProviderSettings />

      <DefaultAgentField
        defaultRunner={config.defaultRunner}
        providerStatus={providerStatus}
        saving={save.isPending}
        onPick={(runner) => save.mutate({ defaultRunner: runner })}
      />

      <Field
        title="Default models"
        hint={
          config.modelsLocked
            ? 'Models are locked to the defaults configured in the native coding-agent settings.'
            : 'The model preselected in the composer for each runner. Auto lets the runner decide per task.'
        }
      >
        <div className="flex max-w-md flex-col gap-2">
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
              <label key={runner.id} className="flex items-center gap-3">
                <span className="w-24 shrink-0 font-mono text-xs text-muted-foreground">{runner.label}</span>
                {config.modelsLocked ? (
                  <output
                    aria-label={`Default model for ${runner.label}`}
                    data-slot="agents-model"
                    data-runner={runner.id}
                    title="Model selection is locked to native coding-agent settings."
                    className="block w-full rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs"
                  >
                    {configuredModelLabel}
                  </output>
                ) : (
                  <select
                    aria-label={`Default model for ${runner.label}`}
                    data-slot="agents-model"
                    data-runner={runner.id}
                    value={configuredModel}
                    title={providerReason ?? runner.desc}
                    disabled={save.isPending || !providerConnected}
                    onChange={(event) =>
                      save.mutate({
                        defaultModels: { [runner.id]: event.target.value || null } as Partial<
                          Record<Runner, string | null>
                        >,
                      })
                    }
                    className="block w-full rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
                  >
                    {modelOptions.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.id === '' ? 'auto (default)' : model.label}
                      </option>
                    ))}
                    {catalogStatus ? <option disabled>{catalogStatus}</option> : null}
                  </select>
                )}
              </label>
            )
          })}
        </div>
      </Field>

      <Field
        title="System prompt"
        hint="Extra instructions appended to every run, whichever runner executes it. This is the only place it is edited."
      >
        <Textarea
          aria-label="System prompt"
          data-slot="agents-system-prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Extra rules for every agent run — conventions, tone, review requirements…"
          className="min-h-32 max-w-xl"
        />
        <div className="flex max-w-xl items-center gap-3">
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
            <p data-slot="agents-prompt-limit" className="text-[11px] text-danger">
              {trimmedPrompt.length.toLocaleString()} characters — the limit is{' '}
              {SYSTEM_PROMPT_MAX.toLocaleString()}.
            </p>
          ) : (
            <p className="text-[11px] text-soft-foreground">
              Leave empty and save to clear. Applied to new runs only.
            </p>
          )}
        </div>
      </Field>

      <Field
        title="Live title updates"
        hint="Refresh a task's short title through the namer model as the run progresses. A manual rename always wins and stops updates for that task."
      >
        <label className="flex w-fit items-center gap-3">
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
          <span className="text-[13px] text-muted-foreground">
            {(config.liveTitleUpdates ?? true) ? 'On' : 'Off'}
            {config.liveTitleUpdates === null && ' (default)'}
          </span>
        </label>
      </Field>

      <Field
        title="Review changes before finishing"
        hint="When on, a task with changes pauses so you can Accept, Send back, or open a Draft PR. Autonomous tasks always skip this and finish on their own. Default: off — tasks finish without asking."
      >
        <label className="flex w-fit items-center gap-3">
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
          <span className="text-[13px] text-muted-foreground">
            {(config.reviewGate ?? false) ? 'On' : 'Off'}
            {config.reviewGate === null && ' (default)'}
          </span>
        </label>
      </Field>

      <PermissionsField
        config={config}
        saving={save.isPending}
        onSave={(permissions) =>
          save.mutate(
            { permissions },
            { onSuccess: () => toast(permissions === null ? 'Permissions reset to workspace default' : 'Permissions saved') },
          )
        }
      />

      <Field
        title="Base branch"
        hint="New task worktrees branch from this and draft PRs target it. Also settable from the Git view."
      >
        {repo.data?.info ? (
          <select
            aria-label="Base branch"
            data-slot="agents-base-branch"
            value={config.baseBranch ?? ''}
            disabled={save.isPending}
            onChange={(event) => save.mutate({ baseBranch: event.target.value || null })}
            className="block w-full max-w-md rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
          >
            <option value="">follow checked-out branch (default)</option>
            {repo.data.branches.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        ) : (
          <p data-slot="agents-base-branch-unavailable" className="text-[13px] text-soft-foreground">
            {repo.isPending ? 'Loading branches…' : 'Not a git repository — tasks run in place, no branching.'}
          </p>
        )}
      </Field>
    </div>
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
    <Field
      title={hasAccounts ? 'Default agent' : 'Default runner'}
      hint={
        hasAccounts
          ? 'Preselected for new tasks in THIS repo, and used by the chain planner. Each task can still pick another agent or account. The account is stored on this machine only — it is never committed, so a teammate keeps their own.'
          : 'Preselected for new tasks in THIS repo, and used by the chain planner. Each task can still pick another runner.'
      }
    >
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
      {!providerStatus.isPending &&
      !providerStatus.isError &&
      providerStatusFor(providerStatus.data, defaultRunner)?.enabled === false ? (
        <p className="text-[13px] text-muted-foreground">
          This provider is disabled. Enable it above or choose another provider.
        </p>
      ) : null}
      {hasAccounts ? (
        <p className="max-w-md text-[13px] text-muted-foreground">
          Tasks already started under another account can’t be resumed here — their sessions live in
          that account’s folder.
        </p>
      ) : null}
    </Field>
  )
}

/** The Appearance section's field chassis — same rhythm, so Settings reads as one surface. */
function Field({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <p className="text-[13px] text-muted-foreground">{hint}</p>
      </div>
      {children}
    </section>
  )
}

/**
 * Permission presets + optional advanced allow/ask/deny rules (spec 2026-07-17-permission-modes).
 * Edits locally then saves explicitly — same pattern as the system prompt textarea.
 */
function PermissionsField({
  config,
  saving,
  onSave,
}: {
  config: ConfigResponse
  saving: boolean
  onSave: (permissions: SetConfigInput['permissions']) => void
}) {
  const savedMode: PermissionChoice = config.permissions?.mode && (PERMISSION_MODES.some((m) => m.id === config.permissions?.mode))
    ? (config.permissions.mode as PermissionMode)
    : 'default'
  const [mode, setMode] = useState<PermissionChoice>(savedMode)
  const [allowText, setAllowText] = useState(formatPermissionRulesText(config.permissions?.rules?.allow))
  const [askText, setAskText] = useState(formatPermissionRulesText(config.permissions?.rules?.ask))
  const [denyText, setDenyText] = useState(formatPermissionRulesText(config.permissions?.rules?.deny))

  const savedKey = JSON.stringify(config.permissions ?? null)
  useEffect(() => {
    setMode(savedMode)
    setAllowText(formatPermissionRulesText(config.permissions?.rules?.allow))
    setAskText(formatPermissionRulesText(config.permissions?.rules?.ask))
    setDenyText(formatPermissionRulesText(config.permissions?.rules?.deny))
  }, [savedKey]) // eslint-disable-line react-hooks/exhaustive-deps -- re-seed only when server payload changes

  const parsedAllow = parsePermissionRulesText(allowText)
  const parsedAsk = parsePermissionRulesText(askText)
  const parsedDeny = parsePermissionRulesText(denyText)
  const invalid = [...parsedAllow.invalid, ...parsedAsk.invalid, ...parsedDeny.invalid]
  const allow = parsedAllow.rules
  const ask = parsedAsk.rules
  const deny = parsedDeny.rules
  const hasRules = Boolean(allow || ask || deny)
  const draft =
    mode === 'default'
      ? null
      : {
          mode,
          ...(hasRules ? { rules: { ...(allow ? { allow } : {}), ...(ask ? { ask } : {}), ...(deny ? { deny } : {}) } } : {}),
        }
  const saved = config.permissions ?? null
  const savedComparable = saved
    ? {
        mode: saved.mode,
        ...(saved.rules && (saved.rules.allow?.length || saved.rules.ask?.length || saved.rules.deny?.length)
          ? {
              rules: {
                ...(saved.rules.allow?.length ? { allow: saved.rules.allow } : {}),
                ...(saved.rules.ask?.length ? { ask: saved.rules.ask } : {}),
                ...(saved.rules.deny?.length ? { deny: saved.rules.deny } : {}),
              },
            }
          : {}),
      }
    : null
  const dirty = JSON.stringify(draft) !== JSON.stringify(savedComparable)

  return (
    <Field
      title="Permissions"
      hint="What agents may do without asking. Applies to every new task; each task can override it in the composer."
    >
      <div data-slot="agents-permissions" className="flex max-w-xl flex-col gap-2">
        {[DEFAULT_PERMISSION_PRESET, ...PERMISSION_MODES].map((preset) => (
          <label
            key={preset.id}
            className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3.5 py-3 ${
              mode === preset.id ? 'border-ring bg-muted/40' : 'border-border'
            }`}
          >
            <input
              type="radio"
              name="permission-mode"
              className="mt-1"
              checked={mode === preset.id}
              disabled={saving}
              onChange={() => setMode(preset.id)}
            />
            <span>
              <span className="flex items-center gap-2 text-[13.5px] font-semibold text-foreground">
                {preset.label}
                {preset.id === 'default' ? (
                  <span className="rounded-full border border-border px-2 py-px text-[10.5px] font-medium text-muted-foreground">
                    zero-config
                  </span>
                ) : null}
              </span>
              <span className="mt-0.5 block text-[12.5px] text-muted-foreground">{preset.desc}</span>
            </span>
          </label>
        ))}

        <details className="mt-2 border-t border-border pt-3">
          <summary className="cursor-pointer text-[13px] text-muted-foreground">
            Advanced rules — fine-tune the preset with per-tool patterns
          </summary>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            {(
              [
                ['Always allow', allowText, setAllowText],
                ['Always ask', askText, setAskText],
                ['Always deny', denyText, setDenyText],
              ] as const
            ).map(([label, value, setValue]) => (
              <label key={label} className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">{label}</span>
                <Textarea
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  disabled={saving}
                  placeholder={'Bash(git *)\nEdit'}
                  className="min-h-24 font-mono text-xs"
                />
              </label>
            ))}
          </div>
          <p className="mt-2 rounded-md border border-border bg-muted/30 px-2.5 py-2 text-xs text-muted-foreground">
            One rule per line: <code>Tool</code> or <code>Tool(pattern)</code>. Deny wins over ask,
            ask wins over allow. Fidelity varies by runner — codex applies the preset only;
            opencode applies tool-level rules. A run notes anything it couldn&apos;t apply.
          </p>
          {invalid.length > 0 ? (
            <p role="alert" className="mt-2 text-xs text-danger">
              Invalid specifiers (Tool or Tool(pattern) only, no spaces around the name): {invalid.join(', ')}
            </p>
          ) : null}
        </details>

        <div className="flex items-center gap-3 pt-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-action="agents-save-permissions"
            disabled={!dirty || saving || invalid.length > 0}
            onClick={() => onSave(draft)}
          >
            Save
          </Button>
          <p className="text-[11px] text-soft-foreground">Applied to new runs only.</p>
        </div>
      </div>
    </Field>
  )
}


