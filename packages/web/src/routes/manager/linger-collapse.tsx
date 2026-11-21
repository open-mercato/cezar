import { useLayoutEffect, useRef, useState, type HTMLAttributes } from 'react'

import { cn } from '@/lib/utils'

import type { LeaveMode } from './approvals-linger'

/**
 * A lingering card's wrapper (useLinger). `fade`: it fades in place and the scroll takes up its
 * height once it is gone. `collapse`: its height and the gap before it shrink to nothing, so what
 * follows slides up instead of jumping. Reduced motion: no transition.
 */
export function LingerCollapse({ lingerKey, leaving, className, children, ...rest }: HTMLAttributes<HTMLDivElement> & { lingerKey?: string; leaving: LeaveMode | undefined }) {
  const collapse = leaving === 'collapse'
  const ref = useRef<HTMLDivElement>(null)
  const [gap, setGap] = useState(0)
  useLayoutEffect(() => {
    const parent = ref.current?.parentElement
    // A `contents` list is not the flex box: the gap lives on the nearest real container.
    const box = parent && getComputedStyle(parent).display === 'contents' ? parent.parentElement : parent
    if (collapse && box) setGap(Number.parseFloat(getComputedStyle(box).rowGap) || 0)
  }, [collapse])
  return (
    <div
      ref={ref}
      {...rest}
      data-linger-key={lingerKey}
      data-leaving={leaving}
      style={collapse && gap ? { marginTop: -gap } : undefined}
      className={cn(
        'grid grid-rows-[1fr] motion-safe:transition-[grid-template-rows,opacity,margin] motion-safe:duration-300',
        leaving && 'opacity-0',
        collapse && 'grid-rows-[0fr]',
        className,
      )}
    >
      <div className={cn('min-h-0', collapse && 'overflow-hidden')}>{children}</div>
    </div>
  )
}
