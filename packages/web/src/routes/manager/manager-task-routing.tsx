import { GripVerticalIcon, ListChecksIcon, XIcon } from 'lucide-react'
import { useState, type DragEvent, type ReactNode } from 'react'

import { useAgentProfiles } from '@/api/queries'
import { IntegerStepper } from '@/components/integer-stepper'
import { PHONE_QUERY, useMediaQuery } from '@/lib/use-media-query'
import { cn } from '@/lib/utils'
import { DEFAULT_AGENT_ACCOUNT_ID, type ManagerSummary, type ManagerTaskAgent, type ManagerTaskLimitSwitch } from '@open-mercato/cezar-api-client'

import { TaskRunnerPicker, type ManagerPatch } from './manager-pickers'

const FIELD = 'h-11 w-full justify-between rounded-lg border border-border bg-background px-3 text-foreground [&>svg]:order-last [&>span]:min-w-0 [&>span]:flex-1 [&>span]:text-left'
const DEFAULT_BUSY_AT = 2

function Radio({ checked, onSelect, slot, children }: { checked: boolean; onSelect: () => void; slot: string; children: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      data-slot={slot}
      onClick={onSelect}
      className="flex w-full items-start gap-2.5 rounded-lg px-1 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11"
    >
      <span aria-hidden="true" className={cn('mt-0.5 size-4 shrink-0 rounded-full border', checked ? 'border-4 border-primary' : 'border-border')} />
      <span className="min-w-0 flex-1">{children}</span>
    </button>
  )
}

function RoleSwitch({ role, label, onChange }: { role: 'main' | 'backup'; label: string; onChange: (role: 'main' | 'backup') => void }) {
  return (
    <div role="radiogroup" aria-label={`Role of ${label}`} className="flex shrink-0 gap-0.5 rounded-lg border border-border bg-muted p-0.5">
      {(['main', 'backup'] as const).map((value) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={role === value}
          data-role={value}
          onClick={() => onChange(value)}
          className={cn(
            'rounded-md px-2 text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-9 pointer-coarse:px-2.5',
            role === value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground',
          )}
        >
          {value === 'main' ? 'Main' : 'Backup'}
        </button>
      ))}
    </div>
  )
}

/**
 * "For new tasks" as a list with roles (spec 2026-11-25-manager-task-routing): Main accounts share new
 * tasks, Backup ones are used in order. The account picker stays the way to add and remove accounts.
 */
