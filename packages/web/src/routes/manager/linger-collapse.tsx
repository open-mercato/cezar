import { useLayoutEffect, useRef, useState, type HTMLAttributes } from 'react'

import { cn } from '@/lib/utils'

/**
 * A lingering card's wrapper: on `leaving` its height and the gap before it collapse to nothing,
 * so what follows slides up instead of jumping (useLinger). Reduced motion: no transition.
 */
export function LingerCollapse({ lingerKey, leaving, className, children, ...rest }: HTMLAttributes<HTMLDivElement> & { lingerKey?: string; leaving: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const [gap, setGap] = useState(0)
  useLayoutEffect(() => {
    const parent = ref.current?.parentElement
    // A `contents` list is not the flex box: the gap lives on the nearest real container.
    const box = parent && getComputedStyle(parent).display === 'contents' ? parent.parentElement : parent
    if (leaving && box) setGap(Number.parseFloat(getComputedStyle(box).rowGap) || 0)
  }, [leaving])
  return (
    <div
      ref={ref}
      {...rest}
      data-linger-key={lingerKey}
      data-leaving={leaving || undefined}
      style={leaving && gap ? { marginTop: -gap } : undefined}
      className={cn(
        'grid grid-rows-[1fr] motion-safe:transition-[grid-template-rows,opacity,margin] motion-safe:duration-300',
        leaving && 'grid-rows-[0fr] opacity-0',
        className,
      )}
    >
      <div className={cn('min-h-0', leaving && 'overflow-hidden')}>{children}</div>
    </div>
  )
}
