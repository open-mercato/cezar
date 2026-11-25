import { CheckIcon, ChevronDownIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { useAgentProfiles, useHealth, useProjects, useProviderStatus, useRunnerModels } from '@/api/queries'
import { useAddAccount } from '@/components/add-account/add-account-host'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { accessLabel, cronLabel, effortLabel, projectsLabel } from '@/lib/managers'
import { usableRunners } from '@/lib/provider-status'
import { cn } from '@/lib/utils'
import { modelsForRunner } from '@/routes/new-task-form'
import {
  DEFAULT_AGENT_ACCOUNT_ID,
  MANAGER_CRON_MINUTES,
  managerCronMinutesSchema,
  managerEffortSchema,
  type ManagerEffort,
  type ManagerProjects,
  type ManagerTaskAgent,
  type Runner,
  type UpdateManagerInput,
  managerAccessOf,
  type ManagerAccess,
} from '@open-mercato/cezar-api-client'

/** What a picker edits. `null` clears, as in the update route; the setup screen maps it to absent. */
export type ManagerPatch = Pick<
  UpdateManagerInput,
  'projects' | 'access' | 'projectAccess' | 'runner' | 'taskRunner' | 'taskAgents' | 'model' | 'effort' | 'agentProfile' | 'cronMinutes'
>

export const PICKER_TRIGGER =
  'inline-flex min-h-8 min-w-0 pointer-coarse:min-h-11 items-center gap-1.5 rounded-md px-1.5 text-sm text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:bg-muted'

/** The Figma's quiet picker: a chevron, then the value. */
function TriggerLabel({ children }: { children: ReactNode }) {
  return (
    <>
      <ChevronDownIcon aria-hidden="true" className="size-3.5 shrink-0 text-foreground" />
      <span className="truncate">{children}</span>
    </>
  )
}

function Check({ on }: { on: boolean }) {
  return on ? <CheckIcon aria-hidden="true" className="ml-auto size-3.5 shrink-0 text-primary" /> : null
}

/** Inside a command row, so its own click and Enter must not also tick the row. */
function AccessToggle({ access, label, onChange }: { access: ManagerAccess; label: string; onChange: (next: ManagerAccess) => void }) {
  return (
    <button
      type="button"
      data-slot="manager-access-toggle"
      data-access={access}
      aria-label={`${label}: ${access === 'read' ? 'read-only' : 'write access'}. Switch.`}
      className={cn(
        'shrink-0 rounded-full border px-2 py-0.5 text-meta font-medium outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50',
        access === 'read' ? 'border-pending-strong/45 text-pending-strong' : 'border-border text-muted-foreground',
      )}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        onChange(access === 'read' ? 'write' : 'read')
      }}
    >
      {access === 'read' ? 'Read-only' : 'Write'}
    </button>
  )
}