export function TaskRoutingSection({ manager, onPatch }: { manager: ManagerSummary; onPatch: (patch: ManagerPatch) => void }) {
  const profiles = useAgentProfiles().data?.profiles ?? []
  const phone = useMediaQuery(PHONE_QUERY)
  const [dragging, setDragging] = useState<number | null>(null)
  const agents = manager.taskAgents ?? []
  const routed = agents.some((agent) => agent.role !== undefined)
  const labelOf = (agent: ManagerTaskAgent) => agent.agentProfile === undefined ? 'Automatic account'
    : profiles.find((profile) => profile.provider === agent.runner && profile.id === agent.agentProfile)?.label
      ?? (agent.agentProfile === DEFAULT_AGENT_ACCOUNT_ID ? 'Default' : agent.agentProfile)
  // Any role, or the busy rule, turns routing on: every row then carries one (new rows are Main).
  const withRoles = (list: ManagerTaskAgent[]) => list.map((agent) => ({ ...agent, role: agent.role ?? 'main' as const }))
  const saveAgents = (list: ManagerTaskAgent[]) => onPatch({ taskRunner: null, taskAgents: list.length ? list : null })
  const move = (from: number, to: number) => {
    if (from === to) return
    const next = [...agents]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved!)
    saveAgents(next)
  }
  const busyAt = manager.taskBusyAt
  const limitSwitch: ManagerTaskLimitSwitch = manager.taskLimitSwitch ?? 'any'
  return (
    <section aria-label="Agents for new tasks" data-slot="manager-task-routing" className="space-y-3 rounded-xl border border-border p-4">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold"><ListChecksIcon aria-hidden="true" className="size-4 text-muted-foreground" />For new tasks</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {agents.length > 0 ? 'Main accounts share new tasks evenly. Backup accounts are used in order.' : 'Choose the agents and accounts this Manager may use. Automatic lets it choose freely.'}
        </p>
      </div>
      {agents.length > 0 ? (
        <ol className="space-y-1.5">
          {agents.map((agent, index) => {
            const label = `${agent.runner} · ${labelOf(agent)}`
            return (
              <li
                key={`${agent.runner}|${agent.agentProfile ?? ''}`}
                data-slot="manager-task-agent-row"
                draggable={!phone && agents.length > 1}
                onDragStart={() => setDragging(index)}
                onDragEnd={() => setDragging(null)}
                onDragOver={(event: DragEvent) => { if (dragging !== null) event.preventDefault() }}
                onDrop={() => { if (dragging !== null) move(dragging, index); setDragging(null) }}
                className="flex min-h-11 items-center gap-2 rounded-lg border border-border bg-background px-2 text-sm"
              >
                {agents.length > 1 && !phone ? <GripVerticalIcon aria-hidden="true" className="size-3.5 shrink-0 cursor-grab text-muted-foreground" /> : null}
                <span className="min-w-0 flex-1 truncate">{agent.runner} · <b className="font-semibold">{labelOf(agent)}</b></span>
                <RoleSwitch
                  role={agent.role ?? 'main'}
                  label={label}
                  onChange={(role) => saveAgents(withRoles(agents).map((entry, at) => (at === index ? { ...entry, role } : entry)))}
                />
                <button
                  type="button"
                  aria-label={`Remove ${label}`}
                  className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:size-11"
                  onClick={() => saveAgents(agents.filter((_, at) => at !== index))}
                >
                  <XIcon aria-hidden="true" className="size-3.5" />
                </button>
              </li>
            )
          })}
        </ol>
      ) : null}
      <TaskRunnerPicker taskAgents={manager.taskAgents} {...(manager.taskRunner ? { taskRunner: manager.taskRunner } : {})} onChange={onPatch} className={FIELD} />
      {agents.length > 0 ? (
        <>
          <div role="radiogroup" aria-label="Start new tasks on Backup accounts when every Main account is" className="space-y-0.5">
            <p className="text-xs text-muted-foreground">Start new tasks on Backup accounts when every Main account is…</p>
            <Radio slot="manager-task-backup-when" checked={busyAt === undefined} onSelect={() => onPatch({ taskBusyAt: null })}>
              <b className="font-medium">Out of limits</b>
              <span className="block text-xs text-muted-foreground">Main accounts take every task they can; Backup only steps in once they’ve hit their usage limit.</span>
            </Radio>
            <Radio
              slot="manager-task-backup-when"
              checked={busyAt !== undefined}
              onSelect={() => onPatch({ taskBusyAt: busyAt ?? DEFAULT_BUSY_AT, ...(routed ? {} : { taskRunner: null, taskAgents: withRoles(agents) }) })}
            >
              <b className="font-medium">Out of limits or busy</b>
              <span className="block text-xs text-muted-foreground">Also use Backup while every Main account already runs this many tasks.</span>
            </Radio>
            {busyAt !== undefined ? (
              <label className="ml-7 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="whitespace-nowrap">Busy at</span>
                <IntegerStepper aria-label="Busy at this many running tasks" value={busyAt} min={1} max={64} onCommit={(next) => onPatch({ taskBusyAt: next ?? DEFAULT_BUSY_AT })} />
                <span className="whitespace-nowrap">tasks running</span>
              </label>
            ) : null}
          </div>
          <div role="radiogroup" aria-label="If a task runs out of limits mid-way" className="space-y-0.5">
            <p className="text-xs text-muted-foreground">If a task runs out of limits mid-way…</p>
            <Radio slot="manager-task-limit-switch" checked={limitSwitch === 'any'} onSelect={() => onPatch({ taskLimitSwitch: 'any' })}>
              <b className="font-medium">Finish it on another account from this list</b>
              <span className="block text-xs text-muted-foreground">Main first, then Backup. Same task, branch and history.</span>
            </Radio>
            <Radio slot="manager-task-limit-switch" checked={limitSwitch === 'same-agent'} onSelect={() => onPatch({ taskLimitSwitch: 'same-agent' })}>
              <b className="font-medium">Finish it on the same agent only</b>
              <span className="block text-xs text-muted-foreground">For example another Claude login. Never moves a Claude task to Codex.</span>
            </Radio>
            <Radio slot="manager-task-limit-switch" checked={limitSwitch === 'wait'} onSelect={() => onPatch({ taskLimitSwitch: 'wait' })}>
              <b className="font-medium">Wait for the reset</b>
              <span className="block text-xs text-muted-foreground">Pause and continue on the same account when its limit resets.</span>
            </Radio>
          </div>
        </>
      ) : null}
    </section>
  )
}
