import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'

import { sendManagerMessage, useCreateManager, useManagers } from '@/api/managers'
import { useHealth } from '@/api/queries'
import { Composer } from '@/components/composer/composer'
import { enterInsertsNewline } from '@/lib/enter-key'
import { toast } from '@/components/ui/toaster'
import type { AttachmentEntry, CreateManagerInput, ManagerAccess, ManagerEffort, ManagerMascot, ManagerProjects } from '@open-mercato/cezar-api-client'

import { MascotPicker } from './mascot-picker'
import { FOCUS_COMPOSER } from './manager-focus'

import { AccountPicker, ModelPicker, ProjectsPicker, type ManagerPatch } from './manager-pickers'

export const MANAGER_PRESETS = [
  {
    label: 'Watch my repositories',
    name: 'Repository Watcher',
    prompt: 'Watch my repositories and tell me when something needs my attention: failing tasks, stalled work, pull requests ready to merge.',
  },
  {
    label: 'Keep PRs moving',
    name: 'PR Manager',
    prompt: 'Keep an eye on open pull requests. Tell me which are ready to merge, which have failing checks, and which wait on a review.',
  },
  {
    label: 'Run big tasks',
    name: 'Task Manager',
    prompt: 'Help me run large tasks: start them, follow their dispatched subtasks, and report back here when they need me.',
  },
] as const

const NAME_LIMIT = 40

/** Every manager called "Manager" can't be told apart in the sidebar. A preset names a role; a typed
 *  prompt lends its first line, cut at a word, until the manager picks a role for itself. */
export function managerNameFrom(prompt: string): string {
  const text = prompt.trim()
  const preset = MANAGER_PRESETS.find((entry) => entry.prompt === text)
  if (preset) return preset.name
  const line = (text.split('\n')[0] ?? '').replace(/[.!?:,;]+$/, '').trim()
  if (line.length <= NAME_LIMIT) return line
  const cut = line.slice(0, NAME_LIMIT)
  const space = cut.lastIndexOf(' ')
  return `${(space > 12 ? cut.slice(0, space) : cut).trimEnd()}…`
}

interface Setup {
  projects: ManagerProjects
  access?: ManagerAccess
  projectAccess?: Record<string, ManagerAccess>
  runner?: string
  model?: string
  effort?: ManagerEffort
  agentProfile?: string
}

/** Fold a picker's patch in. `null` means back to the default, which here means absent. */
export function applySetupPatch(setup: Setup, patch: ManagerPatch): Setup {
  const next: Setup = { ...setup }
  if (patch.projects !== undefined) next.projects = patch.projects
  if (patch.access !== undefined) next.access = patch.access
  if (patch.projectAccess !== undefined) next.projectAccess = patch.projectAccess
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
  const [mascot, setMascot] = useState<ManagerMascot>('base')
  const [setup, setSetup] = useState<Setup>({ projects: 'all', effort: 'medium' })
  const onChange = (patch: ManagerPatch) => setSetup((current) => applySetupPatch(current, patch))
  // Only a loaded list can say "first": a pasted /manager/new must not flash it.
  const first = managers.data?.managers.length === 0
  // On /manager the index swaps this form for the chat as soon as the list has the new manager.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const submit = async (text: string, attachments: AttachmentEntry[]) => {
    const name = managerNameFrom(text)
    const input: CreateManagerInput = { instructions: text, mascot, ...(name ? { name } : {}), ...setup }
    const manager = await create.mutateAsync(input)
    // The manager exists now, so a failed first message is a toast in its chat, not a lost setup.
    await sendManagerMessage(manager.id, text, attachments).catch((error: unknown) =>
      toast(error instanceof Error ? error.message : String(error), { tone: 'danger' }))
    if (mounted.current) navigate(`/manager/${encodeURIComponent(manager.id)}`, { replace: true, state: FOCUS_COMPOSER })
  }

  return (
    <div data-route="manager-new" className="flex min-h-full flex-col items-center justify-center gap-5 px-4 py-8 md:py-10">
      <h1 className="text-center text-2xl font-bold tracking-tight text-balance md:text-3xl">{first ? 'Set up your first manager' : 'New manager'}</h1>
      <div className="w-full max-w-xl">
        <MascotPicker value={mascot} onChange={setMascot} />
      </div>
      <div className="w-full max-w-xl">
        <Composer
          value={prompt}
          onValueChange={setPrompt}
          onSubmit={submit}
          // Never on a phone: the keyboard would cover the form (manager-focus.ts).
          autoFocus={!enterInsertsNewline()}
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
            className="rounded-full border border-border px-3 py-1 text-xs pointer-coarse:min-h-11 pointer-coarse:px-4 font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {preset.label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
        <ProjectsPicker value={setup.projects} access={setup.access} projectAccess={setup.projectAccess} onAccess={onChange} onChange={(projects) => onChange({ projects })} />
        <ModelPicker {...setup} onChange={onChange} />
        <AccountPicker {...setup} onChange={onChange} />
      </div>
    </div>
  )
}
