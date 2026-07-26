import { BotIcon, ChevronDownIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import type { PlanEntry, PlanStatus, ToolStatus } from '@/protocol/ui-events'
import { Chip } from '@/components/ui/chip'
import { cn } from '@/lib/utils'

import { activeSubagent, subagentActivityText, subagentCounts, type SubagentSummary } from './subagent-dock'

/**
 * The RunDock (spec §"Task thread", đợt redesign 2026): the agent's plan snapshot and the
 * current fan-out's sub-agents, merged into ONE dock pinned above the composer — two tabs
 * (Plan / Agents) instead of two stacked cards. Its 3px gradient strip is the app's single
 * brand moment (`--grad` lives in index.css and here only).
 *
 * Collapsed by default on every breakpoint; open, the list scrolls inside `max-h-64`.
 * The caller keys this component by run id, so the collapse default re-derives per task.
 */

type DockTab = 'plan' | 'agents'

/** Collapse memory per run id — a module-level map on purpose (the scroll-cache pattern):
 *  the choice survives route changes for the session without inventing server persistence. */
const openByRun = new Map<string, boolean>()

/** The "N/M" odometer math: completed entries over all entries the agent still
 *  intends to do. `cancelled` entries leave the denominator — they are work that
 *  was dropped on purpose, so counting them would strand the odometer below N/N
 *  for the rest of the run. They stay in the list (struck through), just not in
 *  the score. */
export function planCounts(entries: PlanEntry[]): { done: number; total: number } {
  return {
    done: entries.filter((entry) => entry.status === 'completed').length,
    total: entries.filter((entry) => entry.status !== 'cancelled').length,
  }
}

/** What the collapsed head names: the in-progress entry, else the next pending one. A fully
 *  completed plan has no current item — the odometer alone says it all. (`cancelled` is
 *  neither, so it is never named as the current item.) */
export function planActiveEntry(entries: PlanEntry[]): PlanEntry | undefined {
  return entries.find((entry) => entry.status === 'in_progress') ?? entries.find((entry) => entry.status === 'pending')
}

export function RunDock({
  runId,
  plan,
  agents,
  onSelectAgent,
}: {
  runId: string
  plan: PlanEntry[]
  agents: SubagentSummary[]
  /** Opens the sub-agent drill-down sheet. Absent ⇒ agent rows are static display. */
  onSelectAgent?: (id: string) => void
}) {
  const [open, setOpen] = useState(() => openByRun.get(runId) ?? false)
  const [picked, setPicked] = useState<DockTab | undefined>(undefined)
  const hasPlan = plan.length > 0
  const hasAgents = agents.length > 0
  if (!hasPlan && !hasAgents) return null

  const fallback: DockTab = hasAgents ? 'agents' : 'plan'
  const tab: DockTab = picked !== undefined && (picked === 'plan' ? hasPlan : hasAgents) ? picked : fallback

  const setOpenRemembered = (value: boolean) => {
    openByRun.set(runId, value)
    setOpen(value)
  }
  const selectTab = (next: DockTab) => {
    if (!open) {
      setOpenRemembered(true)
      setPicked(next)
      return
    }
    if (tab === next) {
      setOpenRemembered(false)
      return
    }
    setPicked(next)
  }

  const planTally = planCounts(plan)
  const agentTally = subagentCounts(agents)
  const currentAgent = activeSubagent(agents)
  const currentEntry = planActiveEntry(plan)
  const current =
    tab === 'agents'
      ? currentAgent !== undefined
        ? subagentActivityText(currentAgent)
        : undefined
      : currentEntry !== undefined
        ? (currentEntry.activeForm ?? currentEntry.content)
        : undefined

  return (
    <section
      data-slot="run-dock"
      data-state={open ? 'open' : 'collapsed'}
      className="min-w-0 overflow-hidden rounded-lg border border-border bg-card shadow-xs"
    >
      {/* The ONE brand moment: the gradient as a hairline top edge (spec §2.6). */}
      <div aria-hidden data-slot="grad-edge" className="h-[3px]" style={{ background: 'var(--grad)' }} />
      <div className="flex w-full min-w-0 items-center gap-1 px-2 py-1">
        {hasPlan ? (
          <DockTabButton active={tab === 'plan'} onClick={() => selectTab('plan')}>
            Plan
            <span data-slot="plan-count" className="font-normal text-muted-foreground tabular-nums">
              {planTally.done}/{planTally.total}
            </span>
          </DockTabButton>
        ) : null}
        {hasAgents ? (
          <DockTabButton active={tab === 'agents'} onClick={() => selectTab('agents')}>
            <BotIcon aria-hidden className="size-3.5 shrink-0 text-soft-foreground" />
            Agents
            <span data-slot="agents-count" className="font-normal text-muted-foreground tabular-nums">
              {agentTally.done}/{agentTally.total}
            </span>
          </DockTabButton>
        ) : null}
        {!open && current !== undefined ? (
          <span data-slot="run-dock-current" className="min-w-0 truncate text-sm text-muted-foreground">
            — {current}
          </span>
        ) : null}
        <button
          type="button"
          data-slot="run-dock-toggle"
          aria-expanded={open}
          aria-label="Toggle the run dock"
          onClick={() => setOpenRemembered(!open)}
          className="ml-auto flex size-7 shrink-0 items-center justify-center rounded-sm text-soft-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
        >
          <ChevronDownIcon aria-hidden className={cn('size-3.5 transition-transform', !open && 'rotate-180')} />
        </button>
      </div>
      {open ? (
        tab === 'plan' ? (
          <ul data-slot="plan-list" className="flex max-h-64 flex-col gap-2 overflow-y-auto px-3.5 pt-1 pb-3">
            {plan.map((entry, index) => (
              <PlanRow key={`${index}:${entry.content}`} entry={entry} />
            ))}
          </ul>
        ) : (
          <ul data-slot="agents-list" className="flex max-h-64 flex-col gap-2 overflow-y-auto px-3.5 pt-1 pb-3">
            {agents.map((agent) => (
              <AgentRow key={agent.id} agent={agent} onSelect={onSelectAgent} />
            ))}
          </ul>
        )
      ) : null}
    </section>
  )
}

function DockTabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      data-slot="run-dock-tab"
      data-active={active ? 'true' : 'false'}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'flex h-7 shrink-0 items-center gap-1.5 rounded-sm px-2 text-sm font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset',
        active ? 'text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

function PlanRow({ entry }: { entry: PlanEntry }) {
  return (
    <li
      data-slot="plan-item"
      data-status={entry.status}
      className={cn(
        'flex min-h-5 min-w-0 items-center gap-2.5 text-sm',
        entry.status === 'completed' && 'text-soft-foreground line-through',
        entry.status === 'in_progress' && 'font-medium',
        entry.status === 'pending' && 'text-muted-foreground',
        // Struck through like a done row, but faded further: abandoned, not achieved.
        entry.status === 'cancelled' && 'text-soft-foreground/70 line-through',
      )}
    >
      <PlanIcon status={entry.status} />
      <span className="min-w-0 truncate">{entry.content}</span>
      {entry.status === 'in_progress' ? <span className="sr-only">in progress</span> : null}
    </li>
  )
}

/** Rows keep stream order and never re-sort on completion — a finishing agent must not make
 *  the row the user is reading jump somewhere else (spec §Edge Cases). */
function AgentRow({ agent, onSelect }: { agent: SubagentSummary; onSelect?: (id: string) => void }) {
  const body = (
    <>
      <AgentIcon status={agent.status} stalled={agent.stalled === true} />
      <span className="min-w-0 shrink truncate font-medium">{agent.title}</span>
      {agent.agentType !== undefined ? (
        <Chip data-slot="agent-type" size="sm">
          {agent.agentType}
        </Chip>
      ) : null}
      <span data-slot="agent-activity" className="min-w-0 flex-1 truncate text-muted-foreground">
        {subagentActivityText(agent)}
      </span>
      <span data-slot="agent-tools" className="shrink-0 text-muted-foreground tabular-nums">
        {agent.toolCalls} {agent.toolCalls === 1 ? 'tool' : 'tools'}
      </span>
    </>
  )

  return (
    <li data-slot="agent-item" data-status={agent.status} className="min-w-0 text-sm">
      {onSelect ? (
        <button
          type="button"
          onClick={() => onSelect(agent.id)}
          aria-haspopup="dialog"
          className="flex min-h-7 w-full min-w-0 items-center gap-2.5 rounded-sm text-left outline-none hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
        >
          {body}
        </button>
      ) : (
        <div className="flex min-h-7 min-w-0 items-center gap-2.5">{body}</div>
      )}
    </li>
  )
}

/** The mockup's three checkbox glyphs, verbatim paths: ✓ in a faint circle / a pulsing
 *  half-filled ◐ / an empty ○ — plus a ⊘ for `cancelled`, which the mockup predates.
 *  Inline because lucide has no half-filled circle. */
function PlanIcon({ status }: { status: PlanStatus }) {
  if (status === 'cancelled') {
    return (
      <svg
        aria-hidden
        className="size-4 shrink-0 text-soft-foreground/70"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <circle cx="12" cy="12" r="8.5" opacity=".5" />
        <path d="m8.5 15.5 7-7" />
      </svg>
    )
  }
  if (status === 'completed') {
    return (
      <svg
        aria-hidden
        className="size-4 shrink-0 text-success"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="9" opacity=".35" />
        <path d="m8.5 12.2 2.4 2.4 4.6-5" />
      </svg>
    )
  }
  if (status === 'in_progress') {
    return (
      <svg aria-hidden className="size-4 shrink-0 animate-pulse motion-reduce:animate-none" viewBox="0 0 24 24" fill="none">
        {/* stroke/fill-pending, not text-*: amber is a dot & spinner color only (guardian rule). */}
        <circle className="stroke-pending" cx="12" cy="12" r="8.5" strokeWidth="2" />
        <path className="fill-pending" d="M12 3.5 A8.5 8.5 0 0 1 12 20.5 Z" />
      </svg>
    )
  }
  return (
    <svg
      aria-hidden
      className="size-4 shrink-0 text-soft-foreground"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="12" cy="12" r="8.5" />
    </svg>
  )
}

/**
 * The plan rows' glyph language, so the two tabs read as one system: a pulsing half-disc
 * while working, a ✓ when done, a ✕ when not. Status is never color-only — the shapes differ,
 * which is what makes the dock legible to a color-blind reader (spec §Accessibility).
 */
function AgentIcon({ status, stalled = false }: { status: ToolStatus; stalled?: boolean }) {
  // The run ended while this agent was still in flight: it never finished and never will.
  // Shown as an interrupted ring — NOT the pulsing "working" glyph (it is not working) and not
  // a ✓ (it did not succeed). The status itself is left untouched; only the reading changes.
  if (stalled) {
    return (
      <svg
        aria-hidden
        data-slot="agent-glyph"
        data-stalled="true"
        className="size-4 shrink-0 text-soft-foreground"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="3 2.5"
      >
        <circle cx="12" cy="12" r="8.5" />
      </svg>
    )
  }
  if (status === 'completed') {
    return (
      <svg
        aria-hidden
        data-slot="agent-glyph"
        className="size-4 shrink-0 text-success"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="9" opacity=".35" />
        <path d="m8.5 12.2 2.4 2.4 4.6-5" />
      </svg>
    )
  }
  if (status === 'failed' || status === 'declined') {
    return (
      <svg
        aria-hidden
        data-slot="agent-glyph"
        className="size-4 shrink-0 text-danger"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <circle cx="12" cy="12" r="9" opacity=".35" />
        <path d="m9 9 6 6M15 9l-6 6" />
      </svg>
    )
  }
  return (
    <svg
      aria-hidden
      data-slot="agent-glyph"
      className="size-4 shrink-0 animate-pulse motion-reduce:animate-none"
      viewBox="0 0 24 24"
      fill="none"
    >
      {/* stroke/fill-pending, not text-*: amber is a dot & spinner color only (guardian rule). */}
      <circle className="stroke-pending" cx="12" cy="12" r="8.5" strokeWidth="2" />
      <path className="fill-pending" d="M12 3.5 A8.5 8.5 0 0 1 12 20.5 Z" />
    </svg>
  )
}
