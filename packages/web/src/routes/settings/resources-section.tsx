import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { putWorkspaceConfig } from '@/api/client'
import { useWorkspaceConfig, workspaceQueryKeys } from '@/api/queries'
import type { SetWorkspaceConfigInput, WorkspaceConfigResponse } from '@open-mercato/cezar-api-client'
import { useGlobalSettings } from '@/components/global-settings'
import { IntegerStepper } from '@/components/integer-stepper'
import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import { MachineCard } from './machine-card'
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
 * Global settings → Resources: how hard the MACHINE works. `maxParallel` caps concurrent tasks
 * across every project (the workspace semaphore holds the rest); `memoryLimitMb` is the
 * per-task ceiling the engine enforces by pausing a task that crosses it and letting the queue
 * advance (#memory-guard).
 *
 * Both are workspace-level since the multi-project split (spec §"Resource governance"): they
 * protect the host, not a repo, so they live in `~/.cezar/config.json` and persist through
 * `PUT /api/workspace/config` — the merged answer lands straight in the workspace config query,
 * and the server refreshes the shared semaphore so a change takes effect without a restart.
 * Leftover per-repo `maxParallel`/`memoryLimitMb` keys were imported once by Migration 001 and
 * are ignored afterwards; this section deliberately no longer writes them.
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

export function ResourcesSection() {
  const config = useWorkspaceConfig()

  if (config.isPending) {
    return <SettingsLoading data-slot="resources-loading" label="Loading resource settings…" />
  }
  if (config.isError) {
    return <SettingsError title="Resource settings did not load">{config.error.message}</SettingsError>
  }
  return <ResourcesForm config={config.data} />
}

function ResourcesForm({ config }: { config: WorkspaceConfigResponse }) {
  const queryClient = useQueryClient()
  const globalSettings = useGlobalSettings()

  const save = useMutation({
    mutationFn: (patch: SetWorkspaceConfigInput) => putWorkspaceConfig(patch),
    onSuccess: (result) => queryClient.setQueryData(workspaceQueryKeys.config, result),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  // Memory edits locally and saves explicitly — an empty field means "no limit".
  const [memory, setMemory] = useState(
    config.resources.memoryLimitMb ? String(config.resources.memoryLimitMb) : '',
  )
  const configuredWake = config.resources.monitoringWakeIntervalMinutes ?? null
  const [wakeMode, setWakeMode] = useState<'park' | 'interval'>(configuredWake === null ? 'park' : 'interval')
  const [wakeInterval, setWakeInterval] = useState(String(configuredWake ?? 5))
  const wakeNum = Number(wakeInterval)
  const wakeInvalid = !Number.isInteger(wakeNum) || wakeNum < WAKE_INTERVAL_MIN || wakeNum > WAKE_INTERVAL_MAX
  const wakeSaved = wakeMode === 'park'
    ? configuredWake === null
    : !wakeInvalid && configuredWake === wakeNum
  const saveWake = () => save.mutate(
    { resources: { monitoringWakeIntervalMinutes: wakeMode === 'park' ? null : wakeNum } },
    { onSuccess: () => toast(wakeMode === 'park' ? 'Monitoring will stay parked' : `Monitoring will re-check every ${wakeNum} minutes`) },
  )
  // Shipped ON: a server that predates the key answers without it, and reading that as "off"
  // would silently disable the feature on the one client that cannot tell the difference.
  const autoResume = config.resources.autoResumeOnUsageLimit ?? true
  const saveAutoResume = (on: boolean) => save.mutate(
    { resources: { autoResumeOnUsageLimit: on } },
    {
      onSuccess: () => toast(
        on
          ? 'Tasks stopped by a usage limit will resume themselves'
          : 'Tasks stopped by a usage limit will stay failed',
      ),
    },
  )
  const memoryNum = memory.trim() === '' ? 0 : Number(memory)
  const memoryInvalid =
    memory.trim() !== '' && (!Number.isInteger(memoryNum) || memoryNum < MEMORY_MIN_MB)
  const memorySaved = (config.resources.memoryLimitMb ?? 0) === (memoryInvalid ? -1 : memoryNum)
  const saveMemory = () =>
    save.mutate(
      // 0, not null: the workspace schema's "no limit" IS 0 (`memoryLimitMb: null` is also
      // accepted, but the route's nullable field means "clear", and clearing to the default
      // would be a different value than the user asked for).
      { resources: { memoryLimitMb: memoryNum === 0 ? null : memoryNum } },
      {
        onSuccess: () =>
          toast(memoryNum === 0 ? 'Memory limit cleared' : `Memory limit set to ${memoryNum} MiB`),
      },
    )
  const composerDefaults = config.composerDefaults ?? {
    autonomous: null,
    worktree: null,
    inheritedAutonomous: 'source-dependent' as const,
    inheritedWorktree: true,
  }
  const saveComposerDefault = (
    key: 'autonomous' | 'worktree',
    value: string,
  ) => save.mutate({
    composerDefaults: { [key]: value === 'inherit' ? null : value === 'on' },
  })

  const onOffInherit = [
    { value: 'inherit', label: 'Inherit environment' },
    { value: 'on', label: 'On' },
    { value: 'off', label: 'Off' },
  ] as const

  return (
    <SettingsPane data-slot="resources-section">
      {/* Live host totals first: they answer "how is the machine" before the knobs below answer
          "how hard may cezar push it" (spec 2026-09-20-host-resource-telemetry, §UI/UX). The
          card owns its own subscription, so this screen is what keeps the sampler alive. */}
      <MachineCard />

      <SettingsGroup title="Concurrency" description="How much runs at once, across every project.">
        <SettingsField
          title="Max parallel tasks"
          hint="How many tasks run at once across every project. The rest wait in the queue. A non-git directory always runs one at a time."
          control={
            <IntegerStepper
              aria-label="Max parallel tasks"
              data-slot="resources-max-parallel"
              value={config.resources.maxParallel}
              min={MAX_PARALLEL_MIN}
              max={MAX_PARALLEL_MAX}
              onCommit={(maxParallel) => save.mutateAsync({ resources: { maxParallel: maxParallel ?? MAX_PARALLEL_MIN } })}
            />
          }
        >
          <SettingsNote>
            Need a different limit for one project?{' '}
            <Button
              type="button"
              variant="link"
              data-slot="resources-project-limits-link"
              onClick={() => globalSettings.open('projects')}
              className="inline h-auto p-0 text-[length:inherit] whitespace-normal font-medium underline decoration-border hover:decoration-foreground"
            >
              Configure per-project limits
            </Button>
            .
          </SettingsNote>
        </SettingsField>

        <SettingsField
          title="Extra monitoring sessions"
          hint="How many agent sessions may wait on CI, sub-agents, or monitored commands without using an active task slot. Extra sessions stay alive but pause the queue."
          control={
            <IntegerStepper
              aria-label="Extra monitoring sessions"
              data-slot="resources-max-monitoring"
              value={config.resources.maxMonitoringSessions ?? 2}
              min={0}
              max={MAX_MONITORING_MAX}
              onCommit={(sessions) => save.mutateAsync({ resources: { maxMonitoringSessions: sessions ?? 0 } })}
            />
          }
        >
          <SettingsNote>
            Capacity: {config.resources.maxParallel} active + {config.resources.maxMonitoringSessions ?? 2} monitoring. Set 0 to make monitoring share active slots.
          </SettingsNote>
        </SettingsField>

        <SettingsField
          title="Per-task memory limit"
          hint="When a task's whole process tree crosses this, the engine pauses it with a warning and starts the next queued task. Leave empty for no limit."
        >
          <div className="flex flex-wrap items-center gap-2">
            <InputGroup className="w-40">
              <InputGroupInput
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
              />
              <InputGroupAddon align="inline-end">MiB</InputGroupAddon>
            </InputGroup>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-action="resources-save-memory"
              disabled={memorySaved || memoryInvalid || save.isPending}
              onClick={saveMemory}
            >
              Save
            </Button>
          </div>
          {memoryInvalid ? (
            <SettingsNote tone="danger" data-slot="resources-memory-invalid">
              Enter a whole number of at least {MEMORY_MIN_MB} MiB, or leave empty for no limit.
            </SettingsNote>
          ) : (
            <SettingsNote>Applies to newly started tasks.</SettingsNote>
          )}
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Waiting and monitoring" description="What happens to sessions that are not actively working.">
        <SettingsField
          title="Waiting-session idle timeout"
          hint="How long a plain waiting session may stay open without activity before its live backend session ends. Continue resumes it; set 0 to keep it open indefinitely."
          control={
            <IntegerStepper
              aria-label="Waiting-session idle timeout"
              data-slot="resources-idle-timeout"
              value={config.resources.idleTimeoutMinutes ?? 0}
              min={0}
              max={IDLE_TIMEOUT_MAX}
              onCommit={(minutes) => save.mutateAsync({ resources: { idleTimeoutMinutes: minutes ?? 0 } })}
            />
          }
        >
          <SettingsNote>
            Minutes; 0 keeps plain waiting sessions alive. Monitoring sessions are already exempt.
          </SettingsNote>
        </SettingsField>

        <SettingsField
          title="Monitoring wake-up"
          hint="Park uses no model turns. Re-check sends the same agent a follow-up on this cadence until work completes or the 40-wakeup safety cap is reached."
        >
          <div className="flex flex-wrap items-center gap-2">
            <SettingsSelect
              aria-label="Monitoring wake-up"
              data-slot="resources-monitoring-wake-mode"
              value={wakeMode}
              disabled={save.isPending}
              onChange={(value) => setWakeMode(value as 'park' | 'interval')}
              options={[
                { value: 'park', label: 'Park until resumed' },
                { value: 'interval', label: 'Re-check on an interval' },
              ]}
            />
            {wakeMode === 'interval' ? (
              <InputGroup className="w-36">
                <InputGroupInput
                  type="number"
                  min={WAKE_INTERVAL_MIN}
                  max={WAKE_INTERVAL_MAX}
                  aria-label="Wake interval in minutes"
                  aria-invalid={wakeInvalid || undefined}
                  data-slot="resources-monitoring-wake-interval"
                  value={wakeInterval}
                  disabled={save.isPending}
                  onChange={(event) => setWakeInterval(event.target.value)}
                />
                <InputGroupAddon align="inline-end">minutes</InputGroupAddon>
              </InputGroup>
            ) : null}
            <Button type="button" variant="outline" size="sm" data-action="resources-save-monitoring-wake" disabled={wakeSaved || (wakeMode === 'interval' && wakeInvalid) || save.isPending} onClick={saveWake}>Save</Button>
          </div>
          {wakeMode === 'interval' && wakeInvalid ? (
            <SettingsNote tone="danger" data-slot="resources-monitoring-wake-invalid">Enter a whole number from 1 to 60 minutes.</SettingsNote>
          ) : (
            <SettingsNote>Applied consistently to Claude, Codex and OpenCode.</SettingsNote>
          )}
        </SettingsField>

        <SettingsField
          title="Auto-resume after a usage limit"
          hint="When an agent stops because its provider usage limit is reached, cezar waits for the reset the provider named and continues the task 30 seconds later — up to 12 times in a row without you. Off leaves the task failed with its Continue button."
          control={
            <Switch
              aria-label="Auto-resume after a usage limit"
              data-slot="resources-auto-resume"
              checked={autoResume}
              disabled={save.isPending}
              onCheckedChange={saveAutoResume}
            />
          }
        >
          <SettingsNote>
            Applies to Claude, Codex and OpenCode — whenever the provider says when the limit lifts.
          </SettingsNote>
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup
        title="New task defaults"
        description="Set stable composer defaults across projects. Explicit choices and run-shape constraints still win."
        data-slot="resources-composer-defaults"
      >
        <SettingsField
          title="Autonomous by default"
          hint={`Inherited: ${
            composerDefaults.inheritedAutonomous === 'source-dependent'
              ? 'Source-dependent — skills on, workflows off'
              : composerDefaults.inheritedAutonomous ? 'On' : 'Off'
          }`}
          control={
            <SettingsSelect
              aria-label="Autonomous by default"
              value={composerDefaults.autonomous === null ? 'inherit' : composerDefaults.autonomous ? 'on' : 'off'}
              disabled={save.isPending}
              onChange={(value) => saveComposerDefault('autonomous', value)}
              options={onOffInherit}
              className="sm:w-48"
            />
          }
        />
        <SettingsField
          title="Use a worktree by default"
          hint={`Inherited: ${composerDefaults.inheritedWorktree ? 'On' : 'Off'}`}
          control={
            <SettingsSelect
              aria-label="Use a worktree by default"
              value={composerDefaults.worktree === null ? 'inherit' : composerDefaults.worktree ? 'on' : 'off'}
              disabled={save.isPending}
              onChange={(value) => saveComposerDefault('worktree', value)}
              options={onOffInherit}
              className="sm:w-48"
            />
          }
        >
          <SettingsNote>
            Interactive skills may recommend both off. Multi-step and parallel runs remain isolated.
          </SettingsNote>
        </SettingsField>
      </SettingsGroup>
    </SettingsPane>
  )
}
