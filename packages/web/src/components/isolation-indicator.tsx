import { ContainerIcon, ShieldAlertIcon } from 'lucide-react'

import type { ApiRun } from '@open-mercato/cezar-api-client'
import { cn } from '@/lib/utils'

/**
 * Where a task's agent actually ran: in a container, or on this machine.
 *
 * Read from `run.isolation`, which the engine writes when it makes the
 * decision — NOT from `run.isolated`, which is only what the composer asked
 * for. The two disagree whenever a container was wanted and not obtained (a
 * stopped VM, a runner with no launcher, a failed build), and that is exactly
 * the case where a wrong indicator costs something: a person reads "isolated"
 * and hands the task a job they would not have given an agent on their laptop.
 *
 * Three states, because "not isolated" splits into two that need different
 * words:
 *
 *  - **isolated** — a container was brought up. Shown as a chip, since this is
 *    the claim worth making.
 *  - **fell back** — isolation was wanted and missed. Shown in a warning tone
 *    with the reason, because it is the only state a person might want to act
 *    on, and the run log's one-line note scrolls away.
 *  - **host** — nobody asked. Shown as plain muted text in the header and
 *    omitted entirely from list rows: a chip on every ordinary task would be
 *    noise on the majority of rows and would say nothing new.
 *
 * A run from before this was recorded has no `isolation` at all, and is
 * rendered as nothing rather than guessed at.
 */
export type IsolationState = 'isolated' | 'fell-back' | 'host' | 'unknown'

/** Only the field this reads, and optional: every run type in the app carries it
 *  as optional, and a required `Pick` would reject all of them. */
type RunIsolation = { isolation?: ApiRun['isolation'] }

export function isolationStateOf(run: RunIsolation): IsolationState {
  if (!run.isolation) return 'unknown'
  if (run.isolation.effective) return 'isolated'
  return run.isolation.reason ? 'fell-back' : 'host'
}

/** The full chip, for surfaces that own a task (the thread header). */
export function IsolationBadge({ run, className }: { run: RunIsolation; className?: string }) {
  const state = isolationStateOf(run)
  if (state === 'unknown') return null

  if (state === 'host') {
    return (
      <span
        data-slot="isolation-badge"
        data-isolation="host"
        title="The agent ran on this machine, with your own credentials and access"
        className={cn('flex shrink-0 items-center gap-1 text-[11px] text-soft-foreground', className)}
      >
        <ContainerIcon className="size-3.5" aria-hidden="true" />
        <span className="font-mono">host</span>
      </span>
    )
  }

  const isolated = state === 'isolated'
  return (
    <span
      data-slot="isolation-badge"
      data-isolation={isolated ? 'isolated' : 'fell-back'}
      title={
        isolated
          ? `The agent ran inside a container${run.isolation?.container ? ` (${run.isolation.container})` : ''}`
          : `Isolation was requested but not used — ${run.isolation?.reason ?? 'reason not recorded'}`
      }
      className={cn(
        'flex shrink-0 items-center gap-1 text-[11px]',
        isolated ? 'text-success' : 'text-warning',
        className,
      )}
    >
      {isolated ? (
        <ContainerIcon className="size-3.5" aria-hidden="true" />
      ) : (
        <ShieldAlertIcon className="size-3.5" aria-hidden="true" />
      )}
      <span className="font-mono">{isolated ? 'isolated' : 'not isolated'}</span>
    </span>
  )
}

/**
 * The icon alone, for list rows.
 *
 * Nothing is rendered for an ordinary host run: the sidebar's width-priority
 * rule spends its pixels on the task's NAME, and a marker on every row would
 * buy no information — absence already means "on this machine", and the header
 * says it in words for anyone who opens the task.
 */
export function IsolationMark({ run, className }: { run: RunIsolation; className?: string }) {
  const state = isolationStateOf(run)
  if (state !== 'isolated' && state !== 'fell-back') return null
  const isolated = state === 'isolated'
  return (
    <span
      data-slot="isolation-mark"
      data-isolation={isolated ? 'isolated' : 'fell-back'}
      role="img"
      aria-label={isolated ? 'Ran in a container' : 'Isolation requested but not used'}
      title={
        isolated
          ? `Ran in a container${run.isolation?.container ? ` (${run.isolation.container})` : ''}`
          : `Isolation was requested but not used — ${run.isolation?.reason ?? 'reason not recorded'}`
      }
      className={cn('shrink-0', isolated ? 'text-success' : 'text-warning', className)}
    >
      {isolated ? (
        <ContainerIcon className="size-3.5" aria-hidden="true" />
      ) : (
        <ShieldAlertIcon className="size-3.5" aria-hidden="true" />
      )}
    </span>
  )
}
