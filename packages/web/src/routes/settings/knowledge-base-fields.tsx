import { useEffect, useState } from 'react'

import { useSkills } from '@/api/queries'
import type { ConfigResponse, SetConfigInput } from '@open-mercato/cezar-api-client'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import { SettingsField } from './settings-field'
import { useConfigSave } from './use-config-save'

const selectClass =
  'block w-full max-w-md rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50'

/** The "Knowledge base / notes" preset (spec 2026-10-20-knowledge-base-projects). Each key stays
 *  adjustable on its own below; switching back to Code clears every key the preset set. */
export const NOTES_PRESET: SetConfigInput = {
  profile: 'notes',
  taskWorkspace: 'in-place',
  landing: 'auto',
  reviewGate: false,
}
export const CODE_PRESET: SetConfigInput = {
  profile: null,
  taskWorkspace: null,
  landing: null,
  defaultSkill: null,
  askSkill: null,
}

/**
 * Settings → Tasks, the knowledge-base half: project type, where tasks work, how finished work
 * lands, the checks it must pass, and the skills a new task starts with. Every default here is
 * today's code-project behavior.
 */
export function KnowledgeBaseFields({ config }: { config: ConfigResponse }) {
  const save = useConfigSave()
  const skills = useSkills()
  const skillNames = (skills.data ?? []).map((skill) => skill.name)
  const notes = config.profile === 'notes'
  const inPlace = config.taskWorkspace === 'in-place'

  return (
    <>
      <SettingsField
        title="Project type"
        hint="Knowledge base: tasks file notes straight into the checkout one at a time, and validated changes land on the base branch without a PR. Questions run read-only beside them. Every setting below stays adjustable."
      >
        <select
          aria-label="Project type"
          data-slot="tasks-profile"
          value={notes ? 'notes' : 'code'}
          disabled={save.isPending}
          onChange={(event) => {
            const toNotes = event.target.value === 'notes'
            save.mutate(toNotes ? NOTES_PRESET : CODE_PRESET, {
              onSuccess: () => toast(toNotes ? 'Knowledge-base defaults applied' : 'Code-project defaults restored'),
            })
          }}
          className={selectClass}
        >
          <option value="code">Code (default) — a worktree and branch per task, review before merging</option>
          <option value="notes">Knowledge base / notes — trunk-based, auto-land</option>
        </select>
      </SettingsField>

      <SettingsField
        title="Where tasks work"
        hint="In the checkout: no worktree or branch per task. Write tasks take turns on the working tree, so two notes filed together never conflict. The composer can still ask for a worktree per task."
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
            ? 'Auto-land: when a task finishes, cezar commits, rebases on the remote, runs the required checks and pushes to the base branch. A conflict or a failing check goes back to the agent instead. The agent is told this permission is granted.'
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
        hint="Preselected in the composer when nothing is picked: one for a new task, one for a read-only question (the Ask chip). A notes project picks Ask on its own when the message ends with a question mark."
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
      hint="Shell commands, one per line, run in the checkout before every auto-land (e.g. node scripts/kb.ts validate). A failure goes back to the agent with its output."
    >
      <textarea
        aria-label="Required checks"
        data-slot="tasks-required-checks"
        value={text}
        rows={3}
        spellCheck={false}
        placeholder="node scripts/kb.ts validate"
        disabled={save.isPending}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        className="block w-full max-w-md rounded-md border border-input bg-card px-3 py-1.5 font-mono text-[13px] shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
      />
    </SettingsField>
  )
}
