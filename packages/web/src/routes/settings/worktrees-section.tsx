import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { putConfig } from '@/api/client'
import { queryKeys, useConfig } from '@/api/queries'
import type { ConfigResponse, SetConfigInput } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { toast } from '@/components/ui/toaster'
import {
  SettingsError,
  SettingsField,
  SettingsGroup,
  SettingsLoading,
  SettingsNote,
  SettingsPane,
} from './settings-field'
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
    return <SettingsLoading data-slot="worktrees-loading" label="Loading worktree settings…" />
  }
  if (config.isError) {
    return <SettingsError title="Worktree settings did not load">{config.error.message}</SettingsError>
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
    <SettingsPane data-slot="worktrees-section">
      <SettingsGroup title="Retention">
        <SettingsField
          title="Keep last N worktrees"
          hint="Older finished worktrees are reclaimed to free disk; their branch is kept so the work stays recoverable. 0 = unlimited. In-review and running tasks are never reclaimed, so the count on disk can exceed this."
        >
          <div className="flex flex-wrap items-center gap-2">
            <InputGroup className="w-44">
              <InputGroupInput
                type="number"
                inputMode="numeric"
                min={WORKTREE_RETENTION_MIN}
                max={WORKTREE_RETENTION_MAX}
                step={1}
                aria-label="Keep last N finished worktrees"
                aria-invalid={retentionInvalid || undefined}
                data-slot="resources-worktree-retention"
                value={retention}
                disabled={save.isPending}
                onChange={(event) => setRetention(event.target.value)}
              />
              <InputGroupAddon align="inline-end">worktrees</InputGroupAddon>
            </InputGroup>
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
            <SettingsNote tone="danger" data-slot="resources-retention-invalid">
              Enter a whole number from {WORKTREE_RETENTION_MIN} to {WORKTREE_RETENTION_MAX} (0 = unlimited).
            </SettingsNote>
          ) : (
            <SettingsNote>
              {retentionNum === 0 ? 'Keeping every finished worktree.' : `Keeping the last ${retentionNum} finished worktree${retentionNum === 1 ? '' : 's'} on disk.`}
            </SettingsNote>
          )}
        </SettingsField>
      </SettingsGroup>

      <WorktreesPanel />
    </SettingsPane>
  )
}
