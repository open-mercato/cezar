import { MoreVerticalIcon, XIcon } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useIsDesktop } from '@/lib/use-desktop'
import { cn } from '@/lib/utils'

import {
  MAX_COLUMNS,
  MIN_COLUMN_WIDTH,
  RESIZE_STEP,
  RESIZE_STEP_LARGE,
  viewLabel,
  type ViewId,
  type WorkspaceColumn,
} from './layout-state'
import { ViewItems } from './view-picker'

export interface ColumnActions {
  addColumn: (view: ViewId) => void
  closeColumn: (index: number) => void
  setColumnView: (index: number, view: ViewId) => void
  resizeColumns: (index: number, delta: number) => void
  moveColumn: (from: number, to: number) => void
}

/**
 * The view area: one to three side-by-side columns and the dividers between them (spec
 * `2026-10-07-task-workspace` §5.2).
 *
 * Each column owns its own scroller, and that scroller carries `data-slot="main"` on purpose.
 * Every virtualized surface in the four embedded views finds its scroll container with
 * `el.closest('[data-slot="main"]')` — the thread (`thread-scroller.tsx`), the diff
 * (`components/diff/diff-view.tsx`) and the commit list — so the NEAREST such ancestor winning
 * is what lets those views scroll inside a column with no change to their scroll machinery. The
 * app shell's own `main` stays the outer scroller for everything else; the "one scroll owner"
 * rule those files state holds per column, which is the scope it was always about.
 */
