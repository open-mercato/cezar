import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ArrowDownIcon, ArrowUpIcon, BotIcon, GripVerticalIcon, PlusIcon, XIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import type { ReactNode } from 'react'

import {
  useAgentProfiles,
  useAgentFallbackPolicy,
  useSaveAgentFallbackPolicy,
  useConfig,
  useProjects,
  useProviderStatus,
  useRepo,
  useRunnerModelCatalogs,
  useSelectAgentProfile,
} from '@/api/queries'
import { useProjectScope } from '@/api/project-scope-context'
import { ApiError } from '@/api/client'
import type { AgentFallbackCandidate, AgentFallbackPolicy, ConfigResponse, Runner } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import { providerStatusFor } from '@/lib/provider-status'
import {
  DefaultAgentPicker,
  agentPickerRows,
  hasAgentAccounts,
} from '@/components/default-agent-picker'
import { modelCatalogStatus, modelsForRunner, RUNNERS } from '@/routes/new-task-form'
import { ProviderSettings } from './provider-settings'
import { useConfigSave } from './use-config-save'

/**
 * Settings → Agents (R6 Step 1.5, spec §"Settings"): which agent runs THIS repo's tasks —
 * providers, the default runner (and account), and per-runner model presets. What the user
 * writes FOR a model lives in Settings → Instructions, and how a task behaves (base branch,
 * review gate, live titles) in Settings → Tasks; a textarea beside the runner picker kept
 * reading as "configure the agent".
 *
 * Copy stays coding-agent-agnostic by rule: the section describes capabilities (`runner`,
 * `model`), never vendor config formats.
 *
 * Persistence: every control PUTs a partial patch through `useConfigSave`; the server merges it
 * into the raw config.json so user keys survive.
 */

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
  const save = useConfigSave()
  const scope = useProjectScope()
  const fallbackProjectId = scope.projectId ?? 'default'
  const fallback = useAgentFallbackPolicy(fallbackProjectId)
  const saveFallback = useSaveAgentFallbackPolicy(fallbackProjectId)
  const profiles = useAgentProfiles()
  const repo = useRepo()
  const repoRoot = repo.data?.info?.root
  const selection = repoRoot ? profiles.data?.selections[repoRoot] : undefined
  const defaultProfileId = selection?.[config.defaultRunner] ?? profiles.data?.defaults[config.defaultRunner] ?? 'default'

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

      <FallbackField
        policy={fallback.data}
        loadError={fallback.isError ? fallback.error : null}
        profiles={profiles.data?.profiles ?? []}
        providerStatus={providerStatus}
        catalogs={catalogs}
        modelsLocked={config.modelsLocked}
        defaultProfileId={defaultProfileId}
        defaultRunner={config.defaultRunner}
        saving={saveFallback.isPending}
        onRetry={() => void fallback.refetch()}
        onSave={(enabled, candidates, onDone) => {
          if (!fallback.data) return
          saveFallback.mutate(
            {
              expectedRevision: fallback.data.revision,
              expectedIncarnation: fallback.data.incarnation,
              enabled,
              candidates: candidates ?? fallback.data.candidates,
            },
            {
              onSuccess: () => onDone?.(),
              onError: (error) => {
                // A 409 means the stored policy moved (another tab or process): reload it, or every
                // later click would resend the same stale revision.
                if (error instanceof ApiError && error.status === 409) void fallback.refetch()
                toast(
                  error instanceof ApiError && error.status === 409 && error.message.includes('changed')
                    ? 'Fallback settings changed elsewhere — reloaded. Try again.'
                    : error instanceof Error ? error.message : 'Could not save fallback settings',
                  { tone: 'danger' },
                )
              },
            },
          )
        }}
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
                      // Picking auto is a CHOICE, not the absence of one (#906): clearing the
                      // preset alone let the coding agent's own settings file show through again,
                      // so the select snapped straight back to the model it names. The additive
                      // override says "ignore that default"; picking a real model clears it.
                      save.mutate({
                        defaultModels: { [runner.id]: event.target.value || null } as Partial<
                          Record<Runner, string | null>
                        >,
                        defaultModelsAuto: { [runner.id]: event.target.value === '' } as Partial<
                          Record<Runner, boolean>
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
    </div>
  )
}

