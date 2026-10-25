import type { ReactElement, ReactNode } from 'react'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

/**
 * The tooltip an icon-only button wears in place of a native `title`: an icon says nothing on its
 * own, and the browser's title bubble is slow, unstyled and absent on keyboard focus. The child
 * must forward a ref (every `Button` and Radix trigger does) — it becomes the trigger itself.
 * Keep the child's `aria-label`: the tooltip is for sighted pointer and keyboard users, the label
 * is the accessible name.
 */
export function IconTooltip({
  label,
  side = 'bottom',
  children,
}: {
  label: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  children: ReactElement
}) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side} sideOffset={6} data-slot="icon-tooltip">
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