export function WorkspaceColumns({
  columns,
  actions,
  renderView,
}: {
  columns: readonly WorkspaceColumn[]
  actions: ColumnActions
  renderView: (view: ViewId, index: number, column: WorkspaceColumn) => ReactNode
}) {
  const desktop = useIsDesktop()
  const rowRef = useRef<HTMLDivElement>(null)
  // Which column a narrow viewport is showing (spec §5.2 — "show one column at a time"). Clamped
  // on read rather than synced in an effect, so closing a column can never leave a dangling index.
  const [narrowIndex, setNarrowIndex] = useState(0)
  const activeNarrow = Math.min(narrowIndex, columns.length - 1)

  if (columns.length === 0) return null

  const columnMenu = (index: number, column: WorkspaceColumn) => (
    <ColumnMenu
      index={index}
      column={column}
      count={columns.length}
      actions={actions}
    />
  )

  if (!desktop) {
    const column = columns[activeNarrow]!
    return (
      <div data-slot="workspace-columns" data-narrow="" className="flex min-h-0 flex-1 flex-col">
        {/* Compact tabs labelled by view, the spec's narrow-screen switcher. Several columns on the
            same view are a legitimate layout, so the label alone is ambiguous — the index
            disambiguates without inventing per-column names. */}
        <div role="tablist" aria-label="Kolumny układu" className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-3 py-1.5">
          {columns.map((entry, index) => (
            <button
              key={index}
              type="button"
              role="tab"
              aria-selected={index === activeNarrow}
              onClick={() => setNarrowIndex(index)}
              className={cn(
                'shrink-0 rounded-md px-2.5 py-1 text-xs font-medium',
                index === activeNarrow
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {viewLabel(entry.view)}
              {columns.filter((other) => other.view === entry.view).length > 1 ? (
                <span className="ml-1 text-soft-foreground tabular-nums">{index + 1}</span>
              ) : null}
            </button>
          ))}
          <span className="ml-auto flex shrink-0 items-center">{columnMenu(activeNarrow, column)}</span>
        </div>
        <div data-slot="main" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {renderView(column.view, activeNarrow, column)}
        </div>
      </div>
    )
  }

  return (
    <div
      ref={rowRef}
      data-slot="workspace-columns"
      className="flex min-h-0 flex-1 items-stretch"
    >
      {columns.map((column, index) => (
        <div
          key={index}
          data-slot="workspace-column"
          data-view={column.view}
          className="relative flex min-w-0 flex-col border-l border-border first:border-l-0"
          style={{ width: `${column.width}%` }}
        >
          {/* The divider lives INSIDE the column it precedes, absolutely positioned over that
              border — the same move `SidebarResizeHandle` makes. A flex sibling would add real
              width to a row whose columns already sum to 100%, and the browser would pay for it
              by shrinking the very columns the handle exists to size. There is no divider before
              the first column, which is also why the handle at `index - 1` resizes the PAIR that
              meets at this seam. */}
          {index > 0 ? (
            <ColumnDivider
              index={index - 1}
              width={columns[index - 1]!.width}
              rowRef={rowRef}
              onResize={actions.resizeColumns}
            />
          ) : null}
          <ColumnHeader
            index={index}
            column={column}
            count={columns.length}
            actions={actions}
            menu={columnMenu(index, column)}
          />
          <div data-slot="main" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {renderView(column.view, index, column)}
          </div>
        </div>
      ))}
    </div>
  )
}

/** Name + menu + close (confirmed decision, 2026-10-07: a simple header — name and X — with the
 *  view switcher and `+` folded into the menu rather than spread across the strip).
 *
 *  Draggable by the header to reorder (spec §5.2). Native HTML drag-and-drop on purpose: dnd-kit
 *  is loaded by the workflows route alone and must not become main-bundle weight for a reorder
 *  this simple. */
function ColumnHeader({
  index,
  column,
  count,
  actions,
  menu,
}: {
  index: number
  column: WorkspaceColumn
  count: number
  actions: ColumnActions
  menu: ReactNode
}) {
  const [dropTarget, setDropTarget] = useState(false)

  return (
    <header
      data-slot="workspace-column-header"
      draggable={count > 1}
      onDragStart={(event) => {
        event.dataTransfer.setData('text/cez-column', String(index))
        event.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('text/cez-column')) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setDropTarget(true)
      }}
      onDragLeave={() => setDropTarget(false)}
      onDrop={(event) => {
        setDropTarget(false)
        const from = Number(event.dataTransfer.getData('text/cez-column'))
        if (!Number.isInteger(from)) return
        event.preventDefault()
        actions.moveColumn(from, index)
      }}
      className={cn(
        'flex h-9 shrink-0 items-center gap-1 border-b border-border bg-background/95 px-2 backdrop-blur',
        count > 1 && 'cursor-grab active:cursor-grabbing',
        dropTarget && 'bg-muted',
      )}
    >
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
        {viewLabel(column.view)}
      </span>
      {menu}
      <button
        type="button"
        aria-label={`Zamknij kolumnę ${viewLabel(column.view)}`}
        onClick={() => actions.closeColumn(index)}
        className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <XIcon aria-hidden="true" className="size-3.5" />
      </button>
    </header>
  )
}

/**
 * The column menu: change this column's view, add one on the right, close this one (confirmed
 * decision, 2026-10-07 — the `+` and the view switcher live in this menu rather than as separate
 * controls in a header the same decision asked to keep simple).
 *
 * FLAT, with labelled groups, rather than submenus: a Radix sub-menu is a second portalled root
 * with its own focus trap, and nesting one inside a menu that is itself inside a column that can
 * be dragged bought nothing a label does not. The cost is one list rendered twice, which
 * `ViewItems` makes one list.
 */
function ColumnMenu({
  index,
  column,
  count,
  actions,
}: {
  index: number
  column: WorkspaceColumn
  count: number
  actions: ColumnActions
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-6 shrink-0 text-muted-foreground"
          aria-label={`Menu kolumny ${viewLabel(column.view)}`}
        >
          <MoreVerticalIcon aria-hidden="true" className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>Zmień widok</DropdownMenuLabel>
        <ViewItems onPick={(view) => actions.setColumnView(index, view)} disabled={column.view} />
        <DropdownMenuSeparator />
        {count < MAX_COLUMNS ? (
          <>
            <DropdownMenuLabel>Dodaj kolumnę</DropdownMenuLabel>
            <ViewItems onPick={actions.addColumn} />
          </>
        ) : (
          <DropdownMenuLabel className="font-normal text-soft-foreground">
            Maksymalnie {MAX_COLUMNS} kolumny
          </DropdownMenuLabel>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => actions.closeColumn(index)}>
          Zamknij kolumnę
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The handle between two columns (spec §5.2).
 *
 * The same ARIA window-splitter pattern the sidebar's handle uses (`components/app-shell.tsx`):
 * a `separator` is the one role that is both focusable and carries a value range, so one
 * affordance serves a pointer and a keyboard. Pointer capture rather than window listeners,
 * because the drag leaves the 5px strip immediately on any real drag.
 *
 * The drag is computed from the ORIGIN, not from the previous move: a delta chain would
 * accumulate at the clamp, so dragging past the floor and back would not return the divider
 * until the surplus had been paid back. `onResize` takes the delta from where the pair sits
 * NOW, which the clamp in `resizeColumns` then enforces.
 */
function ColumnDivider({
  index,
  width,
  rowRef,
  onResize,
}: {
  index: number
  /** The left column's current width, in percent — the value this separator reports. */
  width: number
  rowRef: React.RefObject<HTMLDivElement | null>
  onResize: (index: number, delta: number) => void
}) {
  const origin = useRef<{ x: number; width: number } | null>(null)

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    origin.current = { x: event.clientX, width }
    event.currentTarget.setPointerCapture(event.pointerId)
    // Without this the drag selects the text of both columns as it passes over them…
    event.preventDefault()
    // …and preventing the default also suppresses the focus the press would have given this
    // `tabIndex=0` element, leaving a mouse user unable to fine-tune with the arrows right after.
    event.currentTarget.focus()
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = origin.current
    const row = rowRef.current
    if (!start || !row) return
    const rowWidth = row.getBoundingClientRect().width
    if (rowWidth <= 0) return
    const target = start.width + ((event.clientX - start.x) / rowWidth) * 100
    onResize(index, target - width)
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!origin.current) return
    origin.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? RESIZE_STEP_LARGE : RESIZE_STEP
    const delta =
      event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : null
    if (delta === null) return
    // Only for the keys we handled: Tab, Escape and the rest stay the browser's.
    event.preventDefault()
    onResize(index, delta)
  }

  return (
    <div
      data-slot="column-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label={`Zmień szerokość kolumny ${index + 1}`}
      aria-valuenow={Math.round(width)}
      aria-valuemin={MIN_COLUMN_WIDTH}
      aria-valuemax={100 - MIN_COLUMN_WIDTH}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      title="Przeciągnij, by zmienić szerokość — strzałki regulują precyzyjnie"
      // A 5px grab strip straddling the seam, invisible until reached for. `touch-none` is
      // load-bearing: without it a touch drag is claimed by the browser's panning and scrolls
      // the column instead of resizing it.
      className="absolute inset-y-0 -left-[3px] z-20 w-[5px] cursor-col-resize touch-none bg-transparent transition-colors hover:bg-violet/40 focus-visible:bg-violet/60 focus-visible:outline-none"
    />
  )
}
