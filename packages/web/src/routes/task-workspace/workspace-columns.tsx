import { MoreVerticalIcon, PlusIcon, XIcon } from 'lucide-react'
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useIsDesktop } from '@/lib/use-desktop'
import { cn } from '@/lib/utils'

import {
  MAX_COLUMNS,
  RESIZE_STEP,
  RESIZE_STEP_LARGE,
  dividerFloor,
  viewLabel,
  type ViewId,
  type WorkspaceColumn,
} from './layout-state'
import { FullViewExit, useWorkspaceMaximize } from './maximize'
import { VIEW_ICONS, ViewItems, ViewPickerMenu } from './view-picker'

/** Narrower than this and the layout shows one column at a time (spec §5.2, §11). Tailwind's
 *  `lg`, which is where a three-way split first has room to be readable. */
const SIDE_BY_SIDE_MIN_WIDTH = 1024

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
  // Columns go side by side only from `lg` up. The shared default (`md`, 768px) is the threshold
  // for a different question — whether a diff should wrap — and it left a 768-1024px tablet with
  // two or three columns at ~340px each, which is the squeezing §5.2 asks not to do: it names
  // "mobile/tablet" for one-column-at-a-time, and §11 repeats it.
  const desktop = useIsDesktop(SIDE_BY_SIDE_MIN_WIDTH)
  const rowRef = useRef<HTMLDivElement>(null)
  // Which column a narrow viewport is showing (spec §5.2 — "show one column at a time"). Clamped
  // on read rather than synced in an effect, so closing a column can never leave a dangling index.
  const [narrowIndex, setNarrowIndex] = useState(0)
  const activeNarrow = Math.min(narrowIndex, columns.length - 1)
  // In full view every column wears its header — a lone one too — so there is always a bar,
  // and the way out sits at the right end of the last one: the top-right corner.
  const maximized = useWorkspaceMaximize()?.maximized ?? false


  const columnMenu = (index: number, column: WorkspaceColumn) => (
    <ColumnMenu
      index={index}
      column={column}
      count={columns.length}
      actions={actions}
    />
  )

  if (!desktop) {
    // An emptied layout has no column to show and no column menu to open, so the right-edge `+`
    // is the whole surface here too (spec §5.2).
    if (columns.length === 0) {
      return (
        <div data-slot="workspace-columns" data-narrow="" className="flex min-h-0 flex-1 flex-col">
          <AddColumnEdge count={0} onPick={actions.addColumn} />
        </div>
      )
    }
    const column = columns[activeNarrow]!
    return (
      <div data-slot="workspace-columns" data-narrow="" className="flex min-h-0 flex-1 flex-col">
        {/* Compact tabs labelled by view, the spec's narrow-screen switcher. Several columns on the
            same view are a legitimate layout, so the label alone is ambiguous — the index
            disambiguates without inventing per-column names. */}
        <Tabs
          value={String(activeNarrow)}
          onValueChange={(value) => setNarrowIndex(Number(value))}
          className="shrink-0 gap-0"
        >
        <TabsList aria-label="Layout columns" className="flex w-full justify-start gap-1 overflow-x-auto rounded-none border-b border-border bg-transparent px-3 py-1.5 group-data-[orientation=horizontal]/tabs:h-auto">
          {columns.map((entry, index) => (
            <TabsTrigger
              key={index}
              value={String(index)}
              onClick={() => setNarrowIndex(index)}
              className="h-auto flex-none rounded-md border-0 px-2.5 py-1 text-xs data-[state=active]:bg-muted data-[state=active]:font-medium group-data-[variant=default]/tabs-list:data-[state=active]:shadow-none"
            >
              {viewLabel(entry.view)}
              {columns.filter((other) => other.view === entry.view).length > 1 ? (
                <span className="ml-1 text-soft-foreground tabular-nums">{index + 1}</span>
              ) : null}
            </TabsTrigger>
          ))}
          {/* The `+` §5.2 asks for at "the right edge of the view area", in the place a narrow
              viewport actually has one: the end of the tab row. A vertical strip beside the
              column would take width from the single column that is showing. */}
          <span className="ml-auto flex shrink-0 items-center">
            <ViewPickerMenu
              heading="Add a view"
              align="end"
              onPick={actions.addColumn}
              trigger={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  data-action="add-column"
                  disabled={columns.length >= MAX_COLUMNS}
                  title={
                    columns.length >= MAX_COLUMNS
                      ? `At most ${MAX_COLUMNS} columns`
                      : 'Add a view — new column'
                  }
                  aria-label="Add a view"
                  className="size-7 text-muted-foreground"
                >
                  <PlusIcon aria-hidden="true" />
                </Button>
              }
            />
            {columnMenu(activeNarrow, column)}
          </span>
        </TabsList>
        </Tabs>
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
          className="relative flex min-w-0 flex-col border-l border-border/70 first:border-l-0"
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
              pair={columns[index - 1]!.width + column.width}
              rowRef={rowRef}
              onResize={actions.resizeColumns}
            />
          ) : null}
          {/* A lone column needs no bar of its own: the layout tab above already names it, and
              its menu moves to the edge strip. The bar returns with the second column, where it
              is what tells the columns apart and what a column is dragged by. */}
          {columns.length > 1 || maximized ? (
            <ColumnHeader
              index={index}
              column={column}
              count={columns.length}
              actions={actions}
              menu={columnMenu(index, column)}
              trailing={index === columns.length - 1 ? <FullViewExit className="ml-1.5" /> : null}
            />
          ) : null}
          <div data-slot="main" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {renderView(column.view, index, column)}
          </div>
        </div>
      ))}
      {/* The `+` at the RIGHT EDGE of the view area (spec §5.2 and §11), not only inside a column
          menu: it is how a layout gains its second and third column, and it is the ONLY way to
          add one to a layout whose columns have all been closed — that case has no column menu
          to open. Disabled at three, which is the cap the same paragraph sets. */}
      {/* Only for a layout with no columns left, where it is the one way to put a view back.
          Beside real columns the strip is gone: adding a view to a layout is being redesigned,
          and until then a layout keeps the columns it has. */}
      {columns.length === 0 ? <AddColumnEdge count={0} onPick={actions.addColumn} /> : null}
    </div>
  )
}

