import { useEffect, useState } from 'react'

import { useSkills } from '@/api/queries'
import type { ConfigResponse, SetConfigInput } from '@open-mercato/cezar-api-client'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import { SettingsField } from './settings-field'
import { useConfigSave } from './use-config-save'

const selectClass =
  'block w-full max-w-md rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50'

/** The trunk-based preset (spec 2026-10-20-trunk-based-projects). Each key stays adjustable on
 *  its own below; switching back to branch-per-task clears every key the preset set. */
export const TRUNK_PRESET: SetConfigInput = {
  profile: 'trunk',
  taskWorkspace: 'in-place',
  landing: 'auto',
  reviewGate: false,
}
export const BRANCHES_PRESET: SetConfigInput = {
  profile: null,
  taskWorkspace: null,
  landing: null,
  defaultSkill: null,
  askSkill: null,
}

/**
 * Settings → Tasks, the trunk-based half: development model, where tasks work, how finished work
 * lands, the checks it must pass, and the skills a new task starts with. Every default here is
 * today's branch-per-task behavior.
 */
export function TrunkBasedFields({ config }: { config: ConfigResponse }) {
  const save = useConfigSave()
  const skills = useSkills()
  const skillNames = (skills.data ?? []).map((skill) => skill.name)
  const trunk = config.profile === 'trunk'
  const inPlace = config.taskWorkspace === 'in-place'

  return (
    <>
      <SettingsField
        title="Development model"
        hint="Trunk-based: tasks work directly in the checkout one at a time, and changes that pass the required checks land on the base branch without a PR. Read-only questions run beside them. Every setting below stays adjustable."
      >
        <select
          aria-label="Development model"
          data-slot="tasks-profile"
          value={trunk ? 'trunk' : 'branches'}
          disabled={save.isPending}
          onChange={(event) => {
            const toTrunk = event.target.value === 'trunk'
            save.mutate(toTrunk ? TRUNK_PRESET : BRANCHES_PRESET, {
              onSuccess: () => toast(toTrunk ? 'Trunk-based defaults applied' : 'Branch-per-task defaults restored'),
            })
          }}
          className={selectClass}
        >
          <option value="branches">Branch per task (default) — a worktree and branch per task, reviewed before merging</option>
          <option value="trunk">Trunk-based — work in the checkout, land checked changes on the base branch</option>
        </select>
      </SettingsField>

      <SettingsField
        title="Where tasks work"
        hint="In the checkout: no worktree or branch per task. Write tasks take turns on the working tree, so two tasks started together never conflict. The composer can still ask for a worktree per task."
      >
        <select
          aria-label="Where tasks work"
          data-slot="tasks-workspace"
          value={config.taskWorkspace ?? ''}
          disabled={save.isPending}
          onChange={(event) =>
            save.mutate({ taskWorkspace: (event.target.value || null) as SetConfigInput['taskWorkspace'] })
          }
          className={selectClass}
        >
          <option value="">Composer default (isolated worktree)</option>
          <option value="worktree">Isolated worktree per task</option>
          <option value="in-place">The repo checkout, one write task at a time</option>
        </select>
      </SettingsField>

      <SettingsField
        title="How changes land"
        hint={
          inPlace
            ? 'Auto-land: a finished task waits for your review — check Changes, send corrections, then use the task header\'s Commit to the base branch: it commits, rebases on the remote, runs the required checks and pushes. Autonomous tasks land on their own. A conflict or a failing check goes back to the agent. The agent is told this permission is granted.'
            : 'Auto-land applies to tasks that work in the checkout — set "Where tasks work" first.'
        }
      >
        <label className="flex w-fit items-center gap-3">
          <Switch
            aria-label="Auto-land on the base branch"
            data-slot="tasks-landing"
            checked={config.landing === 'auto'}
            disabled={save.isPending}
            onCheckedChange={(checked) =>
              save.mutate(
                { landing: checked ? 'auto' : null },
                { onSuccess: () => toast(checked ? 'Auto-land on — finished tasks push to the base branch' : 'Auto-land off') },
              )
            }
          />
          <span className="text-[13px] text-muted-foreground">
            {config.landing === 'auto' ? 'Auto-land on the base branch' : 'Review — nothing lands by itself (default)'}
          </span>
        </label>
        {config.landingBlocked ? (
          <p data-slot="tasks-landing-blocked" className="mt-2 text-[13px] text-destructive">
            {config.landingBlocked}
          </p>
        ) : null}
      </SettingsField>

      <RequiredChecksField config={config} />

      <SettingsField
        title="Default skills"
        hint="Preselected in the composer when nothing is picked: one for a new task, one for a read-only question (the Ask chip). A trunk-based project picks Ask on its own when the message ends with a question mark."
      >
        <div className="flex flex-col gap-2 sm:flex-row">
          <SkillSelect
            label="New task skill"
            slot="tasks-default-skill"
            value={config.defaultSkill}
            names={skillNames}
            disabled={save.isPending}
            onChange={(value) => save.mutate({ defaultSkill: value })}
          />
          <SkillSelect
            label="Ask skill"
            slot="tasks-ask-skill"
            value={config.askSkill}
            names={skillNames}
            disabled={save.isPending}
            onChange={(value) => save.mutate({ askSkill: value })}
          />
        </div>
      </SettingsField>

      <SettingsField
        title="Team skill repositories"
        hint="Skills from the shared team repositories. Turn off for a project whose skills live in the repo itself. Project-wide instructions for every task are under Instructions."
      >
        <label className="flex w-fit items-center gap-3">
          <Switch
            aria-label="Team skill repositories"
            data-slot="tasks-team-skills"
            checked={config.teamSkills}
            disabled={save.isPending}
            onCheckedChange={(checked) => save.mutate({ teamSkills: checked })}
          />
          <span className="text-[13px] text-muted-foreground">{config.teamSkills ? 'On' : 'Off'}</span>
        </label>
      </SettingsField>
    </>
  )
}

function SkillSelect({
  label,
  slot,
  value,
  names,
  disabled,
  onChange,
}: {
  label: string
  slot: string
  value: string | null
  names: string[]
  disabled: boolean
  onChange: (value: string | null) => void
}) {
  const options = value && !names.includes(value) ? [value, ...names] : names
  return (
    <label className="flex flex-1 flex-col gap-1 text-[12px] text-muted-foreground">
      {label}
      <select
        aria-label={label}
        data-slot={slot}
        value={value ?? ''}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || null)}
        className={selectClass}
      >
        <option value="">None</option>
        {options.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    </label>
  )
}

function RequiredChecksField({ config }: { config: ConfigResponse }) {
  const save = useConfigSave()
  const saved = config.requiredChecks.join('\n')
  const [text, setText] = useState(saved)
  useEffect(() => setText(saved), [saved])
  const commit = () => {
    const checks = text.split('\n').map((line) => line.trim()).filter(Boolean)
    if (checks.join('\n') === saved) return
    save.mutate({ requiredChecks: checks.length ? checks : null }, { onSuccess: () => toast('Required checks saved') })
  }
  return (
    <SettingsField
      title="Required checks"
      hint="Shell commands, one per line, run in the checkout before every auto-land (e.g. npm test). A failure goes back to the agent with its output."
    >
      <textarea
        aria-label="Required checks"
        data-slot="tasks-required-checks"
        value={text}
        rows={3}
        spellCheck={false}
        placeholder="npm test"
        disabled={save.isPending}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        className="block w-full max-w-md rounded-md border border-input bg-card px-3 py-1.5 font-mono text-[13px] shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
      />
    </SettingsField>
  )
}