export function ProjectsPicker({
  value,
  access,
  projectAccess,
  onChange,
  onAccess,
  trigger,
}: {
  value: ManagerProjects
  access?: ManagerAccess | undefined
  projectAccess?: Record<string, ManagerAccess> | undefined
  onChange: (next: ManagerProjects) => void
  onAccess: (patch: ManagerPatch) => void
  /** The Watching panel's "Edit": the same picker behind another button. */
  trigger?: ReactNode
}) {
  const registry = useProjects().data?.projects
  const projects = registry ?? []
  const nameOf = (id: string) => projects.find((project) => project.id === id)?.name
  // A project removed from cezar stays in the definition, where no option could untick it.
  const selected = value === 'all' ? [] : registry ? value.filter((id) => nameOf(id) !== undefined) : value
  const allRemoved = value !== 'all' && registry !== undefined && selected.length === 0
  const accessOf = (id: string) => managerAccessOf({ access, projectAccess }, id)
  const reached = value === 'all' ? projects.map((project) => project.id) : selected
  const label = allRemoved ? 'Project removed' : projectsLabel(value === 'all' ? value : selected, nameOf)
  const toggle = (id: string) => {
    const next = selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id]
    // The contract refuses an empty list, and no project at all is not a manager.
    onChange(next.length === 0 ? 'all' : next)
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        {trigger ?? (
          <button type="button" data-slot="manager-projects-picker" aria-label="Connected projects" className={PICKER_TRIGGER}>
            <TriggerLabel>{[label, accessLabel(reached.map(accessOf))].filter(Boolean).join(' · ')}</TriggerLabel>
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-72 max-w-[calc(100vw-2rem)] p-0">
        <Command label="Connected projects">
          <CommandInput placeholder="search projects…" />
          <CommandList className="max-h-[min(16rem,calc(var(--radix-popover-content-available-height)-3rem))]">
            <CommandEmpty>Nothing matches.</CommandEmpty>
            <CommandGroup>
              <CommandItem value="all projects" data-slot="manager-project-all" onSelect={() => onChange('all')}>
                All projects
                <span className="ml-auto flex items-center gap-2">
                  <Check on={value === 'all'} />
                  {/* Everything at once, so it clears each project's own setting. */}
                  <AccessToggle access={access ?? 'write'} label="All projects" onChange={(next) => onAccess({ access: next, projectAccess: {} })} />
                </span>
              </CommandItem>
              {projects.map((project) => (
                <CommandItem
                  key={project.id}
                  value={`${project.name} ${project.id}`}
                  data-slot="manager-project-option"
                  data-project={project.id}
                  onSelect={() => toggle(project.id)}
                >
                  <span className="truncate">{project.name}</span>
                  <span className="ml-auto flex items-center gap-2">
                    <Check on={selected.includes(project.id)} />
                    {reached.includes(project.id) ? (
                      <AccessToggle
                        access={accessOf(project.id)}
                        label={project.name}
                        onChange={(next) => onAccess({ projectAccess: { ...projectAccess, [project.id]: next } })}
                      />
                    ) : null}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** The runner a manager with no pin uses: the machine default, as a task would. */
export function useManagerRunner(pinned: string | undefined): Runner {
  const health = useHealth()
  return (pinned as Runner | undefined) ?? health.data?.defaultRunner ?? 'claude'
}

function useManagerRunners() {
  // Pi cannot grant the manager's restricted shell tools.
  return usableRunners(useProviderStatus().data).filter((runner) => runner !== 'pi')
}

/** Radix re-fires on the checked item: only a different agent drops its model and account pins. */
function selectRunner(current: Runner, pinned: string | undefined, next: string, onChange: (patch: ManagerPatch) => void) {
  if (next !== current) onChange({ runner: next, model: null, agentProfile: null })
  else if (!pinned) onChange({ runner: next })
}

export function ManagerRunnerPicker({ runner: pinnedRunner, onChange, className }: {
  runner?: string
  onChange: (patch: ManagerPatch) => void
  className?: string
}) {
  const runner = useManagerRunner(pinnedRunner)
  const runners = useManagerRunners()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Manager agent" className={cn(PICKER_TRIGGER, className)}>
          <TriggerLabel>{runner}</TriggerLabel>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Agent</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={runner} onValueChange={(next) => selectRunner(runner, pinnedRunner, next, onChange)}>
          {runners.map((entry) => <DropdownMenuRadioItem key={entry} value={entry}>{entry}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Model and effort are one control, as drawn: `Opus 5.5 Medium`. */
export function ModelPicker({
  runner: pinnedRunner,
  model,
  effort,
  agentProfile,
  onChange,
  modelOnly = false,
  className,
}: {
  runner?: string
  model?: string
  effort?: ManagerEffort
  agentProfile?: string
  onChange: (patch: ManagerPatch) => void
  /** The dialog has separate agent/account fields; setup keeps its combined menu. */
  modelOnly?: boolean
  className?: string
}) {
  const runner = useManagerRunner(pinnedRunner)
  const runners = useManagerRunners()
  const catalog = useRunnerModels(runner)
  const models = modelsForRunner(runner, catalog.data, [model])
  const label = models.find((entry) => entry.id === (model ?? ''))?.label ?? model ?? 'auto'
  // `--effort` is a Claude flag (spec, Tools); elsewhere the control would promise nothing.
  const effortApplies = runner === 'claude'
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-slot="manager-model-picker"
          aria-label="Model and effort"
          className={cn(PICKER_TRIGGER, className)}
        >
          <TriggerLabel>
            <span className="text-foreground">{label}</span>
            {effortApplies && effort ? <span className="ml-1.5">{effortLabel(effort)}</span> : null}
          </TriggerLabel>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] max-w-[calc(100vw-2rem)] overflow-y-auto">
        {!modelOnly && runners.length > 1 ? (
          <>
            <DropdownMenuLabel className="text-xs text-muted-foreground">Agent</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={runner}
              // A model and an account belong to their runner, so changing agent drops both pins.
              onValueChange={(next) => selectRunner(runner, pinnedRunner, next, onChange)}
            >
              {runners.map((entry) => (
                <DropdownMenuRadioItem key={entry} value={entry}>{entry}</DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {modelOnly ? null : <>
          <DropdownMenuLabel className="text-xs text-muted-foreground">Account</DropdownMenuLabel>
          <AccountOptions runner={runner} {...(agentProfile !== undefined ? { agentProfile } : {})} onChange={onChange} />
          <DropdownMenuSeparator />
        </>}
        <DropdownMenuLabel className="text-xs text-muted-foreground">Model</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={model ?? ''} onValueChange={(next) => onChange({ model: next === '' ? null : next })}>
          {models.map((entry) => (
            <DropdownMenuRadioItem key={entry.id} value={entry.id}>{entry.label}</DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {effortApplies ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">Effort</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={effort ?? ''}
              onValueChange={(next) => onChange({ effort: next === '' ? null : managerEffortSchema.parse(next) })}
            >
              <DropdownMenuRadioItem value="">Default</DropdownMenuRadioItem>
              {managerEffortSchema.options.map((entry) => (
                <DropdownMenuRadioItem key={entry} value={entry}>{effortLabel(entry)}</DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function AccountPicker({
  runner: pinnedRunner,
  agentProfile,
  onChange,
  className,
}: {
  runner?: string
  agentProfile?: string
  onChange: (patch: ManagerPatch) => void
  className?: string
}) {
  const runner = useManagerRunner(pinnedRunner)
  const profiles = useAgentProfiles().data
  const selected = agentProfile ?? profiles?.defaults?.[runner] ?? DEFAULT_AGENT_ACCOUNT_ID
  const current = profiles?.profiles.find((account) => account.provider === runner && account.id === selected)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" data-slot="manager-account-picker" aria-label="Agent account" className={cn(PICKER_TRIGGER, className)}>
          <TriggerLabel>Account {current?.label ?? (selected === DEFAULT_AGENT_ACCOUNT_ID ? 'Default' : selected)}</TriggerLabel>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-[calc(100vw-2rem)]">
        <AccountOptions runner={runner} {...(agentProfile !== undefined ? { agentProfile } : {})} onChange={onChange} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function AccountOptions({ runner, agentProfile, onChange }: { runner: Runner; agentProfile?: string; onChange: (patch: ManagerPatch) => void }) {
  const profiles = useAgentProfiles().data
  const accounts = profiles?.profiles.filter((account) => account.provider === runner && !account.pending) ?? []
  const addAccount = useAddAccount()
  const defaultId = profiles?.defaults?.[runner] ?? DEFAULT_AGENT_ACCOUNT_ID
  const defaultLabel = accounts.find((account) => account.id === defaultId)?.label ?? 'Default'
  return (
    <>
      <DropdownMenuRadioGroup value={agentProfile ?? ''} onValueChange={(next) => onChange({ agentProfile: next === '' ? null : next })}>
        <DropdownMenuRadioItem value=""><span className="min-w-0 break-words whitespace-normal">Use workspace default ({defaultLabel})</span></DropdownMenuRadioItem>
        <DropdownMenuRadioItem value={DEFAULT_AGENT_ACCOUNT_ID}>Default</DropdownMenuRadioItem>
        {accounts.filter((account) => account.id !== DEFAULT_AGENT_ACCOUNT_ID).map((account) => (
          <DropdownMenuRadioItem key={account.id} value={account.id}><span className="min-w-0 break-words whitespace-normal">{account.label}</span></DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      {addAccount?.capable.includes(runner) ? (
        <DropdownMenuItem
          data-action="manager-add-account"
          className="border-t border-border"
          onSelect={() => addAccount.open({ provider: runner, onAdded: (profile) => onChange({ agentProfile: profile.id }) })}
        >
          Add account…
        </DropdownMenuItem>
      ) : null}
    </>
  )
}

export function TaskRunnerPicker({ taskRunner, taskAgents, onChange, className }: {
  taskRunner?: Runner
  taskAgents?: ManagerTaskAgent[] | undefined
  onChange: (patch: ManagerPatch) => void
  className?: string
}) {
  const status = useProviderStatus().data
  const profiles = (useAgentProfiles().data?.profiles ?? []).filter((profile) => !profile.pending)
  const selected = taskAgents ?? (taskRunner ? [{ runner: taskRunner }] : [])
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<ManagerTaskAgent[]>(selected)
  const value = open ? draft : selected
  const same = (a: ManagerTaskAgent, b: ManagerTaskAgent) => a.runner === b.runner && a.agentProfile === b.agentProfile
  const runners = [...new Set([
    ...usableRunners(status),
    ...profiles.filter((profile) => profile.id !== DEFAULT_AGENT_ACCOUNT_ID
      && status?.providers.find((row) => row.provider === profile.provider)?.enabled !== false
      && status?.providers.find((row) => row.provider === profile.provider)?.status !== 'not-installed').map((profile) => profile.provider),
    ...value.map((agent) => agent.runner),
  ])]
  const accountLabel = (agent: ManagerTaskAgent) => agent.agentProfile === undefined ? 'Automatic account'
    : profiles.find((profile) => profile.provider === agent.runner && profile.id === agent.agentProfile)?.label
      ?? (agent.agentProfile === DEFAULT_AGENT_ACCOUNT_ID ? 'Default' : `Unavailable account (${agent.agentProfile})`)
  const change = (next: ManagerTaskAgent[]) => {
    setDraft(next)
    onChange({ taskRunner: null, taskAgents: next.length ? next : null })
  }
  const label = value.length === 0 ? 'Automatic' : value.length === 1
    ? value[0]!.runner : `${value.length} accounts`
  return (
    <DropdownMenu open={open} onOpenChange={(next) => { if (next) setDraft(selected); setOpen(next) }}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-slot="manager-task-runner-picker"
          aria-label="Agent for new tasks"
          title="Choose the accounts the manager may use for new tasks. Automatic lets it choose freely."
          className={cn(PICKER_TRIGGER, className)}
        >
          <TriggerLabel>Tasks: {label}</TriggerLabel>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-[calc(100vw-2rem)]">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Accounts for new tasks</DropdownMenuLabel>
        <DropdownMenuCheckboxItem checked={value.length === 0} onSelect={(event) => event.preventDefault()} onCheckedChange={() => change([])} className="pointer-coarse:min-h-11">
          Automatic
        </DropdownMenuCheckboxItem>
        {runners.map((runner) => {
          const choices: ManagerTaskAgent[] = [{ runner, agentProfile: DEFAULT_AGENT_ACCOUNT_ID },
            ...profiles.filter((profile) => profile.provider === runner && profile.id !== DEFAULT_AGENT_ACCOUNT_ID).map((profile) => ({ runner, agentProfile: profile.id })),
          ]
          for (const agent of value.filter((agent) => agent.runner === runner)) if (!choices.some((choice) => same(choice, agent))) choices.push(agent)
          return <div key={runner}>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">{runner}</DropdownMenuLabel>
            {choices.map((agent) => {
              const checked = value.some((choice) => same(choice, agent))
              return <DropdownMenuCheckboxItem
                key={JSON.stringify(agent)}
                checked={checked}
                className="pointer-coarse:min-h-11"
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={() => change(checked ? value.filter((choice) => !same(choice, agent)) : [...value, agent])}
              ><span className="min-w-0 break-words whitespace-normal">{runner} · {accountLabel(agent)}</span></DropdownMenuCheckboxItem>
            })}
          </div>
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function RefreshPicker({
  minutes,
  onChange,
  className,
}: {
  minutes: number
  onChange: (patch: ManagerPatch) => void
  className?: string
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" data-slot="manager-chron-picker" aria-label="Watch check cadence" className={cn(PICKER_TRIGGER, className)}>
          <TriggerLabel>Refresh: {cronLabel(minutes)}</TriggerLabel>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={String(minutes)}
          onValueChange={(next) => onChange({ cronMinutes: managerCronMinutesSchema.parse(Number(next)) })}
        >
          {MANAGER_CRON_MINUTES.map((entry) => (
            <DropdownMenuRadioItem key={entry} value={String(entry)}>{cronLabel(entry)}</DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
