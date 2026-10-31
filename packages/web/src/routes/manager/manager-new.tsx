import { useState } from 'react'
import { useNavigate } from 'react-router'

import { sendManagerMessage, useCreateManager, useManagers } from '@/api/managers'
import { useHealth } from '@/api/queries'
import { Composer } from '@/components/composer/composer'
import { toast } from '@/components/ui/toaster'
import type { CreateManagerInput, ManagerEffort, ManagerProjects } from '@open-mercato/cezar-api-client'

import { AccountPicker, ModelPicker, ProjectsPicker, type ManagerPatch } from './manager-pickers'

export const MANAGER_PRESETS = [
  {
    label: 'Watch my repositories',
    prompt: 'Watch my repositories and tell me when something needs my attention: failing tasks, stalled work, pull requests ready to merge.',
  },
  {
    label: 'Keep PRs moving',
    prompt: 'Keep an eye on open pull requests. Tell me which are ready to merge, which have failing checks, and which wait on a review.',
  },
  {
    label: 'Run big tasks',
    prompt: 'Help me run large tasks: start them, follow their dispatched subtasks, and report back here when they need me.',
  },
] as const

interface Setup {
  projects: ManagerProjects
  runner?: string
  model?: string
  effort?: ManagerEffort
  agentProfile?: string
}

/** Fold a picker's patch in. `null` means back to the default, which here means absent. */
export function applySetupPatch(setup: Setup, patch: ManagerPatch): Setup {
  const next: Setup = { ...setup }
  if (patch.projects !== undefined) next.projects = patch.projects
  if (patch.runner === null) delete next.runner
  else if (patch.runner !== undefined) next.runner = patch.runner
  if (patch.model === null) delete next.model
  else if (patch.model !== undefined) next.model = patch.model
  if (patch.effort === null) delete next.effort
  else if (patch.effort !== undefined) next.effort = patch.effort
  if (patch.agentProfile === null) delete next.agentProfile
  else if (patch.agentProfile !== undefined) next.agentProfile = patch.agentProfile
  return next
}

/** `/manager/new`: the prompt is both its instructions and the first thing it is told. */
export function ManagerNewRoute() {
  const navigate = useNavigate()
  const enabled = useHealth().data?.capabilities.managers === true
  const managers = useManagers(enabled)
  const create = useCreateManager()
  const [prompt, setPrompt] = useState('')
  const [setup, setSetup] = useState<Setup>({ projects: 'all', effort: 'medium' })
  const onChange = (patch: ManagerPatch) => setSetup((current) => applySetupPatch(current, patch))
  const first = (managers.data?.managers.length ?? 0) === 0

  const submit = async (text: string) => {
    const input: CreateManagerInput = { instructions: text, ...setup }
    const manager = await create.mutateAsync(input)
    // The manager exists now, so a failed first message is a toast in its chat, not a lost setup.
    await sendManagerMessage(manager.id, text).catch((error: unknown) =>
      toast(error instanceof Error ? error.message : String(error), { tone: 'danger' }))
    navigate(`/manager/${encodeURIComponent(manager.id)}`, { replace: true })
  }

  return (
    <div data-route="manager-new" className="flex min-h-full flex-col items-center justify-center gap-5 px-4 py-10">
      <h1 className="text-center text-3xl font-bold tracking-tight">{first ? 'Setup Your first manager' : 'New manager'}</h1>
      <div className="w-full max-w-xl">
        <Composer
          value={prompt}
          onValueChange={setPrompt}
          onSubmit={submit}
          autoFocus
          attachments={false}
          autocompleteSkills={false}
          placeholder="What should this manager do?"
          ariaLabel="What should this manager do?"
          sendAriaLabel="Create manager"
          sendLabel="Create"
        />
      </div>
      <div className="flex flex-wrap justify-center gap-1.5">
        {MANAGER_PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            data-slot="manager-preset"
            onClick={() => setPrompt(preset.prompt)}
            className="rounded-full border border-border px-3 py-1 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {preset.label}
          </button>
        ))}
      </div>
      <div className="flex flex-col items-center gap-1">
        <ProjectsPicker value={setup.projects} onChange={(projects) => onChange({ projects })} />
        <ModelPicker {...setup} onChange={onChange} />
        <AccountPicker {...setup} onChange={onChange} />
      </div>
    </div>
  )
}