function FallbackRow({ id, label, disabled, children }: {
  id: string; label: string; disabled: boolean; children: ReactNode
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id, disabled })
  return (
    <li ref={setNodeRef} data-slot="fallback-row"
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`relative flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-sm ${isDragging ? 'z-10 shadow-md' : ''}`}
    >
      <Button ref={setActivatorNodeRef} type="button" variant="ghost" size="icon-sm"
        className="min-h-11 min-w-11 shrink-0 cursor-grab touch-none active:cursor-grabbing aria-disabled:cursor-default aria-disabled:opacity-50"
        {...attributes} {...listeners} aria-label={label} aria-disabled={disabled || undefined}
      >
        <GripVerticalIcon aria-hidden="true" />
      </Button>
      {children}
    </li>
  )
}

type FallbackOption = { key: string; provider: AgentFallbackCandidate['provider']; profileId: string; label: string }

const MAX_FALLBACK_AGENTS = 10

/**
 * Automatic fallback (spec 2026-10-20-agent-usage-limit-fallback): the ordered agents that take a
 * task over when its agent runs out of usage allowance. Every edit is one compare-and-swap PUT.
 */
function FallbackField({
  policy,
  loadError,
  profiles,
  providerStatus,
  catalogs,
  modelsLocked,
  defaultProfileId,
  defaultRunner,
  saving,
  onSave,
  onRetry,
}: {
  policy?: AgentFallbackPolicy
  loadError: Error | null
  profiles: Array<{ id: string; provider: string; label: string }>
  providerStatus: ReturnType<typeof useProviderStatus>
  catalogs: ReturnType<typeof useRunnerModelCatalogs>
  defaultRunner: Runner
  defaultProfileId: string
  modelsLocked: boolean
  saving: boolean
  onSave: (enabled: boolean, candidates?: AgentFallbackCandidate[], onDone?: () => void) => void
  onRetry: () => void
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const dragRevision = useRef<number | null>(null)
  const title = 'Automatic fallback'
  const hint = 'When the agent working on a task runs out of its usage allowance, the next agent below continues the same task.'
  const runnerLabel = (id: string) => RUNNERS.find((runner) => runner.id === id)?.label ?? id
  // Every runner offers its discovered login; runners with extra accounts list those too.
  const options: FallbackOption[] = RUNNERS.flatMap((runner) => {
    const own = profiles.filter((profile) => profile.provider === runner.id)
    const rows = own.length > 0 ? own : [{ id: 'default', provider: runner.id, label: 'Default' }]
    return rows.map((profile) => ({
      key: `${runner.id}:${profile.id}`,
      provider: runner.id as AgentFallbackCandidate['provider'],
      profileId: profile.id,
      label: `${runner.label} · ${profile.id === 'default' ? 'Default' : profile.label || profile.id}`,
    }))
  })
  const keyOf = (candidate: AgentFallbackCandidate) => `${candidate.provider}:${candidate.profileId}`
  const added = new Set(policy?.candidates.map(keyOf) ?? [])
  const addable = options.filter((option) => !added.has(option.key))
  const [picked, setPicked] = useState('')
  const [pickedModel, setPickedModel] = useState('')
  /** Polite announcement of the last saved edit, for screen readers. */
  const [announcement, setAnnouncement] = useState('')
  const selected = addable.find((option) => option.key === picked) ?? addable[0]

  if (loadError) {
    const localOnly = loadError instanceof ApiError && loadError.status === 409
      && loadError.message === 'agent fallback is local-only'
    return (
      <Field title={title} hint={hint}>
        <p data-slot="fallback-unavailable" className="max-w-md text-[13px] text-muted-foreground">
          {localOnly
            ? 'Automatic fallback is available on a local cockpit only.'
            : `Fallback settings did not load — ${loadError.message}`}
        </p>
        {localOnly ? null : (
          <Button type="button" variant="outline" size="sm" className="w-fit" onClick={onRetry}>
            Retry
          </Button>
        )}
      </Field>
    )
  }
  if (!policy) {
    return (
      <Field title={title} hint={hint}>
        <p data-slot="fallback-loading" className="text-[13px] text-soft-foreground">Loading fallback settings…</p>
      </Field>
    )
  }

  const candidates = policy.candidates
  const labelFor = (candidate: AgentFallbackCandidate) =>
    options.find((option) => option.key === keyOf(candidate))?.label ?? `${runnerLabel(candidate.provider)} · ${candidate.profileId}`
  /** Why a row will be skipped at hand-over time, if it will. */
  const problemFor = (candidate: AgentFallbackCandidate): string | undefined => {
    if (candidate.profileId !== 'default' && !profiles.some((p) => p.id === candidate.profileId && p.provider === candidate.provider)) {
      return 'Account removed — will be skipped'
    }
    if (modelsLocked && candidate.model) return 'Model selection is locked — remove and add this agent again to use native settings.'
    const status = providerStatusFor(providerStatus.data, candidate.provider as Runner)
    if (status?.enabled === false) return 'Provider disabled — will be skipped'
    if (status && status.status !== 'connected') return 'Not connected — will be skipped'
    return undefined
  }
  /** The project's default agent is skipped for tasks it starts — a task never falls back to itself. */
  const ownAgentNote = (candidate: AgentFallbackCandidate): string | undefined =>
    candidate.provider === defaultRunner && candidate.profileId === defaultProfileId
      ? 'This is the default agent — skipped for tasks that start on it'
      : undefined
  const add = () => {
    if (!selected || saving) return
    const label = selected.label
    onSave(
      policy.enabled,
      [...candidates, { provider: selected.provider, profileId: selected.profileId, ...(!modelsLocked && pickedModel ? { model: pickedModel } : {}) }],
      () => {
        // Cleared only once saved, so a refused save keeps the user's pick.
        setPicked('')
        setPickedModel('')
        setAnnouncement(`${label} added at position ${candidates.length + 1}`)
      },
    )
  }
  const remove = (index: number) => {
    const removed = candidates[index]
    if (!removed || saving) return
    const next = candidates.filter((_, i) => i !== index)
    onSave(policy.enabled && next.length > 0, next, () => setAnnouncement(`${labelFor(removed)} removed from fallback`))
  }
  const move = (index: number, delta: number) => {
    const target = index + delta
    const moving = candidates[index]
    if (!moving || saving || target === index || target < 0 || target >= candidates.length) return
    const next = candidates.filter((_, i) => i !== index)
    next.splice(target, 0, moving)
    onSave(policy.enabled, next, () => setAnnouncement(`${labelFor(moving)} moved to position ${target + 1}`))
  }
  const modelRunner = (selected?.provider ?? defaultRunner) as Runner
  const modelCatalog = catalogs[modelRunner]
  const modelStatus = modelCatalogStatus(modelRunner, modelCatalog?.data, modelCatalog?.isError ?? false)
  const full = candidates.length >= MAX_FALLBACK_AGENTS

  return (
    <Field title={title} hint={hint} action={
      <Switch
        aria-label="Automatic fallback"
        aria-describedby="fallback-state fallback-disclosure"
        data-slot="fallback-enabled"
        checked={policy.enabled}
        disabled={saving || candidates.length === 0}
        onCheckedChange={(checked) => onSave(checked)}
      />
    }>
      <div data-slot="fallback-section" className="flex max-w-md flex-col gap-3">
        <p id="fallback-state" className="text-[13px] text-muted-foreground">
          {policy.enabled ? 'On — agents take over in the order below.' : candidates.length === 0
            ? 'Off — add an agent first.' : 'Off — the list is saved but not used.'}
        </p>
        <p id="fallback-disclosure" className="text-[13px] text-muted-foreground">
          The next agent’s provider receives the task and its repository context, and may bill its own plan.
        </p>

        {candidates.length === 0 ? (
          <p data-slot="fallback-empty" className="text-[13px] text-muted-foreground">
            No fallback agents yet. Add the agent that should take over first.
          </p>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter}
            accessibility={{
              screenReaderInstructions: { draggable: 'Press Space to pick up an agent, arrow keys to move, Space to drop, or Escape to cancel.' },
              announcements: {
                onDragStart: ({ active }) => {
                  const candidate = candidates.find((c) => keyOf(c) === active.id)
                  return candidate ? `Picked up ${labelFor(candidate)}.` : 'Picked up agent.'
                },
                onDragOver: ({ over }) => over ? `Position ${candidates.findIndex((c) => keyOf(c) === over.id) + 1} of ${candidates.length}.` : 'Outside the list.',
                onDragEnd: () => 'Drag ended. Changes are saved after dropping in a new position.',
                onDragCancel: () => 'Reordering cancelled. Order unchanged.',
              },
            }}
            onDragStart={() => { dragRevision.current = policy.revision }}
            onDragCancel={() => { dragRevision.current = null }}
            onDragEnd={({ active, over }) => {
              const revision = dragRevision.current
              dragRevision.current = null
              if (!over || saving || revision !== policy.revision) return
              const from = candidates.findIndex((c) => keyOf(c) === active.id)
              const to = candidates.findIndex((c) => keyOf(c) === over.id)
              if (from >= 0 && to >= 0) move(from, to - from)
            }}
          >
            <SortableContext items={candidates.map(keyOf)} strategy={verticalListSortingStrategy}>
              <ol aria-label="Fallback order" data-slot="fallback-order" className="flex flex-col gap-1.5">
                {candidates.map((candidate, index) => {
                  const label = labelFor(candidate)
                  const problem = problemFor(candidate)
                  const note = ownAgentNote(candidate)
                  return (
                    <FallbackRow key={keyOf(candidate)} id={keyOf(candidate)}
                      label={`Reorder ${label}, position ${index + 1} of ${candidates.length}`}
                      disabled={saving || candidates.length < 2}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="font-mono text-xs text-muted-foreground">{index + 1}.</span> {label}
                        <span className="text-muted-foreground"> · {candidate.model ?? 'auto model'}</span>
                        {problem ? <span className="block text-xs text-danger">{problem}</span> : null}
                        {note ? <span className="block text-xs text-muted-foreground">{note}</span> : null}
                      </span>
                      <span className="flex gap-1">
                        <Button type="button" variant="ghost" size="icon-xs" className="aria-disabled:opacity-50 aria-disabled:hover:bg-transparent" aria-label={`Move ${label} up`} aria-disabled={saving || index === 0 || undefined} onClick={() => move(index, -1)}>
                          <ArrowUpIcon />
                        </Button>
                        <Button type="button" variant="ghost" size="icon-xs" className="aria-disabled:opacity-50 aria-disabled:hover:bg-transparent" aria-label={`Move ${label} down`} aria-disabled={saving || index === candidates.length - 1 || undefined} onClick={() => move(index, 1)}>
                          <ArrowDownIcon />
                        </Button>
                        <Button type="button" variant="danger-ghost" size="icon-xs" className="aria-disabled:opacity-50 aria-disabled:hover:bg-transparent" aria-label={`Remove ${label} from fallback`} aria-disabled={saving || undefined} onClick={() => remove(index)}>
                          <XIcon />
                        </Button>
                      </span>
                    </FallbackRow>
                  )
                })}
              </ol>
            </SortableContext>
          </DndContext>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Agent to add"
            data-slot="fallback-add-agent"
            value={selected?.key ?? ''}
            onChange={(event) => { setPicked(event.target.value); setPickedModel('') }}
            disabled={saving || full || addable.length === 0}
            className="min-w-0 flex-1 basis-full sm:basis-0 rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
          >
            {addable.length === 0 ? <option value="">Every agent is already listed</option> : null}
            {addable.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
          </select>
          {modelsLocked ? (
            <output
              aria-label="Model for the agent to add"
              title="Model selection is locked to native coding-agent settings."
              className="min-w-0 flex-1 rounded-md border border-input bg-muted/30 px-3 py-1.5 text-sm text-muted-foreground"
            >
              Native agent settings
            </output>
          ) : (
            <select
              aria-label="Model for the agent to add"
              data-slot="fallback-add-model"
              value={pickedModel}
              onChange={(event) => setPickedModel(event.target.value)}
              disabled={saving || full || !selected}
              className="min-w-0 flex-1 rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
            >
              <option value="">auto model</option>
              {modelsForRunner(modelRunner, modelCatalog?.data, []).map((model) =>
                model.id ? <option key={model.id} value={model.id}>{model.label}</option> : null,
            )}
            {modelStatus ? <option disabled>{modelStatus}</option> : null}
          </select>
          )}
          <Button type="button" variant="outline" size="sm" data-slot="fallback-add" disabled={saving || full || !selected} onClick={add}>
            <PlusIcon /> Add agent
          </Button>
        </div>
        {full ? <p className="text-[13px] text-muted-foreground">Up to {MAX_FALLBACK_AGENTS} agents.</p> : null}

        <div data-slot="fallback-terms" className="space-y-2 text-[13px] text-muted-foreground">
          <p>Settings changes apply to new tasks. Each agent is tried once. If no agent in the list can continue, the task stops and waits for you.</p>
          <details>
            <summary className="w-fit cursor-pointer rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">Scope and permissions</summary>
            <div className="mt-2 space-y-2">
              <p>Quick task and the final step of step-list workflows can switch agents; workflow graphs and earlier steps keep waiting for the limit to reset.</p>
              <p>Task budgets still apply. Tool restrictions are enforced by Claude only; other agents run with their own permissions.</p>
            </div>
          </details>
        </div>
        <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
      </div>
    </Field>
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
function Field({ title, hint, children, action }: { title: string; hint: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <p className="text-[13px] text-muted-foreground">{hint}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}
