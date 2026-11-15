import { useMutation, useQueryClient } from '@tanstack/react-query'
import { FolderGit2Icon } from 'lucide-react'

import { putConfig } from '@/api/client'
import { queryKeys, useConfig } from '@/api/queries'
import type { ConfigResponse, SetConfigInput } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { IntegerStepper } from '@/components/integer-stepper'
import { toast } from '@/components/ui/toaster'
import { LoadingState, SettingsSkeleton } from '@/components/loading-state'
import { FormRow, SettingsCard, useSavedFlash } from './form-row'
import { WorktreesPanel } from './worktrees-panel'
import { WorktreeLifecycleEditor } from './worktree-lifecycle-editor'

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
      <LoadingState label="Loading worktree settings…" data-slot="worktrees-loading"><SettingsSkeleton /></LoadingState>
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
  const [saved, flash] = useSavedFlash()

  const save = useMutation({
    mutationFn: (patch: SetConfigInput) => putConfig(patch),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.config, result)
      // Keep the worktrees panel's keep-limit footer in step with the new value.
      void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees })
      flash()
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  // 0 = unlimited: a meaningful value, always sent as a number so it is never mistaken for
  // "clear back to the default" (#483).
  const retention = config.worktreeRetention

  return (
    <div data-slot="worktrees-section" className="flex w-full flex-col gap-5">
      <SettingsCard id="retention" title="Retention">
        <FormRow
          saved={saved}
          label="Keep last N worktrees"
          description={`Older finished worktrees are reclaimed to free disk; their branch is kept so the work stays recoverable. 0 = unlimited. In-review and running tasks are never reclaimed, so the count on disk can exceed this. ${retention === 0 ? 'Keeping every finished worktree.' : `Keeping the last ${retention} finished worktree${retention === 1 ? '' : 's'} on disk.`}`}
        >
          <IntegerStepper
            aria-label="Keep last N finished worktrees"
            data-slot="resources-worktree-retention"
            value={retention}
            min={WORKTREE_RETENTION_MIN}
            max={WORKTREE_RETENTION_MAX}
            disabled={save.isPending}
            onCommit={(next) => save.mutateAsync({ worktreeRetention: next ?? WORKTREE_RETENTION_MIN })}
          />
        </FormRow>
      </SettingsCard>

      <WorktreeLifecycleEditor config={config} />

      <SettingsCard
        id="on-disk"
        title="Worktrees on disk"
        description="Task worktrees currently on disk. Delete one to reclaim its space now, or reclaim everything past the keep-limit at once. Reclamation keeps branches; deleting a worktree also deletes its managed branch."
      >
        <div className="px-4 py-3">
          <WorktreesPanel />
        </div>
      </SettingsCard>
    </div>
  )
}