/**
 * The right-edge `+` (spec §5.2: "click the `+` at the right edge of the view area. It opens the
 * same view picker"; §11 repeats it among the confirmed decisions).
 *
 * A full-width call to action when the layout is empty, a narrow strip beside the columns
 * otherwise — the same control either way, so there is one answer to "how do I add a view".
 */
function AddColumnEdge({
  count,
  onPick,
  extra,
}: {
  count: number
  onPick: (view: ViewId) => void
  /** Stacked under the `+`: the lone column's own menu. */
  extra?: ReactNode
}) {
  const full = count === 0
  const atCap = count >= MAX_COLUMNS
  return (
    <div
      data-slot="add-column-edge"
      className={cn(
        'flex shrink-0 justify-center border-l border-border/70',
        full ? 'flex-1 items-center border-l-0' : 'w-9 flex-col items-center justify-start gap-0.5 pt-1',
      )}
    >
      <ViewPickerMenu
        heading="Add a view"
        onPick={onPick}
        trigger={
          <Button
            type="button"
            variant={full ? 'outline' : 'ghost'}
            size={full ? 'default' : 'icon-sm'}
            data-action="add-column"
            disabled={atCap}
            title={
              atCap
                ? `At most ${MAX_COLUMNS} columns`
                : 'Add a view — new column on the right'
            }
            aria-label="Add a view"
            className={full ? undefined : 'size-7 text-muted-foreground'}
          >
            <PlusIcon aria-hidden="true" />
            {full ? 'Add a view' : null}
          </Button>
        }
      />
      {extra}
    </div>
  )
}

