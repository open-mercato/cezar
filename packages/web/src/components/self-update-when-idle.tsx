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
  return !!target && data.activeRuns > 0 && data.scheduled?.target !== target
}

/** The "…when idle" twin of every restart button in the self-update dialog. `doing` finishes the
 *  tooltip's "Waits until no task is running or queued, then …". */
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
        <TooltipContent data-slot="update-when-idle-tooltip" side="bottom" className="max-w-64">
          Waits until no task is running or queued, then {doing} and restarts. Tasks waiting on your reply don&apos;t
          hold it up. You can close this window and keep working.
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
