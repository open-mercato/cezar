import { useMutation, useQueryClient } from '@tanstack/react-query'
import { GaugeIcon } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'

import { putWorkspaceConfig } from '@/api/client'
import { useWorkspaceConfig, workspaceQueryKeys } from '@/api/queries'
import type { SetWorkspaceConfigInput, WorkspaceConfigResponse } from '@/api/types'
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
    </div>
  )
}
