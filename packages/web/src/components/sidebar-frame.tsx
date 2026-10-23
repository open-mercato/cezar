import { XIcon } from 'lucide-react'
import * as React from 'react'
import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { SheetClose, SheetContent, SheetTitle } from '@/components/ui/sheet'
import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  SIDEBAR_WIDTH_STEP,
  SIDEBAR_WIDTH_STORAGE_KEY,
  clampSidebarWidth,
  readStoredSidebarWidth,
  writeStoredSidebarWidth,
} from '@/lib/sidebar-width'
import { cn } from '@/lib/utils'

/**
 * The sidebar's two FRAMES, shared by every sidebar the cockpit has — the app's (nav, task
 * quick-list, footer) and the settings one (spec 2026-10-13-unified-settings). The content
 * differs; the box around it must not: same column, same resize handle and persisted width,
 * same desktop title-bar padding, same drawer below `md`. Keeping the frame in one place is
 * what stops the two sidebars from drifting apart — the settings column shipped without the
 * resize handle for exactly that reason, as a copy that predated #788.
 *
 *  - `useSidebarWidth` — the user's column width, read once from `localStorage` and persisted
 *    on every change (#788). ONE width for every sidebar: the preference is about the screen
 *    someone sits at, not about which nav is in the column.
 *  - `SidebarFrame` — the desktop `<aside>`, from `md` up, with the drag handle on its right
 *    border.
 *  - `SidebarDrawer` — the `<md` overlay for the SAME content (Radix Sheet: dialog role, focus
 *    trap, Escape, backdrop dismiss). The caller owns the `Sheet` root and its open state, so
 *    the trigger can live wherever its top bar is.
 *  - `useDesktopShell` — which desktop shell hosts the page, for the macOS title-bar padding.
 */

export type DesktopShell = 'macos' | 'windows' | 'linux' | null

/** Which desktop shell hosts this page, read once from the init script's `data-cez-desktop`
 *  (packages/desktop). Null in every browser. */
export function useDesktopShell(): DesktopShell {
  const [platform] = React.useState<DesktopShell>(() => {
    if (typeof document === 'undefined') return null
    const value = document.documentElement.dataset.cezDesktop
    return value === 'macos' || value === 'windows' || value === 'linux' ? value : null
  })
  return platform
}

export type SidebarResize = {
  width: number
  onWidthChange: (width: number) => void
}

/**
 * The desktop column's width (#788) — ONE value for every sidebar instance, live.
 *
 * The app shell's column and the settings column are different components mounted at different
 * times, and the app shell stays mounted while settings is open. A per-instance `useState` seeded
 * from `localStorage` therefore showed the settings drag only after a reload: the app shell's
 * instance still held its mount-time value. So the width is an external store — `localStorage`
 * is the source of truth, every write notifies every subscriber, and `useSyncExternalStore`
 * keeps each mounted column on the same number. A `storage` event from another tab is one more
 * notification. Primitives compare by value, so re-reading storage as the snapshot is stable.
 *
 * Persisted on every change rather than on drag end: a drag is a stream of small writes to one
 * key, which localStorage is fine with, and it means a tab closed mid-drag still remembers.
 */
const widthListeners = new Set<() => void>()

function subscribeSidebarWidth(listener: () => void): () => void {
  widthListeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== SIDEBAR_WIDTH_STORAGE_KEY) return
    // Another tab wrote a width the store could keep — it wins over any unsaved local one.
    unsavedWidth = null
    listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    widthListeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

/** The width the user set when storage refused to keep it (private mode, quota, disabled).
 *  Served instead of the stored value so a drag still applies for this page — the promise
 *  `writeStoredSidebarWidth` makes. Null whenever storage holds what was last written. */
let unsavedWidth: number | null = null

function readSidebarWidth(): number {
  return unsavedWidth ?? readStoredSidebarWidth()
}

function setSidebarWidth(next: number): void {
  const width = clampSidebarWidth(next)
  writeStoredSidebarWidth(width)
  unsavedWidth = readStoredSidebarWidth() === width ? null : width
  for (const listener of widthListeners) listener()
}

export function useSidebarWidth(): [number, (width: number) => void] {
  const width = React.useSyncExternalStore(subscribeSidebarWidth, readSidebarWidth, readSidebarWidth)
  return [width, setSidebarWidth]
}

/**
 * The desktop frame, from `md` up — 264px by default and draggable up to 420px (#788).
 *
 * An inline `width` rather than a Tailwind class because the value is a number from state, and
 * the class is left off entirely below `md`, where `hidden` takes the element out of flow and the
 * drawer (a fixed 264px) is the sidebar instead. On the macOS desktop shell the column carries
 * 28px of top padding so its own colour runs to the window's edge under the transparent title
 * bar, the way Finder's sidebar does.
 */
export function SidebarFrame({
  slot = 'sidebar',
  width,
  onWidthChange,
  titlebarInset = false,
  children,
}: SidebarResize & {
  /** The `data-slot` the tests and e2e address this column by. */
  slot?: string
  /** 28px of top padding under the macOS desktop shell's transparent title bar. The app
   *  sidebar needs it; the settings column renders inside the main region, which already sits
   *  below that strip, so it does not. */
  titlebarInset?: boolean
  children: ReactNode
}) {
  return (
    <aside
      data-slot={slot}
      style={{ width }}
      className={cn(
        'relative hidden shrink-0 flex-col border-r border-border bg-sidebar md:flex',
        titlebarInset && 'pt-[28px]',
      )}
    >
      {children}
      <SidebarResizeHandle width={width} onWidthChange={onWidthChange} />
    </aside>
  )
}

