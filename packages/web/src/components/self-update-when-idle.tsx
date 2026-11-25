import type { RestartBlocker, SelfUpdateStatus } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

/** How a target reads in prose: registry versions get a `v`, installed/linked ids
 *  (`0.13.0+cez-abc`, `0.12.0+local`) stay as they are. */
export function targetName(target: string): string {
  return /^\d/.test(target) && !target.includes('+') ? `v${target}` : target
}

/** Whether "…when idle" is worth offering for `target`: only while a restart would interrupt
 *  something (idle, it applies at once), and not for the target already scheduled. */
export function offerWhenIdle(data: SelfUpdateStatus, target: string | null): target is string {
  return !!target && data.restartBlockers.length > 0 && data.scheduled?.target !== target
}

const KIND_NOUN: Record<RestartBlocker['kind'], [string, string]> = {
  task: ['task', 'tasks'],
  manager: ['manager', 'managers'],
  setup: ['agent setup', 'agent setups'],
}

/** What a restart is waiting for, in one phrase: `2 tasks (Fix login, Docs) and 1 manager (Ops)`. */
export function describeRestartBlockers(blockers: readonly RestartBlocker[]): string {
  const parts = blockers.map(({ kind, count, names }) => {
    const [one, many] = KIND_NOUN[kind]
    const more = count - names.length
    const listed = names.length > 0 ? ` (${names.join(', ')}${more > 0 ? ` and ${more} more` : ''})` : ''
    return `${count} ${count === 1 ? one : many}${listed}`
  })
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

/** The "…when idle" twin of every restart button in the self-update dialog. `doing` finishes the
 *  one-line tooltip "Waits until no task or manager is working, then …"; the longer reassurance
 *  ("tasks waiting on your reply don't hold it up") lives in the dialog copy, not the tooltip. */
export function WhenIdleButton({
  label = 'Update when idle',
  doing,
  onClick,
  disabled,
}: {
  label?: string
  doing: string
  onClick: () => void
  disabled: boolean
}) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" size="sm" onClick={onClick} disabled={disabled}>
            {label}
          </Button>
        </TooltipTrigger>
        <TooltipContent data-slot="update-when-idle-tooltip" side="bottom">
          Waits until no task or manager is working, then {doing} and restarts
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
