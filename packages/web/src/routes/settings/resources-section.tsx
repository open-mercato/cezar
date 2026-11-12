import { useMutation, useQueryClient } from '@tanstack/react-query'
import { GaugeIcon } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'

import { putWorkspaceConfig } from '@/api/client'
import { useWorkspaceConfig, workspaceQueryKeys } from '@/api/queries'
import type { SetWorkspaceConfigInput, WorkspaceConfigResponse } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { IntegerStepper } from '@/components/integer-stepper'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import { LoadingState, SettingsSkeleton } from '@/components/loading-state'
import { CardNote, FormRow, SettingsCard, isCommitKey, useSavedFlash } from './form-row'

/**
 * Settings → Behaviour → Limits, Monitoring and New task defaults: how hard the MACHINE works.
 * `maxParallel` caps concurrent tasks across every project (the workspace semaphore holds the
 * rest); `memoryLimitMb` is the per-task ceiling the engine enforces by pausing a task that
 * crosses it and letting the queue advance (#memory-guard).
 *
 * Workspace-level since the multi-project split (spec §"Resource governance"): they protect the
 * host, not a repo, so they live in `~/.cezar/config.json` and persist through
 * `PUT /api/workspace/config` — the merged answer lands straight in the workspace config query,
 * and the server refreshes the shared semaphore so a change takes effect without a restart.
 *
 * Worktree retention stayed behind in the PROJECT settings (worktrees-section.tsx) — it sizes
 * one repo's own worktree pool, which is a property of the repo.
 */

const MAX_PARALLEL_MIN = 1
const MAX_PARALLEL_MAX = 16
const MAX_MONITORING_MAX = 16
const IDLE_TIMEOUT_MAX = 1440
const WAKE_INTERVAL_MIN = 1
const WAKE_INTERVAL_MAX = 60
/** Below this a limit would pause almost any real agent immediately — reject it as a footgun. */
const MEMORY_MIN_MB = 256

const inputClass =
  'block rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-danger disabled:opacity-50'

export function ResourcesCards() {
  const config = useWorkspaceConfig()

  if (config.isPending) {
    return (
      <LoadingState label="Loading resource settings…" data-slot="resources-loading"><SettingsSkeleton /></LoadingState>
    )
  }
  if (config.isError) {
    return (
      <CenteredState
        icon={<GaugeIcon />}
        tone="danger"
        title="Resource settings did not load"
        subtitle={config.error.message}
        heading="h2"
      />
    )
  }
  return <ResourcesForm config={config.data} />
}