/** Name + menu + close (spec §5.1: the header identifies the view and carries its controls).
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
  trailing,
}: {
  index: number
  column: WorkspaceColumn
  count: number
  actions: ColumnActions
  menu: ReactNode
  /** After the close button, at the header's far right — the full-view exit. */
  trailing?: ReactNode
}) {
  const [dropTarget, setDropTarget] = useState(false)
  const ViewIcon = VIEW_ICONS[column.view]

  return (
    <header
      data-slot="workspace-column-header"
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('text/cez-column')) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setDropTarget(true)
      }}
      onDragLeave={() => setDropTarget(false)}
      onDrop={(event) => {
        setDropTarget(false)
        // Re-checked here, not just in `onDragOver`: `Number('')` is 0 and passes
        // `Number.isInteger`, so a foreign drop that reached this handler would have reordered
        // column 0.
        if (!event.dataTransfer.types.includes('text/cez-column')) return
        const raw = event.dataTransfer.getData('text/cez-column')
        const from = Number(raw)
        if (raw === '' || !Number.isInteger(from)) return
        event.preventDefault()
        actions.moveColumn(from, index)
      }}
      className={cn(
        'group/column flex h-9 shrink-0 items-center gap-0.5 border-b border-border/70 bg-background pl-4 pr-1.5',
        dropTarget && 'bg-muted',
      )}
    >
      {/*
        THE TITLE is the drag grip, not the whole header.
        With `draggable` on the header, an HTML5 drag starts from the nearest draggable ancestor —
        so a press on the menu trigger or the close X that moved even slightly began a column drag
        instead of activating the button, which made the X unreliable on any two- or three-column
        layout. Dropping stays on the header, so the target is still the full width.
      */}
      <span
        draggable={count > 1}
        onDragStart={(event) => {
          event.dataTransfer.setData('text/cez-column', String(index))
          event.dataTransfer.effectAllowed = 'move'
        }}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-1.5 text-xs font-medium text-muted-foreground',
          count > 1 && 'cursor-grab active:cursor-grabbing',
        )}
      >
        <ViewIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="truncate">{viewLabel(column.view)}</span>
      </span>
      {menu}
      {/* A lone column only has a header in full view, beside the exit — no close there: one
          slip would empty the layout. */}
      {count > 1 ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Close column ${viewLabel(column.view)}`}
          title="Close column"
          onClick={() => actions.closeColumn(index)}
          className="text-soft-foreground"
        >
          <XIcon aria-hidden="true" className="size-3.5" />
        </Button>
      ) : null}
      {trailing}
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
          className="size-6 shrink-0 text-soft-foreground hover:text-foreground"
          aria-label={`Column menu ${viewLabel(column.view)}`}
        >
          <MoreVerticalIcon aria-hidden="true" className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>Change view</DropdownMenuLabel>
        <ViewItems onPick={(view) => actions.setColumnView(index, view)} disabled={column.view} />
        <DropdownMenuSeparator />
        {count < MAX_COLUMNS ? (
          <>
            <DropdownMenuLabel>Add column</DropdownMenuLabel>
            <ViewItems onPick={actions.addColumn} purpose="add" />
          </>
        ) : (
          <DropdownMenuLabel className="font-normal text-soft-foreground">
            At most {MAX_COLUMNS} columns
          </DropdownMenuLabel>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => actions.closeColumn(index)}>
          <XIcon aria-hidden="true" />
          Close column
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
  pair,
  rowRef,
  onResize,
}: {
  index: number
  /** The left column's current width, in percent — the value this separator reports. */
  width: number
  /** The two adjacent columns' widths added together: all this separator can redistribute, and
   *  therefore what bounds the value it reports. */
  pair: number
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
      aria-label={`Resize column ${index + 1}`}
      aria-valuenow={Math.round(width)}
      /* The range this separator really has, which is a property of the PAIR it sits between and
         not of the row: `resizeColumns` clamps to `[floor, pair - floor]`, so in a 33/33/33
         layout either divider moves within roughly [12, 55]. Reporting the row-wide [12, 88]
         told a screen reader about positions no divider in that layout can reach. */
      aria-valuemin={Math.round(dividerFloor(pair))}
      aria-valuemax={Math.round(pair - dividerFloor(pair))}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      title="Drag to resize — arrow keys adjust precisely"
      // A 9px grab strip straddling the seam, invisible until reached for — the hit target §12
      // asks to be defined, at the low end of what a pointer can comfortably catch. It is
      // absolutely positioned, so widening it costs the columns no width. `touch-none` is
      // load-bearing: without it a touch drag is claimed by the browser's panning and scrolls
      // the column instead of resizing it.
      className="absolute inset-y-0 -left-[5px] z-20 w-[9px] cursor-col-resize touch-none bg-transparent transition-colors hover:bg-violet/40 focus-visible:bg-violet/60 focus-visible:outline-none"
    />
  )
}
