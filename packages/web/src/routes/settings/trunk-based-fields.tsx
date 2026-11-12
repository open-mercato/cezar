import { useEffect, useState, type ReactNode } from 'react'

import { useSkills } from '@/api/queries'
import type { ConfigResponse, SetConfigInput } from '@open-mercato/cezar-api-client'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { FormRow, SettingsCard, isCommitKey } from './form-row'
import { useConfigSave } from './use-config-save'

/** Radix Select refuses an empty item value; these stand in for "not set". */
const COMPOSER_DEFAULT = '__default__'
const NO_SKILL = '__none__'

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
 * today's branch-per-task behavior. `children` are rows the page appends to the first card (the
 * base branch, which is branching config but not trunk-specific).
 */
export function TrunkBasedFields({ config, children }: { config: ConfigResponse; children?: ReactNode }) {
  const save = useConfigSave()
  const skills = useSkills()
  const skillNames = (skills.data ?? []).map((skill) => skill.name)
  const trunk = config.profile === 'trunk'
  const inPlace = config.taskWorkspace === 'in-place'

  return (
    <>
      <SettingsCard id="development-model" title="Development model">
        <FormRow
          saved={save.savedFor('profile')}
          label="Development model"
          description="Branch per task: a worktree and branch per task, reviewed before merging. Trunk-based: tasks work directly in the checkout one at a time, and changes that pass the required checks land on the base branch without a PR. Read-only questions run beside them. Every setting below stays adjustable."
        >
          <Select
            value={trunk ? 'trunk' : 'branches'}
            disabled={save.isPending}
            onValueChange={(value) => {
              const toTrunk = value === 'trunk'
              save.mutate(toTrunk ? TRUNK_PRESET : BRANCHES_PRESET, {
                onSuccess: () => toast(toTrunk ? 'Trunk-based defaults applied' : 'Branch-per-task defaults restored'),
              })
            }}
          >
            <SelectTrigger size="sm" aria-label="Development model" data-slot="tasks-profile" data-value={trunk ? 'trunk' : 'branches'} className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value="branches">Branch per task</SelectItem>
              <SelectItem value="trunk">Trunk-based</SelectItem>
            </SelectContent>
          </Select>
        </FormRow>

        <FormRow
          saved={save.savedFor('taskWorkspace')}
          label="Where tasks work"
          description="In the checkout: no worktree or branch per task. Write tasks take turns on the working tree, so two tasks started together never conflict. The composer can still ask for a worktree per task."
        >
          <Select
            value={config.taskWorkspace ?? COMPOSER_DEFAULT}
            disabled={save.isPending}
            onValueChange={(value) =>
              save.mutate({ taskWorkspace: (value === COMPOSER_DEFAULT ? null : value) as SetConfigInput['taskWorkspace'] })
            }
          >
            <SelectTrigger size="sm" aria-label="Where tasks work" data-slot="tasks-workspace" data-value={config.taskWorkspace ?? ''} className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value={COMPOSER_DEFAULT}>Composer default</SelectItem>
              <SelectItem value="worktree">Worktree per task</SelectItem>
              <SelectItem value="in-place">The repo checkout</SelectItem>
            </SelectContent>
          </Select>
        </FormRow>

        <FormRow
          saved={save.savedFor('landing')}
          htmlFor="tasks-landing"
          label="Auto-land on the base branch"
          description={
            <>
              {inPlace
                ? 'A finished task waits for your review — check Changes, send corrections, then use the task header\'s Commit to the base branch: it commits, rebases on the remote, runs the required checks and pushes. Autonomous tasks land on their own. A conflict or a failing check goes back to the agent. The agent is told this permission is granted.'
                : 'Applies to tasks that work in the checkout — set "Where tasks work" first. Off: nothing lands by itself (default).'}
              {config.landingBlocked ? (
                <span data-slot="tasks-landing-blocked" className="mt-1 block text-danger">
                  {config.landingBlocked}
                </span>
              ) : null}
            </>
          }
        >
          <Switch
            id="tasks-landing"
            aria-label="Auto-land on the base branch"
            data-slot="tasks-landing"
            checked={config.landing === 'auto'}
            disabled={save.isPending}
            onCheckedChange={(checked) => save.mutate({ landing: checked ? 'auto' : null })}
          />
        </FormRow>

        <RequiredChecksField config={config} />

        {children}
      </SettingsCard>

      <SettingsCard id="skills" title="Skills">
        <FormRow
          saved={save.savedFor('defaultSkill')}
          htmlFor="tasks-default-skill"
          label="New task skill"
          description="Preselected in the composer when nothing is picked."
        >
          <SkillSelect
            id="tasks-default-skill"
            label="New task skill"
            slot="tasks-default-skill"
            value={config.defaultSkill}
            names={skillNames}
            disabled={save.isPending}
            onChange={(value) => save.mutate({ defaultSkill: value })}
          />
        </FormRow>
        <FormRow
          saved={save.savedFor('askSkill')}
          htmlFor="tasks-ask-skill"
          label="Ask skill"
          description="Preselected for a read-only question (the Ask chip). A trunk-based project picks Ask on its own when the message ends with a question mark."
        >
          <SkillSelect
            id="tasks-ask-skill"
            label="Ask skill"
            slot="tasks-ask-skill"
            value={config.askSkill}
            names={skillNames}
            disabled={save.isPending}
            onChange={(value) => save.mutate({ askSkill: value })}
          />
        </FormRow>
        <FormRow
          saved={save.savedFor('teamSkills')}
          htmlFor="tasks-team-skills"
          label="Team skill repositories"
          description="Skills from the shared team repositories. Turn off for a project whose skills live in the repo itself. Project-wide instructions for every task are under Instructions."
        >
          <Switch
            id="tasks-team-skills"
            aria-label="Team skill repositories"
            data-slot="tasks-team-skills"
            checked={config.teamSkills}
            disabled={save.isPending}
            onCheckedChange={(checked) => save.mutate({ teamSkills: checked })}
          />
        </FormRow>
      </SettingsCard>
    </>
  )
}

function SkillSelect({
  id,
  label,
  slot,
  value,
  names,
  disabled,
  onChange,
}: {
  id: string
  label: string
  slot: string
  value: string | null
  names: string[]
  disabled: boolean
  onChange: (value: string | null) => void
}) {
  const options = value && !names.includes(value) ? [value, ...names] : names
  return (
    <Select value={value ?? NO_SKILL} disabled={disabled} onValueChange={(next) => onChange(next === NO_SKILL ? null : next)}>
      <SelectTrigger id={id} size="sm" aria-label={label} data-slot={slot} data-value={value ?? ''} className="w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper">
        <SelectItem value={NO_SKILL}>None</SelectItem>
        {options.map((name) => (
          <SelectItem key={name} value={name}>
            {name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
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
    save.mutate({ requiredChecks: checks.length ? checks : null })
  }
  return (
    <FormRow
      stacked
      saved={save.savedFor('requiredChecks')}
      htmlFor="tasks-required-checks"
      label="Required checks"
      description="Shell commands, one per line, run in the checkout before every auto-land (e.g. npm test). A failure goes back to the agent with its output. Saves when you leave the field or press ⌘↵."
    >
      <Textarea
        id="tasks-required-checks"
        data-slot="tasks-required-checks"
        value={text}
        rows={3}
        spellCheck={false}
        placeholder="npm test"
        disabled={save.isPending}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (isCommitKey(event, true)) {
            event.preventDefault()
            commit()
          }
        }}
        className="max-w-xl font-mono text-ui"
      />
    </FormRow>
  )
}
