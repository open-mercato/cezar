import { ListChecksIcon } from 'lucide-react'

import { useConfig, useRepo } from '@/api/queries'
import type { ConfigResponse } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { LoadingState, SettingsSkeleton } from '@/components/loading-state'
import { FormRow, SettingsCard } from './form-row'
import { TrunkBasedFields } from './trunk-based-fields'
import { useConfigSave } from './use-config-save'

/** Radix Select refuses an empty item value; this stands in for "follow the checked-out branch". */
const FOLLOW_CHECKOUT = '__follow__'

/**
 * Settings → Tasks: how a task of THIS repo behaves — which branch it forks from, whether it
 * parks for review, whether its title refreshes while it runs. Split out of Agents because none
 * of these is about an agent; they are lifecycle and git behavior, and "where do branch settings
 * live" needs one answer. Every control saves on change and says "Saved" inline (form-row.tsx).
 */
export function TasksSection() {
  const config = useConfig()

  if (config.isPending) {
    return (
      <LoadingState label="Loading task settings…" data-slot="tasks-loading"><SettingsSkeleton /></LoadingState>
    )
  }
  if (config.isError) {
    return (
      <CenteredState
        icon={<ListChecksIcon />}
        tone="danger"
        title="Task settings did not load"
        subtitle={config.error.message}
        heading="h2"
      />
    )
  }
  return <TasksForm config={config.data} />
}

function TasksForm({ config }: { config: ConfigResponse }) {
  const repo = useRepo()
  const save = useConfigSave()

  return (
    <div data-slot="tasks-section" className="flex w-full flex-col gap-5">
      <TrunkBasedFields config={config}>
        <FormRow
          saved={save.savedFor('baseBranch')}
          label="Base branch"
          description="New task worktrees branch from this and draft PRs target it. Also settable from the Git view."
        >
          {repo.data?.info ? (
            <Select
              value={config.baseBranch ?? FOLLOW_CHECKOUT}
              disabled={save.isPending}
              onValueChange={(value) => save.mutate({ baseBranch: value === FOLLOW_CHECKOUT ? null : value })}
            >
              <SelectTrigger
                size="sm"
                aria-label="Base branch"
                data-slot="tasks-base-branch"
                data-value={config.baseBranch ?? ''}
                className="w-56 font-mono text-ui"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectItem value={FOLLOW_CHECKOUT} className="font-sans">Follow the checked-out branch</SelectItem>
                {repo.data.branches.map((name) => (
                  <SelectItem key={name} value={name} className="font-mono text-ui">
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <p data-slot="tasks-base-branch-unavailable" className="text-ui text-muted-foreground">
              {repo.isPending ? 'Loading branches…' : 'Not a git repository — tasks run in place, no branching.'}
            </p>
          )}
        </FormRow>
      </TrunkBasedFields>

      <SettingsCard id="review" title="Review and titles">
        <FormRow
          saved={save.savedFor('reviewGate')}
          htmlFor="tasks-review-gate"
          label="Review changes before finishing"
          description={`When on, a task with changes pauses so you can Accept, Send back, or open a Draft PR. Autonomous tasks always skip this and finish on their own.${config.reviewGate === null ? ' Default: off — tasks finish without asking.' : ''}`}
        >
          <Switch
            id="tasks-review-gate"
            aria-label="Review changes before finishing"
            data-slot="tasks-review-gate"
            checked={config.reviewGate ?? false}
            disabled={save.isPending}
            onCheckedChange={(checked) => save.mutate({ reviewGate: checked })}
          />
        </FormRow>

        <FormRow
          saved={save.savedFor('liveTitleUpdates')}
          htmlFor="tasks-live-title-updates"
          label="Live title updates"
          description={`Rename a task once through the namer model after its first turn, then keep that title. A manual rename always wins.${config.liveTitleUpdates === null ? ' Default: on.' : ''}`}
        >
          <Switch
            id="tasks-live-title-updates"
            aria-label="Live title updates"
            data-slot="tasks-live-title-updates"
            checked={config.liveTitleUpdates ?? true}
            disabled={save.isPending}
            onCheckedChange={(checked) => save.mutate({ liveTitleUpdates: checked })}
          />
        </FormRow>
      </SettingsCard>
    </div>
  )
}