function ResourcesForm({ config }: { config: WorkspaceConfigResponse }) {
  const queryClient = useQueryClient()
  const [saved, flash] = useSavedFlash()
  const [savedKey, setSavedKey] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: (patch: SetWorkspaceConfigInput) => putWorkspaceConfig(patch),
    onSuccess: (result, patch) => {
      queryClient.setQueryData(workspaceQueryKeys.config, result)
      // Which row flashes "Saved": the one key the patch carried.
      setSavedKey(Object.keys({ ...patch.resources, ...patch.composerDefaults })[0] ?? null)
      flash()
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const savedFor = (key: string) => saved && savedKey === key

  // Memory edits locally and saves on blur/Enter — an empty field means "no limit".
  const [memory, setMemory] = useState(
    config.resources.memoryLimitMb ? String(config.resources.memoryLimitMb) : '',
  )
  const configuredWake = config.resources.monitoringWakeIntervalMinutes ?? null
  const wakeMode: 'park' | 'interval' = configuredWake === null ? 'park' : 'interval'
  const [wakeInterval, setWakeInterval] = useState(String(configuredWake ?? 5))
  const wakeNum = Number(wakeInterval)
  const wakeInvalid = !Number.isInteger(wakeNum) || wakeNum < WAKE_INTERVAL_MIN || wakeNum > WAKE_INTERVAL_MAX
  const saveWake = (minutes: number | null) =>
    save.mutate({ resources: { monitoringWakeIntervalMinutes: minutes } })
  const commitWakeInterval = () => {
    if (wakeInvalid || wakeNum === configuredWake || save.isPending) return
    saveWake(wakeNum)
  }
  // Shipped ON: a server that predates the key answers without it, and reading that as "off"
  // would silently disable the feature on the one client that cannot tell the difference.
  const autoResume = config.resources.autoResumeOnUsageLimit ?? true
  const memoryNum = memory.trim() === '' ? 0 : Number(memory)
  const memoryInvalid =
    memory.trim() !== '' && (!Number.isInteger(memoryNum) || memoryNum < MEMORY_MIN_MB)
  const memoryUnchanged = (config.resources.memoryLimitMb ?? 0) === memoryNum
  const commitMemory = () => {
    if (memoryInvalid || memoryUnchanged || save.isPending) return
    // 0, not null: the workspace schema's "no limit" IS 0 (`memoryLimitMb: null` is also
    // accepted, but the route's nullable field means "clear", and clearing to the default
    // would be a different value than the user asked for).
    save.mutate({ resources: { memoryLimitMb: memoryNum === 0 ? null : memoryNum } })
  }
  const composerDefaults = config.composerDefaults ?? {
    autonomous: null,
    worktree: null,
    inheritedAutonomous: 'source-dependent' as const,
    inheritedWorktree: true,
  }
  const saveComposerDefault = (key: 'autonomous' | 'worktree', value: string) =>
    save.mutate({ composerDefaults: { [key]: value === 'inherit' ? null : value === 'on' } })
  const triState = (value: boolean | null) => (value === null ? 'inherit' : value ? 'on' : 'off')

  return (
    <div data-slot="resources-section" className="flex flex-col gap-5">
      <SettingsCard id="limits" title="Limits">
        <FormRow
          saved={savedFor('maxParallel')}
          label="Max parallel tasks"
          description={
            <>
              How many tasks run at once across every project. The rest wait in the queue. A non-git
              directory always runs one at a time. Need a different limit for one project?{' '}
              <Link
                to="/settings/global/projects"
                data-slot="resources-project-limits-link"
                className="font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
              >
                Configure per-project limits
              </Link>
              .
            </>
          }
        >
          <IntegerStepper
            aria-label="Max parallel tasks"
            data-slot="resources-max-parallel"
            value={config.resources.maxParallel}
            min={MAX_PARALLEL_MIN}
            max={MAX_PARALLEL_MAX}
            onCommit={(maxParallel) => save.mutateAsync({ resources: { maxParallel: maxParallel ?? MAX_PARALLEL_MIN } })}
          />
        </FormRow>

        <FormRow
          saved={savedFor('maxMonitoringSessions')}
          label="Extra monitoring sessions"
          description={`How many agent sessions may wait on CI, sub-agents, or monitored commands without using an active task slot. Capacity: ${config.resources.maxParallel} active + ${config.resources.maxMonitoringSessions ?? 2} monitoring. Set 0 to make monitoring share active slots.`}
        >
          <IntegerStepper
            aria-label="Extra monitoring sessions"
            data-slot="resources-max-monitoring"
            value={config.resources.maxMonitoringSessions ?? 2}
            min={0}
            max={MAX_MONITORING_MAX}
            onCommit={(sessions) => save.mutateAsync({ resources: { maxMonitoringSessions: sessions ?? 0 } })}
          />
        </FormRow>

        <FormRow
          saved={savedFor('idleTimeoutMinutes')}
          label="Waiting-session idle timeout"
          description="Minutes a plain waiting session may stay open without activity before its live backend session ends. Continue resumes it; 0 keeps it open indefinitely. Monitoring sessions are already exempt."
        >
          <IntegerStepper
            aria-label="Waiting-session idle timeout"
            data-slot="resources-idle-timeout"
            value={config.resources.idleTimeoutMinutes ?? 0}
            min={0}
            max={IDLE_TIMEOUT_MAX}
            onCommit={(minutes) => save.mutateAsync({ resources: { idleTimeoutMinutes: minutes ?? 0 } })}
          />
        </FormRow>

        <FormRow
          saved={savedFor('memoryLimitMb')}
          label="Per-task memory limit"
          description={
            memoryInvalid ? (
              <span data-slot="resources-memory-invalid" className="text-danger">
                Enter a whole number of at least {MEMORY_MIN_MB} MiB, or leave empty for no limit.
              </span>
            ) : (
              'When a task’s whole process tree crosses this, the engine pauses it with a warning and starts the next queued task. Leave empty for no limit. Applies to newly started tasks.'
            )
          }
        >
          <input
            type="number"
            inputMode="numeric"
            min={MEMORY_MIN_MB}
            step={256}
            aria-label="Per-task memory limit in MiB"
            aria-invalid={memoryInvalid || undefined}
            data-slot="resources-memory-limit"
            value={memory}
            disabled={save.isPending}
            placeholder="no limit"
            onChange={(event) => setMemory(event.target.value)}
            onBlur={commitMemory}
            onKeyDown={(event) => {
              if (isCommitKey(event)) {
                event.preventDefault()
                commitMemory()
              }
            }}
            className={`${inputClass} w-28`}
          />
          <span className="text-xs text-soft-foreground">MiB</span>
        </FormRow>
      </SettingsCard>

      <SettingsCard id="monitoring" title="Monitoring">
        <FormRow
          saved={savedFor('monitoringWakeIntervalMinutes')}
          label="Monitoring wake-up"
          description={
            wakeMode === 'interval' && wakeInvalid ? (
              <span data-slot="resources-monitoring-wake-invalid" className="text-danger">
                Enter a whole number from 1 to 60 minutes.
              </span>
            ) : (
              'Park uses no model turns. Re-check sends the same agent a follow-up on this cadence until work completes or the 40-wakeup safety cap is reached. Applied consistently to Claude, Codex and OpenCode.'
            )
          }
        >
          <Select
            value={wakeMode}
            disabled={save.isPending}
            onValueChange={(value) => saveWake(value === 'park' ? null : (wakeInvalid ? 5 : wakeNum))}
          >
            <SelectTrigger size="sm" aria-label="Monitoring wake-up" data-slot="resources-monitoring-wake-mode" data-value={wakeMode}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value="park">Park until resumed</SelectItem>
              <SelectItem value="interval">Re-check on an interval</SelectItem>
            </SelectContent>
          </Select>
          {wakeMode === 'interval' ? (
            <>
              <input
                type="number"
                min={WAKE_INTERVAL_MIN}
                max={WAKE_INTERVAL_MAX}
                aria-label="Wake interval in minutes"
                aria-invalid={wakeInvalid || undefined}
                data-slot="resources-monitoring-wake-interval"
                value={wakeInterval}
                disabled={save.isPending}
                onChange={(event) => setWakeInterval(event.target.value)}
                onBlur={commitWakeInterval}
                onKeyDown={(event) => {
                  if (isCommitKey(event)) {
                    event.preventDefault()
                    commitWakeInterval()
                  }
                }}
                className={`${inputClass} w-20`}
              />
              <span className="text-xs text-soft-foreground">min</span>
            </>
          ) : null}
        </FormRow>

        <FormRow
          saved={savedFor('autoResumeOnUsageLimit')}
          htmlFor="resources-auto-resume"
          label="Auto-resume after a usage limit"
          description="When an agent stops because its provider usage limit is reached, cezar waits for the reset the provider named and continues the task 30 seconds later — up to 12 times in a row without you. Off leaves the task failed with its Continue button. Applies to Claude, Codex and OpenCode."
        >
          <Switch
            id="resources-auto-resume"
            data-slot="resources-auto-resume"
            checked={autoResume}
            disabled={save.isPending}
            onCheckedChange={(on) => save.mutate({ resources: { autoResumeOnUsageLimit: on } })}
          />
        </FormRow>
      </SettingsCard>

      <SettingsCard id="new-task-defaults" slot="resources-composer-defaults" title="New task defaults">
        <FormRow
          saved={savedFor('autonomous')}
          label="Autonomous by default"
          description={`Inherited: ${
            composerDefaults.inheritedAutonomous === 'source-dependent'
              ? 'source-dependent — skills on, workflows off'
              : composerDefaults.inheritedAutonomous ? 'on' : 'off'
          }. Explicit choices and run-shape constraints still win.`}
        >
          <TriStateSelect
            label="Autonomous by default"
            value={triState(composerDefaults.autonomous)}
            disabled={save.isPending}
            onChange={(value) => saveComposerDefault('autonomous', value)}
          />
        </FormRow>
        <FormRow
          saved={savedFor('worktree')}
          label="Use a worktree by default"
          description={`Inherited: ${composerDefaults.inheritedWorktree ? 'on' : 'off'}. Interactive skills may recommend both off; multi-step and parallel runs remain isolated.`}
        >
          <TriStateSelect
            label="Use a worktree by default"
            value={triState(composerDefaults.worktree)}
            disabled={save.isPending}
            onChange={(value) => saveComposerDefault('worktree', value)}
          />
        </FormRow>
        <CardNote>Set stable composer defaults across projects; a project's own Agents settings can still differ.</CardNote>
      </SettingsCard>
    </div>
  )
}

function TriStateSelect({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string
  value: 'inherit' | 'on' | 'off'
  disabled: boolean
  onChange: (value: string) => void
}) {
  return (
    <Select value={value} disabled={disabled} onValueChange={onChange}>
      <SelectTrigger size="sm" aria-label={label} data-value={value} className="w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper">
        <SelectItem value="inherit">Inherit environment</SelectItem>
        <SelectItem value="on">On</SelectItem>
        <SelectItem value="off">Off</SelectItem>
      </SelectContent>
    </Select>
  )
}
