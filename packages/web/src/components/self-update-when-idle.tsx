import type { SelfUpdateStatus } from '@open-mercato/cezar-api-client'
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

/** What a restart is waiting for, in one phrase: `2 tasks (Fix login, Docs) and 1 manager (Ops)`.
 *  The server phrases each kind (`restartBlockers`); this only joins them. */
export function describeRestartBlockers(blockers: readonly string[]): string {
  return blockers.length <= 1 ? (blockers[0] ?? '') : `${blockers.slice(0, -1).join(', ')} and ${blockers.at(-1)}`
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
