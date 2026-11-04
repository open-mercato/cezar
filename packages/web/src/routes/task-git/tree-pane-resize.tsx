import * as React from 'react'

import {
  TREE_PANE_WIDTH_STEP,
  TREE_PANE_WIDTH_STORAGE_KEY,
  MAX_TREE_PANE_WIDTH,
  MIN_TREE_PANE_WIDTH,
  clampTreePaneWidth,
  readStoredTreePaneWidth,
  writeStoredTreePaneWidth,
} from '@/lib/tree-pane-width'
import { cn } from '@/lib/utils'

/**
 * The file-tree column's draggable width — ONE preference for the task Changes and Files tabs and
 * the repo Changes view.
 *
 * An external store over `localStorage`, like `useSidebarWidth`, so both views (and other tabs)
 * stay on one number. `null` means "never dragged": the column keeps its responsive CSS widths.
 */
const listeners = new Set<() => void>()
/** The width set while storage refused to keep it (private mode), so a drag still applies. */
let unsaved: number | null | undefined

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== TREE_PANE_WIDTH_STORAGE_KEY) return
    unsaved = undefined
    listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

function read(): number | null {
  return unsaved === undefined ? readStoredTreePaneWidth() : unsaved
}

function write(next: number | null): void {
  writeStoredTreePaneWidth(next)
  unsaved = readStoredTreePaneWidth() === next ? undefined : next
  for (const listener of listeners) listener()
}

export function useTreePaneWidth(): [number | null, (width: number | null) => void] {
  return [React.useSyncExternalStore(subscribe, read, read), write]
}

/** What a tree pane takes for a dragged width: a variable applied from `md` up only (below it the
 *  pane is hidden or full-width), `!` so it beats the responsive and container-query widths. */
export function treePaneWidthProps(width: number | null): { style?: React.CSSProperties; className?: string } {
  if (width === null) return {}
  return { style: { '--tree-pane-width': `${width}px` } as React.CSSProperties, className: 'md:w-(--tree-pane-width)!' }
}

/**
 * The splitter between the tree and the diff: an ARIA window splitter (the sidebar handle's
 * pattern, #788) — drag, arrow keys, Home/End, double-click to reset to the responsive default.
 *
 * A zero-width flex SIBLING of the pane, not a child: the pane is a scroller, and an absolute
 * child would scroll away with the files. `-mr-5` cancels the extra `gap-5` it adds, and the grab
 * strip is centred in the original gap.
 */
export function TreePaneResizeHandle({
  paneRef,
  width,
  onWidthChange,
  className,
}: {
  /** The tree pane — its rendered width is where a drag starts while no width is stored. */
  paneRef: React.RefObject<HTMLElement | null>
  width: number | null
  onWidthChange: (width: number | null) => void
  /** Visibility classes — the handle shows exactly when the pane does. */
  className?: string
}) {
  const origin = React.useRef<{ x: number; width: number } | null>(null)

  const current = () => width ?? Math.round(paneRef.current?.getBoundingClientRect().width ?? 0)
  // jsdom (and a detached pane) measures 0: no body-relative cap then, only the fixed bounds.
  const clamp = (next: number) =>
    clampTreePaneWidth(next, paneRef.current?.parentElement?.clientWidth || Number.POSITIVE_INFINITY)

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    origin.current = { x: event.clientX, width: current() }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
    event.currentTarget.focus()
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = origin.current
    if (!start) return
    onWidthChange(clamp(start.width + (event.clientX - start.x)))
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!origin.current) return
    origin.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const next =
      event.key === 'ArrowLeft'
        ? current() - TREE_PANE_WIDTH_STEP
        : event.key === 'ArrowRight'
          ? current() + TREE_PANE_WIDTH_STEP
          : event.key === 'Home'
            ? MIN_TREE_PANE_WIDTH
            : event.key === 'End'
              ? MAX_TREE_PANE_WIDTH
              : null
    if (next === null) return
    event.preventDefault()
    onWidthChange(clamp(next))
  }

  return (
    <div data-slot="tree-pane-resize" className={cn('relative -mr-5 w-0 shrink-0', className)}>
      <div
        data-slot="tree-pane-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the file tree"
        aria-valuenow={width ?? undefined}
        aria-valuemin={MIN_TREE_PANE_WIDTH}
        aria-valuemax={MAX_TREE_PANE_WIDTH}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        onDoubleClick={() => onWidthChange(null)}
        title="Drag to resize the file tree — double-click to reset"
        // `touch-none`: without it a touch drag pans the page instead of resizing.
        className="absolute inset-y-0 -left-[14px] z-10 w-2 cursor-col-resize touch-none rounded-full bg-transparent transition-colors hover:bg-violet/40 focus-visible:bg-violet/60 focus-visible:outline-none"
      />
    </div>
  )
}
