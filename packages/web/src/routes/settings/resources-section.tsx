import { useMutation, useQueryClient } from '@tanstack/react-query'
import { GaugeIcon } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'

import { putWorkspaceConfig } from '@/api/client'
import { useWorkspaceConfig, workspaceQueryKeys } from '@/api/queries'
import type { SetWorkspaceConfigInput, WorkspaceConfigResponse } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { SettingsField } from './settings-field'

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
const WAKE_INTERVAL_MIN = 1
const WAKE_INTERVAL_MAX = 60
/** Below this a limit would pause almost any real agent immediately — reject it as a footgun. */
const MEMORY_MIN_MB = 256

export function ResourcesSection() {
  const config = useWorkspaceConfig()

  if (config.isPending) {
    return (
      <p data-slot="resources-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
        Loading resource settings…
      </p>
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

  return (
    <div
      data-slot="resources-section"
      className="mx-auto flex w-full max-w-2xl flex-col gap-7 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
    >
      <SettingsField
        title="Max parallel tasks"
        hint="How many tasks run at once across every project. The rest wait in the queue. A non-git directory always runs one at a time."
      >
        <select
          aria-label="Max parallel tasks"
          data-slot="resources-max-parallel"
          value={config.resources.maxParallel}
          disabled={save.isPending}
          onChange={(event) => save.mutate({ resources: { maxParallel: Number(event.target.value) } })}
          className="block w-28 rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
        >
          {Array.from({ length: MAX_PARALLEL_MAX - MAX_PARALLEL_MIN + 1 }, (_, i) => i + MAX_PARALLEL_MIN).map(
            (n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ),
          )}
        </select>
        <p className="text-[11px] text-soft-foreground">
          Need a different limit for one project?{' '}
          <Link
            to="/settings/global/projects"
            data-slot="resources-project-limits-link"
            className="font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
          >
            Configure per-project limits
          </Link>
          .
        </p>
      </SettingsField>

      <SettingsField
        title="Extra monitoring sessions"
        hint="How many agent sessions may wait on CI, sub-agents, or monitored commands without using an active task slot. Extra sessions stay alive but pause the queue."
      >
        <select
          aria-label="Extra monitoring sessions"
          data-slot="resources-max-monitoring"
          value={config.resources.maxMonitoringSessions ?? 2}
          disabled={save.isPending}
          onChange={(event) => save.mutate({ resources: { maxMonitoringSessions: Number(event.target.value) } })}
          className="block w-28 rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
        >
          {Array.from({ length: MAX_MONITORING_MAX + 1 }, (_, n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
        <p className="text-[11px] text-soft-foreground">
          Capacity: {config.resources.maxParallel} active + {config.resources.maxMonitoringSessions ?? 2} monitoring. Set 0 to make monitoring share active slots.
        </p>
      </SettingsField>

      <SettingsField
        title="Monitoring wake-up"
        hint="Park uses no model turns. Re-check sends the same agent a follow-up on this cadence until work completes or the 40-wakeup safety cap is reached."
      >
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Monitoring wake-up"
            data-slot="resources-monitoring-wake-mode"
            value={wakeMode}
            disabled={save.isPending}
            onChange={(event) => setWakeMode(event.target.value as 'park' | 'interval')}
            className="rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
          >
            <option value="park">Park until resumed</option>
            <option value="interval">Re-check on an interval</option>
          </select>
          {wakeMode === 'interval' ? (
            <>
              <input
                type="number"
                min={WAKE_INTERVAL_MIN}
                max={WAKE_INTERVAL_MAX}
                aria-label="Wake interval in minutes"
                data-slot="resources-monitoring-wake-interval"
                value={wakeInterval}
                disabled={save.isPending}
                onChange={(event) => setWakeInterval(event.target.value)}
                className="block w-24 rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
              />
              <span className="text-xs text-soft-foreground">minutes</span>
            </>
          ) : null}
          <Button type="button" variant="outline" size="sm" data-action="resources-save-monitoring-wake" disabled={wakeSaved || (wakeMode === 'interval' && wakeInvalid) || save.isPending} onClick={saveWake}>Save</Button>
        </div>
        {wakeMode === 'interval' && wakeInvalid ? (
          <p data-slot="resources-monitoring-wake-invalid" className="text-[11px] text-danger">Enter a whole number from 1 to 60 minutes.</p>
        ) : (
          <p className="text-[11px] text-soft-foreground">Applied consistently to Claude, Codex and OpenCode.</p>
        )}
      </SettingsField>

      <SettingsField
        title="Auto-resume after a usage limit"
        hint="When an agent stops because its provider usage limit is reached, cezar waits for the reset the provider named and continues the task 30 seconds later — up to 12 times in a row without you. Off leaves the task failed with its Continue button."
      >
        <select
          aria-label="Auto-resume after a usage limit"
          data-slot="resources-auto-resume"
          value={autoResume ? 'on' : 'off'}
          disabled={save.isPending}
          onChange={(event) => saveAutoResume(event.target.value === 'on')}
          className="block w-28 rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
        >
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
        <p className="text-[11px] text-soft-foreground">
          Applies to Claude, Codex and OpenCode — whenever the provider says when the limit lifts.
        </p>
      </SettingsField>

      <SettingsField
        title="Per-task memory limit"
        hint="When a task's whole process tree crosses this, the engine pauses it with a warning and starts the next queued task. Leave empty for no limit."
      >
        <div className="flex items-center gap-2">
          <input
            type="number"
            inputMode="numeric"
            min={MEMORY_MIN_MB}
            step={256}
            aria-label="Per-task memory limit in MiB"
            data-slot="resources-memory-limit"
            value={memory}
            disabled={save.isPending}
            placeholder="no limit"
            onChange={(event) => setMemory(event.target.value)}
            className="block w-32 rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
          />
          <span className="text-xs text-soft-foreground">MiB</span>
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
          <p data-slot="resources-memory-invalid" className="text-[11px] text-danger">
            Enter a whole number of at least {MEMORY_MIN_MB} MiB, or leave empty for no limit.
          </p>
        ) : (
          <p className="text-[11px] text-soft-foreground">Applies to newly started tasks.</p>
        )}
      </SettingsField>

      <SettingsField
        title="New task defaults"
        hint="Set stable composer defaults across projects. Explicit choices and run-shape constraints still win."
      >
        <div className="grid gap-4 sm:grid-cols-2" data-slot="resources-composer-defaults">
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Autonomous by default</span>
            <select
              aria-label="Autonomous by default"
              value={composerDefaults.autonomous === null ? 'inherit' : composerDefaults.autonomous ? 'on' : 'off'}
              disabled={save.isPending}
              onChange={(event) => saveComposerDefault('autonomous', event.target.value)}
              className="rounded-md border border-input bg-card px-3 py-1.5 shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <option value="inherit">Inherit environment</option>
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
            <span className="text-[11px] text-soft-foreground">
              Inherited: {composerDefaults.inheritedAutonomous === 'source-dependent'
                ? 'Source-dependent — skills on, workflows off'
                : composerDefaults.inheritedAutonomous ? 'On' : 'Off'}
            </span>
          </label>
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Use a worktree by default</span>
            <select
              aria-label="Use a worktree by default"
              value={composerDefaults.worktree === null ? 'inherit' : composerDefaults.worktree ? 'on' : 'off'}
              disabled={save.isPending}
              onChange={(event) => saveComposerDefault('worktree', event.target.value)}
              className="rounded-md border border-input bg-card px-3 py-1.5 shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <option value="inherit">Inherit environment</option>
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
            <span className="text-[11px] text-soft-foreground">
              Inherited: {composerDefaults.inheritedWorktree ? 'On' : 'Off'}
            </span>
          </label>
        </div>
        <p className="text-[11px] text-soft-foreground">
          Interactive skills may recommend both off. Multi-step and parallel runs remain isolated.
        </p>
      </SettingsField>
    </div>
  )
}
