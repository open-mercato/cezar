import { useMutation, useQueryClient } from '@tanstack/react-query'
import { FolderGit2Icon } from 'lucide-react'
import { useState } from 'react'

import { putConfig } from '@/api/client'
import { queryKeys, useConfig } from '@/api/queries'
import type { ConfigResponse, SetConfigInput } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { SettingsField } from './settings-field'
import { WorktreesPanel } from './worktrees-panel'

/**
 * Project settings → Worktrees: the retention count (#483) and the disk panel — what used to be
 * the bottom half of Settings → Resources.
 *
 * It stayed PROJECT-scoped when step 3.5 split Settings (spec §"Resource governance"): retention
 * sizes one repo's own worktree pool, so it describes the repo, not the machine. It still
 * persists through the project-scoped `PUT /api/config`; the workspace's
 * `resources.worktreeRetentionDefault` only seeds projects that never set their own.
 */

/** Worktree retention count bounds (#483) — 0 = unlimited, matching the config schema. */
const WORKTREE_RETENTION_MIN = 0
const WORKTREE_RETENTION_MAX = 1000

export function WorktreesSection() {
  const config = useConfig()

  if (config.isPending) {
    return (
      <p data-slot="worktrees-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
        Loading worktree settings…
      </p>
    )
  }
  if (config.isError) {
    return (
      <CenteredState
        icon={<FolderGit2Icon />}
        tone="danger"
        title="Worktree settings did not load"
        subtitle={config.error.message}
        heading="h2"
      />
    )
  }
  return <WorktreesForm config={config.data} />
}

function WorktreesForm({ config }: { config: ConfigResponse }) {
  const queryClient = useQueryClient()

  const save = useMutation({
    mutationFn: (patch: SetConfigInput) => putConfig(patch),
    onSuccess: (result) => queryClient.setQueryData(queryKeys.config, result),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  // Retention edits locally and saves explicitly (#483). 0 = unlimited (a meaningful value,
  // always sent as a number so it is never mistaken for "clear back to the default").
  const [retention, setRetention] = useState(String(config.worktreeRetention))
  const retentionNum = Number(retention)
  const retentionInvalid =
    retention.trim() === '' ||
    !Number.isInteger(retentionNum) ||
    retentionNum < WORKTREE_RETENTION_MIN ||
    retentionNum > WORKTREE_RETENTION_MAX
  const retentionSaved = config.worktreeRetention === (retentionInvalid ? -1 : retentionNum)
  const saveRetention = () =>
    save.mutate(
      { worktreeRetention: retentionNum },
      {
        onSuccess: () => {
          // Keep the worktrees panel's keep-limit footer in step with the new value.
          void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees })
          toast(
            retentionNum === 0
              ? 'Keeping all worktrees (unlimited)'
              : `Keeping the last ${retentionNum} finished worktree${retentionNum === 1 ? '' : 's'}`,
          )
        },
      },
    )

  return (
    <div
      data-slot="worktrees-section"
      className="mx-auto flex w-full max-w-2xl flex-col gap-7 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
    >
      <SettingsField
        title="Keep last N worktrees"
        hint="Older finished worktrees are reclaimed to free disk; their branch is kept so the work stays recoverable. 0 = unlimited. In-review and running tasks are never reclaimed, so the count on disk can exceed this."
      >
        <div className="flex items-center gap-2">
          <input
            type="number"
            inputMode="numeric"
            min={WORKTREE_RETENTION_MIN}
            max={WORKTREE_RETENTION_MAX}
            step={1}
            aria-label="Keep last N finished worktrees"
            data-slot="resources-worktree-retention"
            value={retention}
            disabled={save.isPending}
            onChange={(event) => setRetention(event.target.value)}
            className="block w-32 rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
          />
          <span className="text-xs text-soft-foreground">worktrees</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-action="resources-save-retention"
            disabled={retentionSaved || retentionInvalid || save.isPending}
            onClick={saveRetention}
          >
            Save
          </Button>
        </div>
        {retentionInvalid ? (
          <p data-slot="resources-retention-invalid" className="text-[11px] text-danger">
            Enter a whole number from {WORKTREE_RETENTION_MIN} to {WORKTREE_RETENTION_MAX} (0 = unlimited).
          </p>
        ) : (
          <p className="text-[11px] text-soft-foreground">
            {retentionNum === 0 ? 'Keeping every finished worktree.' : `Keeping the last ${retentionNum} finished worktree${retentionNum === 1 ? '' : 's'} on disk.`}
          </p>
        )}
      </SettingsField>

      <SettingsField
        title="Worktrees"
        hint="Task worktrees currently on disk. Delete one to reclaim its space now, or reclaim everything past the keep-limit at once. Branches are always kept, so the work stays recoverable."
      >
        <WorktreesPanel />
      </SettingsField>
    </div>
  )
}
