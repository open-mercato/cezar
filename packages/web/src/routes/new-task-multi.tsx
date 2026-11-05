import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState, type MutableRefObject } from 'react'

import { putUiState } from '@/api/client'
import {
  queryKeys,
  useRunnerModels,
} from '@/api/queries'
import { useHarnessProbe, useHarnessStatus } from '@/api/harness'
import { extractTaskRefs } from '@open-mercato/cezar-api-client'
import type {
  HarnessPreset,
  HarnessRoles,
  HarnessSkillProfile,
  Runner,
} from '@open-mercato/cezar-api-client'
import { toast } from '@/components/ui/toaster'

import type { NewTaskDraft } from './new-task-draft'
import { modelsForRunner } from './new-task-form'
import { HarnessPanel, HarnessSetupDialog } from './new-task-harness'
import {
  HARNESS_MODES,
  advisorHarnessOptions,
  canSaveHarnessPreset,
  defaultHarnessRoles,
  harnessRolesIssue,
  harnessStartBlock,
  isHarnessRunner,
  modelFamilyOf,
  normalizeHarnessPresets,
  sessionRoleOptions,
  type HarnessModelOption,
} from './new-task-harness-form'

/** The harness half of a start, validated: the composer adds the task text and attachments. */
export interface MultiModelStart {
  workflow: string
  harnessRoles: HarnessRoles
  harnessIssueId?: string
  harnessSkillProfile: HarnessSkillProfile
  harnessBaseAcknowledgement?: { configuredBase: string; remoteDefault: string; reason: string }
}

/** What the composer's submit asks of this surface. */
export interface MultiModelController {
  /** Throws the reason the lineup cannot start, opening model setup when that is the remedy. */
  prepareStart: () => MultiModelStart
}

/**
 * The Multi-model tab's state and controls (user feedback 2026-07-24), in the lazily loaded chunk:
 * multi-model is opt-in, so its catalogs, probe, presets and picker helpers stay out of the New
 * Task route's eager bundle. Mounted only while the Multi-model tab is open.
 */
