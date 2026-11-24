import { useMutation, useQueryClient } from '@tanstack/react-query'
import { FolderGit2Icon } from 'lucide-react'
import { useState } from 'react'

import { putConfig } from '@/api/client'
import { queryKeys, useConfig } from '@/api/queries'
import type { ConfigResponse, SetConfigInput } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { IntegerStepper } from '@/components/integer-stepper'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from '@/components/ui/toaster'
import { LoadingState, SettingsSkeleton } from '@/components/loading-state'
import { FormRow, SettingsCard, useSavedFlash } from './form-row'
import { WorktreesPanel } from './worktrees-panel'
import { WorktreeLifecycleEditor } from './worktree-lifecycle-editor'

/**
 * Project settings → Worktrees: the retention count (#483), age retention and archived-task
 * lifetime (spec 2026-11-19-worktree-disk-usage) and the disk panel — what used to be the bottom half of
 * Settings → Resources.
 *
 * It stayed PROJECT-scoped when step 3.5 split Settings (spec §"Resource governance"): retention
 * sizes one repo's own worktree pool, so it describes the repo, not the machine. It still
 * persists through the project-scoped `PUT /api/config`; the workspace's
 * `resources.worktreeRetentionDefault` only seeds projects that never set their own.
 */

/** Worktree retention count bounds (#483) — 0 = unlimited, matching the config schema. */
const WORKTREE_RETENTION_MIN = 0
const WORKTREE_RETENTION_MAX = 1000
/** Age retention bounds in days — 0 = off, matching the config schema. */
const WORKTREE_IDLE_DAYS_MAX = 365
/** Archived-task lifetime bounds in days — 0 = never, matching the config schema. */
const ARCHIVED_DELETE_DAYS_MAX = 3650

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
  const [savedKey, setSavedKey] = useState<keyof SetConfigInput | null>(null)

  const save = useMutation({
    mutationFn: (patch: SetConfigInput) => putConfig(patch),
    onSuccess: (result, patch) => {
      queryClient.setQueryData(queryKeys.config, result)
      setSavedKey((Object.keys(patch)[0] as keyof SetConfigInput | undefined) ?? null)
      // Keep the worktrees panel's keep-limit footer in step with the new value.
      void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees })
      flash()
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  // 0 = unlimited: a meaningful value, always sent as a number so it is never mistaken for
  // "clear back to the default" (#483).
  const retention = config.worktreeRetention
  // `worktreeIdleDays` is the EFFECTIVE value; `worktreeIdleDaysOwn` says whether the repo set it
  // or inherits the workspace default (Settings → Resources). Older servers send neither.
  const idleDays = config.worktreeIdleDays ?? 0
  const idleOwn = config.worktreeIdleDaysOwn ?? false
  const idleMode: 'inherit' | 'own' = idleOwn ? 'own' : 'inherit'
  const daysText = (days: number) => (days === 0 ? 'off' : `${days} day${days === 1 ? '' : 's'}`)
  // Same effective/own pair for the archived-task lifetime; 0 = never.
  const deleteDays = config.archivedTaskDeleteDays ?? 0
  const deleteOwn = config.archivedTaskDeleteDaysOwn ?? false
  const deleteMode: 'inherit' | 'own' = deleteOwn ? 'own' : 'inherit'
  const deleteText = deleteDays === 0 ? 'never' : `after ${deleteDays} day${deleteDays === 1 ? '' : 's'}`

  return (
    <div data-slot="worktrees-section" className="flex w-full flex-col gap-5">
      <SettingsCard id="retention" title="Retention">
        <FormRow
          saved={saved && savedKey === 'worktreeRetention'}
          label="Keep last N worktrees"
          description={`Older finished worktrees are reclaimed to free disk; their branch is kept so the work stays recoverable. 0 = unlimited. This count covers done, failed and cancelled tasks; trees in review or waiting go by the idle age below, and running tasks are never reclaimed. ${retention === 0 ? 'Keeping every finished worktree.' : `Keeping the last ${retention} finished worktree${retention === 1 ? '' : 's'} on disk.`}`}
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

        <FormRow
          saved={saved && savedKey === 'worktreeIdleDays'}
          label="Reclaim idle worktrees after"
          description={`A task that is not running — in review, waiting or finished — gives back its worktree after this many days without activity. The branch is kept and Continue restores the tree; pinned tasks and trees with uncommitted changes are kept. 0 = off. ${idleOwn ? `This project: ${daysText(idleDays)}.` : `Inherited from Settings → Behaviour: ${daysText(idleDays)}.`}`}
        >
          <Select
            value={idleMode}
            disabled={save.isPending}
            onValueChange={(value) => void save.mutateAsync({ worktreeIdleDays: value === 'inherit' ? null : idleDays })}
          >
            <SelectTrigger size="sm" aria-label="Idle worktree age source" data-slot="worktrees-idle-days-mode" data-value={idleMode} className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value="inherit">Workspace default</SelectItem>
              <SelectItem value="own">This project</SelectItem>
            </SelectContent>
          </Select>
          {idleMode === 'own' ? (
            <>
              <IntegerStepper
                aria-label="Reclaim idle worktrees after days"
                data-slot="worktrees-idle-days"
                value={idleDays}
                min={0}
                max={WORKTREE_IDLE_DAYS_MAX}
                className="w-24"
                disabled={save.isPending}
                onCommit={(days) => save.mutateAsync({ worktreeIdleDays: days ?? 0 })}
              />
              <span className="text-label text-muted-foreground">days</span>
            </>
          ) : null}
        </FormRow>

        <FormRow
          saved={saved && savedKey === 'archivedTaskDeleteDays'}
          label="Delete archived tasks after"
          description={`An archived task is deleted this many days after it was archived: its record, log, worktree and branch. The branch is kept when it has an open pull request or commits that are neither merged nor pushed. Pinned tasks and trees with uncommitted changes are kept. 0 = never. ${deleteOwn ? `This project: ${deleteText}.` : `Inherited from Settings → Behaviour: ${deleteText}.`}`}
        >
          <Select
            value={deleteMode}
            disabled={save.isPending}
            onValueChange={(value) => void save.mutateAsync({ archivedTaskDeleteDays: value === 'inherit' ? null : deleteDays })}
          >
            <SelectTrigger size="sm" aria-label="Archived task lifetime source" data-slot="worktrees-archived-delete-days-mode" data-value={deleteMode} className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value="inherit">Workspace default</SelectItem>
              <SelectItem value="own">This project</SelectItem>
            </SelectContent>
          </Select>
          {deleteMode === 'own' ? (
            <>
              <IntegerStepper
                aria-label="Delete archived tasks after days"
                data-slot="worktrees-archived-delete-days"
                value={deleteDays}
                min={0}
                max={ARCHIVED_DELETE_DAYS_MAX}
                className="w-24"
                disabled={save.isPending}
                onCommit={(days) => save.mutateAsync({ archivedTaskDeleteDays: days ?? 0 })}
              />
              <span className="text-label text-muted-foreground">days</span>
            </>
          ) : null}
        </FormRow>
      </SettingsCard>

      <WorktreeLifecycleEditor config={config} />

      <SettingsCard
        id="on-disk"
        title="Worktrees on disk"
        description="Task worktrees currently on disk. Delete one to reclaim its space now, or reclaim everything past the keep-limit and idle age at once. Reclamation keeps branches; deleting a worktree also deletes its managed branch."
      >
        <div className="px-4 py-3">
          <WorktreesPanel />
        </div>
      </SettingsCard>
    </div>
  )
}
