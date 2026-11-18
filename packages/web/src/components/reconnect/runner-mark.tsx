import type { ProviderId } from '@open-mercato/cezar-api-client'

import { cn } from '@/lib/utils'

import { RUNNER_MARK } from './copy'

/** The agent's brand mark, as on the design page: a coloured tile with its monogram. */
export function RunnerMark({ provider, small = false, className }: { provider: ProviderId; small?: boolean; className?: string }) {
  const mark = RUNNER_MARK[provider]
  return (
    <span
      aria-hidden="true"
      data-slot="runner-mark"
      className={cn(
        'inline-grid shrink-0 place-items-center font-sans font-bold text-device-ink',
        mark.tile,
        small ? 'size-4 rounded-[4px] text-[9px]' : 'size-[22px] rounded-md text-xs',
        mark.ring && 'shadow-[inset_0_0_0_1px_rgba(255,255,255,.25)]',
        className,
      )}
    >
      {mark.mono}
    </span>
  )
}