export function MultiModelSurface({
  draft,
  sourceRef,
  update,
  runners,
  providersPending,
  modelsLocked,
  gitReady,
  gitFailed,
  presetsRaw,
  onConfigureModels,
  onBackToTask,
  controllerRef,
  onSendBlockedReason,
}: {
  draft: Pick<NewTaskDraft, 'text' | 'harnessMode' | 'harnessRoles' | 'harnessSkillProfile' | 'harnessIssueId'>
  /** The picked source's ref: a harness workflow preselects its mode. */
  sourceRef: string | undefined
  update: (patch: Partial<NewTaskDraft>) => void
  runners: readonly Runner[]
  providersPending: boolean
  modelsLocked: boolean
  gitReady: boolean | undefined
  gitFailed: boolean
  presetsRaw: unknown
  onConfigureModels: () => void
  onBackToTask: () => void
  controllerRef: MutableRefObject<MultiModelController | null>
  onSendBlockedReason: (reason: string | undefined) => void
}) {
  const queryClient = useQueryClient()
  const harnessMode =
    draft.harnessMode ?? HARNESS_MODES.find((m) => m.workflow === sourceRef)?.id ?? 'fix-issue'
  const harnessSkillProfile = draft.harnessSkillProfile ?? 'generic'
  const inferredIssue = extractTaskRefs(draft.text).issueNumber
  const issueValue = draft.harnessIssueId ?? (inferredIssue === undefined ? '' : String(inferredIssue))
  const issueId = String(extractTaskRefs(issueValue).issueNumber ?? issueValue.trim().replace(/^#(?=\d+$)/, ''))
  const issueReason = harnessMode === 'fix-issue' && !issueId
    ? 'Enter an issue ID, or choose Build a feature to work from a brief.'
    : undefined
  const gitReason = gitReady === false
    ? 'Choose a Git repository with at least one commit for this multi-model run.'
    : gitReady === undefined
      ? (gitFailed ? 'Could not verify this project’s Git repository. Reload to try again.' : 'Checking this project’s Git repository…')
      : undefined
  // The multi-model surface needs every runner's catalog at once to build the role lineup.
  // Only the runners a lineup can seat: cursor/junie/pi/copilot catalogs would be fetched for nothing.
  const harnessCatalogs = {
    claude: useRunnerModels('claude'),
    codex: useRunnerModels('codex'),
    opencode: useRunnerModels('opencode'),
  }
  const claudeCatalogData = harnessCatalogs.claude.data
  const codexCatalogData = harnessCatalogs.codex.data
  const opencodeCatalogData = harnessCatalogs.opencode.data
  // Configured agentHarness advisor bindings (kimi-subscription, deepseek-api…)
  // join the reviewer options (spec 2026-07-23-harness-orchestration).
  const harnessStatus = useHarnessStatus(true)
  const harnessStatusData = harnessStatus.data
  const [harnessBaseReason, setHarnessBaseReason] = useState('')
  const harnessOptions = useMemo<HarnessModelOption[]>(() => {
    // pi, Junie, Cursor and Copilot are first-class ordinary runners, but the harness has no
    // probe/runtime binding for them yet. Do not advertise a lineup the conductor cannot execute.
    const runnerOptions: HarnessModelOption[] = runners.filter(isHarnessRunner).flatMap((r) => {
      return modelsForRunner(
        r,
        r === 'codex' ? codexCatalogData : r === 'opencode' ? opencodeCatalogData : claudeCatalogData,
      ).map((m) => ({
        runner: r,
        model: m.id,
        label: m.label,
        family: modelFamilyOf({ runner: r, model: m.id }),
        // OpenCode's descriptions only say "via <provider>", which the row label already names.
        ...(m.desc && r !== 'opencode' ? { desc: m.desc } : {}),
      }))
    })
    return [...runnerOptions, ...advisorHarnessOptions(harnessStatusData, runnerOptions)]
  },
  // `runners` derives from provider status; join to a stable key so the memo
  // doesn't churn on every render's fresh array identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [runners.join(','), claudeCatalogData, codexCatalogData, opencodeCatalogData, harnessStatusData])
  // Split by transport, because they answer different questions (2026-07-27):
  // orchestrator and implementer can ONLY be runner-backed, so a workspace with
  // one runner family and three configured advisors still cannot field a lineup
  // — and used to be told "no models are available yet", which is false and
  // sends the user to the wrong fix.
  //
  // `sessionRoleOptions` and not "not an advisor": OpenCode is runner-backed but
  // cannot hold a session to stage-only, so it seats reviewers only. Counting it
  // here let a claude+opencode workspace past this gate and into a lineup the
  // server then refused.
  const harnessRunnerFamilies = useMemo(
    () => [...new Set(sessionRoleOptions(harnessOptions).map((o) => o.family))],
    [harnessOptions],
  )
  const harnessAdvisorFamilies = useMemo(
    () => [...new Set(harnessOptions.filter((o) => o.runner === 'harness').map((o) => o.family))],
    [harnessOptions],
  )
  const harnessRoles = draft.harnessRoles ?? defaultHarnessRoles(harnessOptions)
  const harnessBlocked = harnessRoles === null
  const modelLockReason = modelsLocked
    ? 'Multi-model lineups need model selection unlocked. Turn off the native model lock first.'
    : undefined
  const harnessProbe = useHarnessProbe(modelsLocked ? null : harnessRoles)
  const harnessProbeBlock = harnessStartBlock(
    harnessProbe.data,
    harnessProbe.isPending || harnessProbe.isFetching,
    harnessProbe.isError,
  )
  // A harness precondition blocks SENDING, never typing (2026-07-27). An incomplete lineup stays
  // sendable: its probe never runs, and submit is what reopens model setup and says why.
  const sendBlockedReason = modelLockReason ?? gitReason ?? issueReason ?? (!harnessBlocked ? (harnessProbeBlock ?? undefined) : undefined)
  useEffect(() => {
    onSendBlockedReason(sendBlockedReason)
  }, [sendBlockedReason]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onSendBlockedReason(undefined), []) // eslint-disable-line react-hooks/exhaustive-deps
  const harnessCatalogsLoading = providersPending || harnessStatus.isPending ||
    runners.filter(isHarnessRunner).some((candidate) => harnessCatalogs[candidate].isPending)
  const [harnessSetupOpen, setHarnessSetupOpen] = useState(false)
  useEffect(() => {
    // Opening the Multi-model tab without the models to field a council prompts setup
    // immediately (user feedback 2026-07-24) — not an inline error after the fact.
    //
    // It also has to CLOSE again (2026-07-27): the model catalogs and
    // `/harness/status` land asynchronously, so the first render of this tab is
    // always "blocked", and a dialog that only ever opened then sat on top of a
    // perfectly valid lineup once the data arrived.
    if (modelsLocked) {
      setHarnessSetupOpen(false)
      return
    }
    if (harnessCatalogsLoading) return
    setHarnessSetupOpen(harnessBlocked)
  }, [harnessBlocked, harnessCatalogsLoading, modelsLocked])
  // Saved lineups (2026-07-24) live in the project's ui-state — passthrough by design, so
  // this is purely additive client state. Save replaces a same-named preset; the list caps.
  const harnessPresets = useMemo(() => normalizeHarnessPresets(presetsRaw), [presetsRaw])
  const persistHarnessPresets = (next: HarnessPreset[]) => {
    void putUiState({ harnessPresets: next })
      .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.uiState }))
      .catch(() => toast('Could not save your model lineups. Try again.', { tone: 'danger' }))
  }
  const saveHarnessPreset = (name: string) => {
    if (harnessRoles === null) return
    // Explicit cap (2026-07-24): the panel refuses past the limit with
    // guidance — never a silent eviction of someone's saved lineup. Replacing
    // a same-named preset is in-place and always allowed.
    if (!canSaveHarnessPreset(harnessPresets, name).ok) return
    persistHarnessPresets([
      ...harnessPresets.filter((p) => p.name !== name),
      { id: crypto.randomUUID(), name, roles: harnessRoles },
    ])
  }
  const startHarnessSetup = () => {
    setHarnessSetupOpen(false)
    onConfigureModels()
  }

  controllerRef.current = {
    prepareStart: () => {
      if (modelLockReason) throw new Error(modelLockReason)
      if (gitReason) throw new Error(gitReason)
      if (issueReason) throw new Error(issueReason)
      if (harnessBlocked || harnessRoles === null) {
        setHarnessSetupOpen(true)
        throw new Error('Multi-model needs models from at least two families — configure models first.')
      }
      if (harnessProbeBlock) throw new Error(harnessProbeBlock)
      const staleBase = harnessStatusData?.base
      if (
        staleBase?.stale &&
        staleBase.configured &&
        staleBase.remoteDefault &&
        harnessBaseReason.trim().length < 3
      ) {
        throw new Error('Explain why this run should use the configured stale base, or update the base branch first.')
      }
      const rolesIssue = harnessRolesIssue(harnessRoles)
      if (rolesIssue) throw new Error(rolesIssue)
      const modeDef = HARNESS_MODES.find((m) => m.id === harnessMode) ?? HARNESS_MODES[0]!
      return {
        workflow: modeDef.workflow,
        harnessRoles,
        harnessSkillProfile,
        ...(harnessMode === 'fix-issue' ? { harnessIssueId: issueId } : {}),
        ...(staleBase?.stale && staleBase.configured && staleBase.remoteDefault
          ? {
              harnessBaseAcknowledgement: {
                configuredBase: staleBase.configured,
                remoteDefault: staleBase.remoteDefault,
                reason: harnessBaseReason.trim(),
              },
            }
          : {}),
      }
    },
  }
  useEffect(() => () => {
    controllerRef.current = null
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (modelLockReason) {
    return (
      <p role="alert" className="mt-2.5 rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground">
        {modelLockReason}
      </p>
    )
  }

  return (
    <>
      {gitReason ? (
        <div role="status" className="mt-2.5 rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground" data-slot="harness-git-guidance">
          <p className="font-medium text-foreground">{gitReason}</p>
          {gitReady === false ? (
            <p className="mt-1">Use the project picker above to select or add the repository folder. Cezar creates an isolated worktree automatically.</p>
          ) : null}
        </div>
      ) : null}
      <HarnessPanel
        mode={harnessMode}
        onMode={(next) => update({ harnessMode: next })}
        issueId={issueValue}
        onIssueId={(next) => update({ harnessIssueId: next })}
        skillProfile={harnessSkillProfile}
        onSkillProfile={(next) => update({ harnessSkillProfile: next })}
        probe={harnessProbe.data}
        probePending={harnessProbe.isFetching}
        probeError={harnessProbe.isError ? 'Model readiness could not be verified. Try again.' : undefined}
        onRetryProbe={() => { void harnessProbe.refetch() }}
        base={harnessStatusData?.base}
        baseAcknowledgementReason={harnessBaseReason}
        onBaseAcknowledgementReason={setHarnessBaseReason}
        roles={harnessRoles}
        onRoles={(next) => update({ harnessRoles: next })}
        options={harnessOptions}
        presets={harnessPresets}
        onApplyPreset={(preset) => update({ harnessRoles: preset.roles })}
        onSavePreset={saveHarnessPreset}
        onDeletePreset={(id) => persistHarnessPresets(harnessPresets.filter((p) => p.id !== id))}
        onAddModels={startHarnessSetup}
      />
      {harnessSetupOpen ? (
        <HarnessSetupDialog
          families={harnessRunnerFamilies}
          advisorFamilies={harnessAdvisorFamilies}
          onConfigure={startHarnessSetup}
          onBackToTask={() => {
            setHarnessSetupOpen(false)
            onBackToTask()
          }}
          onClose={() => setHarnessSetupOpen(false)}
        />
      ) : null}
    </>
  )
}
