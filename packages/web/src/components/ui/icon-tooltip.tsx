import type { ReactElement, ReactNode } from 'react'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

/**
 * THE one tooltip wrapper of the cockpit — the shape every control wears in place of a native
 * `title`: an icon says nothing on its own, and the browser's title bubble is slow, unstyled and
 * absent on keyboard focus. The child must forward a ref (every `Button`, `Link` and Radix trigger
 * does) — it becomes the trigger itself. Keep the child's `aria-label`: the tooltip is for sighted
 * pointer and keyboard users, the label is the accessible name.
 *
 * Contract (see `TooltipContent`): `label` is ONE sentence-case line. A multi-line explanation is
 * a `Popover`. Native `title=` stays only on links to external sites.
 */
export function IconTooltip({
  label,
  side = 'bottom',
  delay = 300,
  children,
}: {
  label: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  /** Hover delay in ms; 300 keeps a row of icons from flickering as the pointer crosses it. */
  delay?: number
  children: ReactElement
}) {
  return (
    <TooltipProvider delayDuration={delay}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side} sideOffset={6} data-slot="icon-tooltip">
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
