import { ListChecksIcon } from 'lucide-react'

import { useConfig, useRepo } from '@/api/queries'
import type { ConfigResponse } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import { SettingsField } from './settings-field'
import { useConfigSave } from './use-config-save'

/**
 * Settings → Tasks: how a task of THIS repo behaves — which branch it forks from, whether it
 * parks for review, whether its title refreshes while it runs. Split out of Agents because none
 * of these is about an agent; they are lifecycle and git behavior, and "where do branch settings
 * live" needs one answer.
 */
export function TasksSection() {
  const config = useConfig()

  if (config.isPending) {
    return (
      <p data-slot="tasks-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
        Loading task settings…
      </p>
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
    <div
      data-slot="tasks-section"
      className="mx-auto flex w-full max-w-2xl flex-col gap-7 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
    >
      <SettingsField
        title="Base branch"
        hint="New task worktrees branch from this and draft PRs target it. Also settable from the Git view."
      >
        {repo.data?.info ? (
          <select
            aria-label="Base branch"
            data-slot="tasks-base-branch"
            value={config.baseBranch ?? ''}
            disabled={save.isPending}
            onChange={(event) => save.mutate({ baseBranch: event.target.value || null })}
            className="block w-full max-w-md rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
          >
            <option value="">follow checked-out branch (default)</option>
            {repo.data.branches.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        ) : (
          <p data-slot="tasks-base-branch-unavailable" className="text-[13px] text-soft-foreground">
            {repo.isPending ? 'Loading branches…' : 'Not a git repository — tasks run in place, no branching.'}
          </p>
        )}
      </SettingsField>

      <SettingsField
        title="Review changes before finishing"
        hint="When on, a task with changes pauses so you can Accept, Send back, or open a Draft PR. Autonomous tasks always skip this and finish on their own. Default: off — tasks finish without asking."
      >
        <label className="flex w-fit items-center gap-3">
          <Switch
            aria-label="Review changes before finishing"
            data-slot="tasks-review-gate"
            checked={config.reviewGate ?? false}
            disabled={save.isPending}
            onCheckedChange={(checked) =>
              save.mutate(
                { reviewGate: checked },
                { onSuccess: () => toast(checked ? 'Review gate on' : 'Review gate off') },
              )
            }
          />
          <span className="text-[13px] text-muted-foreground">
            {(config.reviewGate ?? false) ? 'On' : 'Off'}
            {config.reviewGate === null && ' (default)'}
          </span>
        </label>
      </SettingsField>

      <SettingsField
        title="Live title updates"
        hint="Refresh a task's short title through the namer model as the run progresses. A manual rename always wins and stops updates for that task."
      >
        <label className="flex w-fit items-center gap-3">
          <Switch
            aria-label="Live title updates"
            data-slot="tasks-live-title-updates"
            checked={config.liveTitleUpdates ?? true}
            disabled={save.isPending}
            onCheckedChange={(checked) =>
              save.mutate(
                { liveTitleUpdates: checked },
                { onSuccess: () => toast(checked ? 'Live title updates on' : 'Live title updates off') },
              )
            }
          />
          <span className="text-[13px] text-muted-foreground">
            {(config.liveTitleUpdates ?? true) ? 'On' : 'Off'}
            {config.liveTitleUpdates === null && ' (default)'}
          </span>
        </label>
      </SettingsField>
    </div>
  )
}
