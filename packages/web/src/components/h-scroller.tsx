import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * A horizontal strip that scrolls with BUTTONS, not a hairline scrollbar
 * (user feedback 2026-07-27).
 *
 * The native overflow scrollbar was unusable in practice: on macOS it renders as
 * a 3px overlay track that only takes the pointer within a couple of pixels of
 * its top edge, so "scroll the tabs" meant hunting for a target thinner than the
 * cursor. And because the container could scroll on BOTH axes, the browser also
 * drew a scrollbar corner — the stray square at the end of the strip.
 *
 * So: the scrollbar is hidden, the y axis is pinned, and overflow is expressed
 * as arrow buttons with a fade at each end. The buttons appear only when there
 * is somewhere to go, wheel/trackpad and keyboard scrolling still work, and the
 * strip re-measures on resize and on content changes.
 */
export function HScroller({
  children,
  className,
  contentClassName,
  ariaLabel,
  step = 200,
  ...rest
}: {
  children: ReactNode
  className?: string
  contentClassName?: string
  ariaLabel?: string
  step?: number
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'children' | 'className'>) {
  const ref = useRef<HTMLDivElement>(null)
  const [atStart, setAtStart] = useState(true)
  const [atEnd, setAtEnd] = useState(true)

  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    const max = el.scrollWidth - el.clientWidth
    setAtStart(el.scrollLeft <= 1)
    setAtEnd(el.scrollLeft >= max - 1)
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    for (const child of Array.from(el.children)) observer.observe(child)
    return () => observer.disconnect()
  }, [measure, children])

  const nudge = (direction: -1 | 1) => {
    ref.current?.scrollBy({ left: direction * step, behavior: 'smooth' })
  }

  const scrollable = !(atStart && atEnd)

  return (
    <div className={cn('relative flex min-w-0 items-end', className)} {...rest}>
      {scrollable ? (
        <ScrollArrow side="left" disabled={atStart} onClick={() => nudge(-1)} />
      ) : null}
      <div
        ref={ref}
        onScroll={measure}
        aria-label={ariaLabel}
        className={cn(
          'flex min-w-0 flex-1 items-end gap-1 overflow-x-auto overflow-y-hidden scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          contentClassName,
        )}
      >
        {children}
      </div>
      {scrollable ? (
        <ScrollArrow side="right" disabled={atEnd} onClick={() => nudge(1)} />
      ) : null}
    </div>
  )
}

function ScrollArrow({
  side,
  disabled,
  onClick,
}: {
  side: 'left' | 'right'
  disabled: boolean
  onClick: () => void
}) {
  const Icon = side === 'left' ? ChevronLeftIcon : ChevronRightIcon
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-hidden="true"
      data-slot={`h-scroller-${side}`}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'z-10 mb-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-opacity',
        'hover:bg-muted hover:text-foreground',
        disabled ? 'pointer-events-none opacity-0' : 'opacity-100',
        side === 'left' ? 'mr-0.5' : 'ml-0.5',
      )}
    >
      <Icon aria-hidden="true" className="size-4" />
    </button>
  )
}
