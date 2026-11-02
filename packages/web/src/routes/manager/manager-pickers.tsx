import { CheckIcon, ChevronDownIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { useAgentAccounts } from '@/api/agent-accounts'
import { useHealth, useProjects, useProviderStatus, useRunnerModels } from '@/api/queries'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import {
  DropdownMenu,
  DropdownMenuContent,
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
  type Runner,
  type UpdateManagerInput,
  managerAccessOf,
  type ManagerAccess,
} from '@open-mercato/cezar-api-client'

/** What a picker edits. `null` clears, as in the update route; the setup screen maps it to absent. */
export type ManagerPatch = Pick<
  UpdateManagerInput,
  'projects' | 'access' | 'projectAccess' | 'runner' | 'model' | 'effort' | 'agentProfile' | 'cronMinutes'
>

export const PICKER_TRIGGER =
  'inline-flex min-h-8 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-sm text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:bg-muted'

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
}: {
  value: ManagerProjects
  access?: ManagerAccess | undefined
  projectAccess?: Record<string, ManagerAccess> | undefined
  onChange: (next: ManagerProjects) => void
  onAccess: (patch: ManagerPatch) => void
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
        <button type="button" data-slot="manager-projects-picker" aria-label="Connected projects" className={PICKER_TRIGGER}>
          <TriggerLabel>{[label, accessLabel(reached.map(accessOf))].filter(Boolean).join(' · ')}</TriggerLabel>
        </button>
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

/** Model and effort are one control, as drawn: `Opus 5.5 Medium`. */
export function ModelPicker({
  runner: pinnedRunner,
  model,
  effort,
  onChange,
  pill = false,
}: {
  runner?: string
  model?: string
  effort?: ManagerEffort
  onChange: (patch: ManagerPatch) => void
  /** The phone composer's round control. */
  pill?: boolean
}) {
  const runner = useManagerRunner(pinnedRunner)
  // Pi fails closed on `bashAllowlist`, so a Pi manager would have no `cez-manager` to act with.
  const runners = usableRunners(useProviderStatus().data).filter((candidate) => candidate !== 'pi')
  const catalog = useRunnerModels(runner)
  const models = modelsForRunner(runner, catalog.data, [model])
  const label = models.find((entry) => entry.id === (model ?? ''))?.label ?? model ?? 'auto'
  // `--effort` is a Claude flag (spec, Tools); elsewhere the control would promise nothing.
  const effortApplies = runner === 'claude'
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" data-slot="manager-model-picker" aria-label="Model and effort" className={cn(PICKER_TRIGGER, pill && 'h-10 max-w-44 rounded-full bg-muted px-3')}>
          <TriggerLabel>
            <span className="text-foreground">{label}</span>
            {effortApplies && effort ? <span className="ml-1.5">{effortLabel(effort)}</span> : null}
          </TriggerLabel>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto">
        {runners.length > 1 ? (
          <>
            <DropdownMenuLabel className="text-xs text-soft-foreground">Agent</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={runner}
              // A model belongs to its runner, so changing agent drops the pin.
              onValueChange={(next) => onChange({ runner: next, model: null })}
            >
              {runners.map((entry) => (
                <DropdownMenuRadioItem key={entry} value={entry}>{entry}</DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuLabel className="text-xs text-soft-foreground">Model</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={model ?? ''} onValueChange={(next) => onChange({ model: next === '' ? null : next })}>
          {models.map((entry) => (
            <DropdownMenuRadioItem key={entry.id} value={entry.id}>{entry.label}</DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {effortApplies ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-soft-foreground">Effort</DropdownMenuLabel>
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
}: {
  runner?: string
  agentProfile?: string
  onChange: (patch: ManagerPatch) => void
}) {
  const runner = useManagerRunner(pinnedRunner)
  const logins = useAgentAccounts().accounts.filter((account) => account.provider === runner)
  const current = logins.find((account) => account.id === agentProfile)
  const named = logins.filter((account) => account.id !== DEFAULT_AGENT_ACCOUNT_ID)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" data-slot="manager-account-picker" aria-label="Agent account" className={PICKER_TRIGGER}>
          <TriggerLabel>{current ? `Account ${current.label}` : 'Account'}</TriggerLabel>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={agentProfile ?? DEFAULT_AGENT_ACCOUNT_ID}
          onValueChange={(next) => onChange({ agentProfile: next === DEFAULT_AGENT_ACCOUNT_ID ? null : next })}
        >
          <DropdownMenuRadioItem value={DEFAULT_AGENT_ACCOUNT_ID}>Default</DropdownMenuRadioItem>
          {named.map((account) => (
            <DropdownMenuRadioItem key={account.id} value={account.id}>{account.label}</DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
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
