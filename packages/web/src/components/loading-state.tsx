import { useEffect, useId, useState, type ReactNode } from 'react'

import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'

/** Under this, a local round trip has usually answered: showing nothing beats a flash. */
export const LOADING_REVEAL_DELAY_MS = 150

/** When a placeholder was last on screen. A wait handed from one loader to the next (a lazy
 *  chunk's fallback, then the route's own pending state) must not blink through a second delay. */
let lastOnScreen = Number.NEGATIVE_INFINITY

/** True once `delayMs` has passed since mount, or at once while another wait just showed. */
export function useDelayedReveal(delayMs = LOADING_REVEAL_DELAY_MS): boolean {
  const [shown, setShown] = useState(() => delayMs <= 0 || Date.now() - lastOnScreen < delayMs * 2)
  useEffect(() => {
    if (shown) return () => { lastOnScreen = Date.now() }
    const timer = setTimeout(() => setShown(true), delayMs)
    return () => clearTimeout(timer)
  }, [delayMs, shown])
  return shown
}

/**
 * The one loading region: a `status` named by its visually hidden label, `aria-busy`, and its
 * placeholder held `invisible` for the reveal delay — the space is reserved from the first
 * frame, so neither a fast answer nor a slow one shifts the layout.
 */
export function LoadingState({
  label,
  children,
  className,
  delayMs = LOADING_REVEAL_DELAY_MS,
  as: Tag = 'div',
  ...props
}: {
  label: string
  children?: ReactNode
  className?: string
  delayMs?: number
  as?: 'div' | 'li' | 'span'
} & Record<`data-${string}`, string | undefined>) {
  const shown = useDelayedReveal(delayMs)
  const labelId = useId()
  // Phrasing content stays phrasing: a span region holds a span placeholder.
  const Holder = Tag === 'span' ? 'span' : 'div'
  return (
    <Tag role="status" aria-busy="true" aria-labelledby={labelId} data-slot="loading-state" data-revealed={shown || undefined} className={className} {...props}>
      <span id={labelId} className="sr-only">{label}</span>
      <Holder aria-hidden="true" className={cn('contents', !shown && '[&>*]:invisible')}>
        {children ?? <Spinner className="mx-auto" />}
      </Holder>
    </Tag>
  )
}

/** A full-height wait with nothing to sketch yet (a redirect resolving, a lazy chunk). */
export function ScreenLoading({ label, className }: { label: string; className?: string }) {
  return (
    <LoadingState label={label} className={cn('flex min-h-full flex-1 items-center justify-center p-6', className)}>
      <Spinner className="size-5" />
    </LoadingState>
  )
}

const LINE_WIDTHS = ['w-11/12', 'w-4/5', 'w-2/3', 'w-3/4', 'w-1/2']

/** Paragraph-shaped lines, the last one short like a real paragraph's. */
export function LinesSkeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div data-slot="lines-skeleton" className={cn('flex flex-col gap-2', className)}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} className={cn('h-3.5', index === lines - 1 && lines > 1 ? 'w-2/5' : LINE_WIDTHS[index % LINE_WIDTHS.length])} />
      ))}
    </div>
  )
}

/** Avatar + name + preview rows, the shape of a manager or conversation list. */
export function ListSkeleton({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div data-slot="list-skeleton" className={cn('flex flex-col gap-0.5', className)}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex min-h-16 items-center gap-2.5 px-2 py-1.5">
          <Skeleton className="size-11 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex items-center gap-2">
              <Skeleton className={cn('h-3.5', index % 2 ? 'w-1/3' : 'w-2/5')} />
              <Skeleton className="ml-auto h-3 w-8" />
            </div>
            <Skeleton className={cn('h-3', index % 2 ? 'w-3/5' : 'w-4/5')} />
          </div>
        </div>
      ))}
    </div>
  )
}

/** Plain bordered rows, the shape of a settings list or a picker. */
export function RowsSkeleton({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div data-slot="rows-skeleton" className={cn('flex flex-col gap-2', className)}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex h-10 items-center gap-3 rounded-lg border border-border px-3">
          <Skeleton className={cn('h-3.5', LINE_WIDTHS[(index + 2) % LINE_WIDTHS.length], 'max-w-56')} />
          <Skeleton className="ml-auto h-3 w-12" />
        </div>
      ))}
    </div>
  )
}

/** A conversation: an assistant reply, the user's bubble, another reply. */
export function ChatSkeleton({ className }: { className?: string }) {
  return (
    <div data-slot="chat-skeleton" className={cn('flex flex-col gap-5', className)}>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-14" />
        <LinesSkeleton lines={3} />
      </div>
      <Skeleton className="h-10 w-3/5 self-end rounded-xl" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-14" />
        <LinesSkeleton lines={2} />
      </div>
    </div>
  )
}

/** A settings page: its heading, then a few cards of rows. */
export function SettingsSkeleton({ cards = 2, className }: { cards?: number; className?: string }) {
  return (
    <div data-slot="settings-skeleton" className={cn('flex flex-col gap-6 p-4 md:p-6', className)}>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-3.5 w-64 max-w-full" />
      </div>
      {Array.from({ length: cards }, (_, index) => (
        <div key={index} className="flex flex-col gap-3 rounded-xl border border-border p-4">
          <Skeleton className="h-4 w-32" />
          <LinesSkeleton lines={2} />
          <Skeleton className="h-9 w-full max-w-sm" />
        </div>
      ))}
    </div>
  )
}

/** Indented file rows: an icon and a name. */
export function TreeSkeleton({ rows = 3, indent = 24, className }: { rows?: number; indent?: number; className?: string }) {
  return (
    <div data-slot="tree-skeleton" className={cn('flex flex-col', className)} style={{ paddingLeft: indent }}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex h-6 items-center gap-1.5 px-1.5">
          <Skeleton className="size-3.5 shrink-0 rounded-sm" />
          <Skeleton className={cn('h-3', ['w-24', 'w-32', 'w-20'][index % 3])} />
        </div>
      ))}
    </div>
  )
}