/**
 * The drag handle on the sidebar's right border (#788).
 *
 * A `separator` with `aria-orientation="vertical"` — the ARIA window-splitter pattern — which is
 * the one role that is BOTH focusable and carries a value range, so the same affordance serves a
 * pointer and a keyboard. Arrow keys step it, Home/End go to the bounds, and a double-click puts
 * it back to the default, which is the cheap way out of a width you dragged by accident.
 *
 * Pointer capture rather than window listeners: the drag must survive the pointer leaving a 5px
 * hit area (it will, immediately, on any real drag), and capture is how the browser keeps
 * delivering the moves to this element without us installing and remembering to remove global
 * handlers. `touch-none` stops a touch-drag from scrolling the page instead of resizing — the
 * handle is `md`-only, but `md` includes touch laptops and tablets.
 *
 * Rendered inside the `<aside>` and absolutely positioned over its border, so it inherits the
 * column's height without a second element having to track it.
 */
function SidebarResizeHandle({ width, onWidthChange }: SidebarResize) {
  // The width the drag started from, plus the pointer x it started at. Refs, not state: they
  // change on every pointermove and nothing renders from them.
  const origin = React.useRef<{ x: number; width: number } | null>(null)

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    // Primary button only — a right-click on the border must not start a resize.
    if (event.button !== 0) return
    origin.current = { x: event.clientX, width }
    event.currentTarget.setPointerCapture(event.pointerId)
    // Without this the drag selects the sidebar's text as it passes over it.
    event.preventDefault()
    // …but preventing the default also suppresses the focus the press would have given a
    // `tabIndex=0` element, which would leave someone who grabbed the handle with a mouse unable
    // to fine-tune with the arrow keys immediately afterwards. Focus it explicitly instead.
    event.currentTarget.focus()
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = origin.current
    if (!start) return
    onWidthChange(clampSidebarWidth(start.width + (event.clientX - start.x)))
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
        ? width - SIDEBAR_WIDTH_STEP
        : event.key === 'ArrowRight'
          ? width + SIDEBAR_WIDTH_STEP
          : event.key === 'Home'
            ? MIN_SIDEBAR_WIDTH
            : event.key === 'End'
              ? MAX_SIDEBAR_WIDTH
              : null
    if (next === null) return
    // Only for the keys we handled: Tab, Escape and the rest stay the browser's.
    event.preventDefault()
    onWidthChange(clampSidebarWidth(next))
  }

  return (
    <div
      data-slot="sidebar-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the sidebar"
      aria-valuenow={width}
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={MAX_SIDEBAR_WIDTH}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onWidthChange(DEFAULT_SIDEBAR_WIDTH)}
      title="Drag to resize the sidebar — double-click to reset"
      // A 5px grab strip straddling the border, invisible until you reach for it. `touch-none`
      // is load-bearing rather than decorative: without it a touch drag is claimed by the
      // browser's own panning and scrolls the page instead of resizing the column.
      className="absolute inset-y-0 -right-[2px] z-20 w-[5px] cursor-col-resize touch-none bg-transparent transition-colors hover:bg-violet/40 focus-visible:bg-violet/60 focus-visible:outline-none"
    />
  )
}

/**
 * The `<md` frame for the *same* content the desktop column renders — the spec's mobile rule is
 * that the sidebar "becomes an overlay drawer", not that mobile gets its own nav.
 *
 * Radix's Dialog (via the Sheet primitive) supplies the parts that are easy to get wrong by hand:
 * `role="dialog"`, the accessible name, the focus trap, the Escape handler, the backdrop's
 * dismiss-on-tap, and `aria-hidden` on everything outside the portal — which is how it delivers
 * modality (it does not set `aria-modal`; `hideOthers` is the stronger guarantee).
 *
 * The drawer keeps its fixed 264px: it is a full-height overlay on a phone, where there is no
 * second column to trade width with and no pointer to drag a border.
 */
export function SidebarDrawer({ slot, title, children }: {
  /** The `data-slot` the tests and e2e address this drawer by. */
  slot: string
  /** The dialog's accessible name — visually redundant with the brand lockup inside. */
  title: string
  /** The content, handed the drawer's close button to place in its header row — so every
   *  drawer closes the same way (size-11: the ≥44px touch target the mobile rules require). */
  children: (closeButton: ReactNode) => ReactNode
}) {
  const closeButton = (
    <SheetClose asChild>
      <Button variant="ghost" size="icon" aria-label="Close menu" className="-mr-2 size-11">
        <XIcon className="size-[17px]" aria-hidden="true" />
      </Button>
    </SheetClose>
  )
  return (
    <SheetContent
      side="left"
      data-slot={slot}
      showCloseButton={false}
      // The drawer is the sidebar: same width, same surface token, and no padding of its own —
      // the content brings its own. `sm:max-w-none` sheds the primitive's sheet width cap.
      className="w-[264px] gap-0 border-border bg-sidebar p-0 sm:max-w-none md:hidden"
      // Nav needs no prose description, and Radix warns when it cannot find the one it links to.
      aria-describedby={undefined}
    >
      <SheetTitle className="sr-only">{title}</SheetTitle>
      {children(closeButton)}
    </SheetContent>
  )
}
