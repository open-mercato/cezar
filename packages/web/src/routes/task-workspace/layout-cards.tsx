import { MoreHorizontalIcon, NotebookTextIcon, PencilIcon, PlusIcon, XIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { layoutDisplayName, viewLabel, type ViewId, type WorkspaceLayout } from './layout-state'
import { VIEW_ICONS } from './view-picker'

type StripItem =
  | { kind: 'fixed'; key: string; view: ViewId }
  | { kind: 'layout'; key: string; layout: WorkspaceLayout }

/** The row's `gap-0.5`, and the two icon buttons at the switcher's end (24px + that gap). */
const CARD_GAP = 2
const NEW_BUTTON_WIDTH = 26
const MORE_BUTTON_WIDTH = 26

/** The drag payload a view tab carries; the workspace's drop zones accept only this. */
export const VIEW_DRAG_TYPE = 'text/cez-view'
/** The payload a column header's grip carries (`workspace-columns.tsx`). */
const COLUMN_DRAG_TYPE = 'text/cez-column'

/**
 * The task's tab row (spec `2026-10-07-task-workspace` §5.2) — the row that REPLACES the header's
 * Session | Changes | Commits | Files tabs, in two parts:
 *
 *  - left, one underline tab per VIEW (Chat, Graph, Changes, Commits, Code) plus Notes, which keeps
 *    its own page. A tab opens that view alone; dragged onto the workspace it splits the screen,
 *    and ⌥-click opens it beside what is showing;
 *  - right, the LAYOUT switcher: the saved multi-column layouts as one segmented control, each
 *    drawn with a diagram of its columns, and `+` for a new one.
 *
 * Fixed tabs and saved layouts are BUTTONS, not links: a layout is not a URL, and §5.3 keeps
 * layout state out of the address bar on purpose. Dropping a column header onto this row closes
 * that column.
 */
export function LayoutCards({
  layouts,
  active,
  onSelect,
  onRename,
  onClose,
  onCreate,
  fixedViews = [],
  fixedActive = null,
  onSelectFixed,
  notesHref,
  notesActive = false,
  showLayouts = true,
  onViewDragStart,
  onViewDragEnd,
  onOpenBeside,
  onColumnDropClose,
}: {
  layouts: readonly WorkspaceLayout[]
  active: string
  /** The views that get a fixed card, in strip order. */
  fixedViews?: readonly ViewId[]
  /** The fixed card that is showing; no saved layout wears the active mark while one is. */
  fixedActive?: ViewId | null
  onSelectFixed?: (view: ViewId) => void
  onSelect: (name: string) => void
  onRename: (name: string, requested: string) => void
  onClose: (name: string) => void
  onCreate: () => void
  /** The Notes page, a link among the view tabs. */
  notesHref?: string
  notesActive?: boolean
  /** False on a page that is not the workspace (Notes): the view tabs only. */
  showLayouts?: boolean
  onViewDragStart?: (view: ViewId) => void
  onViewDragEnd?: () => void
  /** ⌥-click on a view tab. */
  onOpenBeside?: (view: ViewId) => void
  /** A column header dropped on the row. Absent where the columns cannot be edited. */
  onColumnDropClose?: (index: number) => void
}) {
  /*
   * The row never scrolls. Every card — fixed and saved alike — is one item, and the ones that do
   * not fit fold into the `…` menu in the switcher. How many fit is MEASURED, not counted: the
   * room left depends on the window, the sidebar and the header's right side.
   *
   * Two passes, both before paint: with `fit` unknown every card is rendered (the row clips, so
   * nothing shows) and measured; the count is then stored and the row re-rendered with it.
   */
  const items: StripItem[] = [
    ...fixedViews.map((view): StripItem => ({ kind: 'fixed', key: `fixed:${view}`, view })),
    ...(showLayouts
      ? layouts.map((layout): StripItem => ({ kind: 'layout', key: `layout:${layout.name}`, layout }))
      : []),
  ]
  const isActive = (item: StripItem) =>
    item.kind === 'fixed' ? fixedActive === item.view : fixedActive === null && item.layout.name === active

  const rootRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [fit, setFit] = useState<number | null>(null)
  const signature = items.map((item) => item.key).join('|')

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const read = () => setWidth(root.clientWidth)
    // The observer is the real signal — the row's room changes with the sidebar and the header's
    // right side, not only with the window. The window listener is the belt to its braces: a
    // ResizeObserver is delivered with a frame, and a tab that is not painted gets neither.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read)
    observer?.observe(root)
    window.addEventListener('resize', read)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', read)
    }
  }, [])

  // A web font that lands after the measure widens every card without resizing the row, so the
  // observer above never fires; re-measure when fonts finish loading.
  const [fontsLoaded, setFontsLoaded] = useState(0)
  useEffect(() => {
    const fonts = typeof document === 'undefined' ? undefined : document.fonts
    if (!fonts) return
    const bump = () => setFontsLoaded((count) => count + 1)
    void fonts.ready.then(bump)
    fonts.addEventListener?.('loadingdone', bump)
    return () => fonts.removeEventListener?.('loadingdone', bump)
  }, [])

  // Anything that changes what there is to fit, or the room to fit it in, starts a new measure.
  useLayoutEffect(() => setFit(null), [signature, width, fontsLoaded])
  // The backstop: a row that still overflows after a measure folds one more card, so `+` can
  // never end up clipped under whatever sits to the row's right.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (fit === null || fit === 0 || !root) return
    if (root.scrollWidth > root.clientWidth + 1) setFit(fit - 1)
  })
  useLayoutEffect(() => {
    const root = rootRef.current
    if (fit !== null || !root) return
    const cards = [...root.querySelectorAll<HTMLElement>('[data-slot="layout-card"]')]
    const widths = cards.map((card) => card.offsetWidth + CARD_GAP)
    // What is on the row besides the cards: the Notes tab, the switcher's label and frame.
    const chrome = [...root.querySelectorAll<HTMLElement>('[data-strip-chrome]')].reduce(
      (sum, node) => sum + node.offsetWidth + CARD_GAP,
      0,
    )
    const room = root.clientWidth - NEW_BUTTON_WIDTH - chrome
    if (widths.reduce((sum, value) => sum + value, 0) <= room) {
      setFit(items.length)
      return
    }
    // The active card is always shown, wherever it sits in the order — so its width is spent
    // first, and the leading cards take what is left.
    const activeAt = items.findIndex(isActive)
    let used = MORE_BUTTON_WIDTH
    let count = 0
    for (const [index, value] of widths.entries()) {
      const reserved = activeAt > index ? (widths[activeAt] ?? 0) : 0
      if (used + value + reserved > room) break
      used += value
      count += 1
    }
    setFit(count)
  })

  const shownCount = fit ?? items.length
  let visible = items.slice(0, shownCount)
  // The active card is ALWAYS on the row: a selected tab the user cannot see is the one thing a
  // tab strip may not do. Past the cut, it follows the leading cards.
  const activeIndex = items.findIndex(isActive)
  if (activeIndex >= shownCount) visible = [...visible, items[activeIndex]!]
  const shownKeys = new Set(visible.map((item) => item.key))
  const overflow = items.filter((item) => !shownKeys.has(item.key))
  const visibleFixed = visible.filter((item) => item.kind === 'fixed')
  const visibleLayouts = visible.filter((item) => item.kind === 'layout')

  // A column header held over the row: dropping it closes that column.
  const [closeTarget, setCloseTarget] = useState(false)
  const acceptsColumn = (event: React.DragEvent) =>
    onColumnDropClose !== undefined && event.dataTransfer.types.includes(COLUMN_DRAG_TYPE)

  return (
    <div
      ref={rootRef}
      data-slot="layout-cards"
      data-drop-close={closeTarget ? '' : undefined}
      className={cn(
        'relative flex min-w-0 flex-1 items-end gap-0.5 overflow-x-clip rounded-md',
        closeTarget && 'bg-muted outline-1 outline-dashed outline-border',
      )}
      onDragOver={(event) => {
        if (!acceptsColumn(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setCloseTarget(true)
      }}
      onDragLeave={(event) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
        setCloseTarget(false)
      }}
      onDrop={(event) => {
        setCloseTarget(false)
        if (!acceptsColumn(event)) return
        const raw = event.dataTransfer.getData(COLUMN_DRAG_TYPE)
        const index = Number(raw)
        if (raw === '' || !Number.isInteger(index)) return
        event.preventDefault()
        onColumnDropClose?.(index)
      }}
    >
      {visibleFixed.map((item) => {
        if (item.kind !== 'fixed') return null
        // The digit that selects this card from the keyboard — its place on the whole row.
        const position = items.indexOf(item) + 1
        const Icon = VIEW_ICONS[item.view]
        const selected = isActive(item)
        const label = viewLabel(item.view)
        return (
          <Button
            key={item.key}
            type="button"
            variant="ghost"
            data-slot="layout-card"
            data-fixed={item.view}
            data-active={selected ? 'true' : undefined}
            aria-pressed={selected}
            draggable={onViewDragStart !== undefined}
            title={
              onViewDragStart
                ? `${label}${position <= 9 ? ` (${position})` : ''} — drag onto the workspace to split, ⌥-click to open beside`
                : label
            }
            onClick={(event) => {
              if (event.altKey && onOpenBeside) onOpenBeside(item.view)
              else onSelectFixed?.(item.view)
            }}
            onDragStart={(event) => {
              event.dataTransfer.setData(VIEW_DRAG_TYPE, item.view)
              event.dataTransfer.effectAllowed = 'copyMove'
              onViewDragStart?.(item.view)
            }}
            onDragEnd={() => onViewDragEnd?.()}
            className={cn(
              '-mb-px h-9 shrink-0 gap-1.5 rounded-none border-b-2 border-transparent px-2.5 text-[13px] font-medium text-muted-foreground hover:bg-transparent hover:text-foreground active:translate-y-0',
              selected && 'border-foreground text-foreground',
            )}
          >
            <Icon aria-hidden="true" className="size-3.5 shrink-0" />
            {label}
          </Button>
        )
      })}

      {notesHref ? (
        <Link
          to={notesHref}
          data-strip-chrome=""
          aria-current={notesActive ? 'page' : undefined}
          className={cn(
            '-mb-px flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-[13px] font-medium',
            notesActive
              ? 'border-foreground text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          <NotebookTextIcon aria-hidden="true" className="size-3.5 shrink-0" />
          Notes
        </Link>
      ) : null}

      {closeTarget ? (
        <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 rounded bg-background px-2 py-0.5 text-xs font-medium text-foreground shadow-sm">
          Drop to close this column
        </span>
      ) : null}

      {showLayouts ? (
        <div data-slot="layout-switcher" className="ml-auto flex shrink-0 items-center gap-2 pb-1 pl-3">
          <span
            data-strip-chrome=""
            className="text-[10.5px] font-medium tracking-[0.08em] text-muted-foreground uppercase max-lg:hidden"
          >
            Layout
          </span>
          {/* 24px items + `p-0.5` + border = 30px, the height of the Terminal and Full view buttons. */}
          <div role="group" aria-label="Layouts" className="flex h-[30px] items-center gap-0.5 rounded-lg border border-border bg-muted/50 p-0.5">
            {visibleLayouts.map((item) =>
              item.kind === 'layout' ? (
                <LayoutCard
                  key={item.key}
                  layout={item.layout}
                  active={isActive(item)}
                  onSelect={() => onSelect(item.layout.name)}
                  onRename={(requested) => onRename(item.layout.name, requested)}
                  onClose={() => onClose(item.layout.name)}
                />
              ) : null,
            )}

            {overflow.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    data-action="more-layouts"
                    aria-label={`${overflow.length} more layouts`}
                    title="More layouts"
                    className="size-6 shrink-0 text-muted-foreground"
                  >
                    <MoreHorizontalIcon aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="max-h-72 w-56 overflow-y-auto">
                  {overflow.map((item) => (
                    <DropdownMenuItem
                      key={item.key}
                      onSelect={() => (item.kind === 'fixed' ? onSelectFixed?.(item.view) : onSelect(item.layout.name))}
                    >
                      {item.kind === 'fixed' ? (
                        (() => {
                          const Icon = VIEW_ICONS[item.view]
                          return <Icon aria-hidden="true" />
                        })()
                      ) : (
                        <LayoutGlyph count={item.layout.columns.length} />
                      )}
                      <span className="truncate">
                        {item.kind === 'fixed' ? viewLabel(item.view) : layoutDisplayName(item.layout.name)}
                      </span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}

            {/* No picker here: the new layout opens empty and its stage is the picker. */}
            <Button
              variant="ghost"
              size="sm"
              /* `data-action` rather than `data-slot`: the shadcn Button already spends its
                 `data-slot` on `button`, and the browser-level specs need a hook that is not the
                 label. */
              data-action="new-layout"
              className={cn(
                'h-6 shrink-0 gap-1.5 px-1.5 text-[12.5px] text-muted-foreground',
                layouts.length > 0 && 'w-6 px-0',
              )}
              aria-label="New layout"
              title="New layout — or drag a tab onto the workspace"
              onClick={() => onCreate()}
            >
              <PlusIcon aria-hidden="true" />
              {/* With nothing saved yet the switcher would be a lone `+`; say what it makes. */}
              {layouts.length === 0 ? <span>Split</span> : null}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** A layout's shape: its columns, side by side, inside a frame. */
export function LayoutGlyph({ count, className }: { count: number; className?: string }) {
  const n = Math.max(1, Math.min(count, 3))
  const width = 20
  const height = 14
  const pad = 2.5
  const gap = 1.5
  const column = (width - pad * 2 - gap * (n - 1)) / n
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${width} ${height}`}
      className={cn('h-3.5 w-5 shrink-0', className)}
      fill="none"
    >
      <rect x="0.6" y="0.6" width={width - 1.2} height={height - 1.2} rx="2" stroke="currentColor" strokeWidth="1.2" />
      {Array.from({ length: n }, (_, index) => (
        <rect
          key={index}
          x={pad + index * (column + gap)}
          y={pad}
          width={column}
          height={height - pad * 2}
          rx="0.75"
          fill="currentColor"
          opacity={0.55}
        />
      ))}
    </svg>
  )
}

/**
 * One card. Left click selects; DOUBLE click renames, which is the gesture §5.2 names; right
 * click opens the card menu, which offers the same rename plus close for a pointer that cannot
 * double-click comfortably. The X closes immediately — §5.2 is explicit that there is no
 * confirmation and no undo.
 *
 * The context menu is a CONTROLLED `DropdownMenu` anchored to a zero-size span rather than to the
 * card itself: making the card the trigger would open the menu on plain left click too, and the
 * left click is the selection. Radix positions against that anchor, which sits at the card's
 * bottom-left, so the menu drops where a context menu is expected.
 */
function LayoutCard({
  layout,
  active,
  onSelect,
  onRename,
  onClose,
}: {
  layout: WorkspaceLayout
  active: boolean
  onSelect: () => void
  onRename: (requested: string) => void
  onClose: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const shown = layoutDisplayName(layout.name)

  // Entering the edit is deferred by one macrotask, which is load-bearing rather than cosmetic.
  // Closing a Radix menu moves focus in the SAME tick as the selection, and the rename field
  // commits on blur — mount it immediately and that focus move lands on the brand-new input and
  // cancels the edit before a key can be pressed. (Observed as a blur arriving before the field's
  // own mount effect.) One macrotask later the menu is gone and the field keeps the focus it takes.
  const renameTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (renameTimer.current) clearTimeout(renameTimer.current)
    },
    [],
  )
  const startRename = () => {
    if (renameTimer.current) clearTimeout(renameTimer.current)
    renameTimer.current = setTimeout(() => {
      renameTimer.current = null
      setEditing(true)
    }, 0)
  }

  return (
    <div
      data-slot="layout-card"
      data-active={active ? '' : undefined}
      className={cn(
        'group relative flex h-6 shrink-0 items-center gap-1.5 rounded-md pl-2 pr-0.5 text-[12.5px] font-medium transition-colors',
        active
          ? 'bg-background text-foreground shadow-sm ring-1 ring-border'
          : 'text-muted-foreground hover:text-foreground',
      )}
      onContextMenu={(event) => {
        event.preventDefault()
        setMenuOpen(true)
      }}
    >
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <span aria-hidden="true" className="pointer-events-none absolute bottom-0 left-2 size-0" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-44">
          <DropdownMenuItem onSelect={startRename}>
            <PencilIcon aria-hidden="true" />
            Rename layout
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onClose}>
            <XIcon aria-hidden="true" />
            Close layout
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <LayoutGlyph count={layout.columns.length} />
      {editing ? (
        <RenameField
          name={shown}
          onCommit={(requested) => {
            setEditing(false)
            onRename(requested)
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <Button
          type="button"
          variant="ghost"
          aria-current={active ? 'page' : undefined}
          onClick={onSelect}
          // Double-click renames (spec §5.2 — "Double-click a card to rename it"). The context
          // menu keeps the same action for a pointer that cannot double-click comfortably and
          // for discoverability; this is the gesture the spec names.
          onDoubleClick={(event) => {
            event.preventDefault()
            startRename()
          }}
          title={`${shown} — double-click to rename, right-click for more`}
          className="inline-block h-auto max-w-40 shrink truncate rounded-none p-0 text-[13px] text-inherit hover:bg-transparent hover:text-inherit focus-visible:underline focus-visible:ring-0 active:translate-y-0"
        >
          {shown}
        </Button>
      )}

      {/* Always rendered so the card's width does not jump on hover; revealed on hover, focus
          within the card, and on the active card, which is the one a user closes most often. */}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Close layout ${shown}`}
        onClick={onClose}
        className={cn(
          'size-5 text-inherit opacity-0 transition-opacity hover:text-inherit focus-visible:opacity-100 group-hover:opacity-100',
          active && 'opacity-50',
        )}
      >
        <XIcon aria-hidden="true" className="size-3.5" />
      </Button>
    </div>
  )
}

/** The inline rename. Enter and blur commit, Escape abandons — and an empty value is an abandon
 *  rather than a nameless card, which `renameLayout` enforces for every caller. */
function RenameField({
  name,
  onCommit,
  onCancel,
}: {
  name: string
  onCommit: (requested: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(name)
  const inputRef = useRef<HTMLInputElement>(null)
  /**
   * Whether this edit has already been answered.
   *
   * Escape calls `onCancel`, which unmounts this input — and a focused node being detached can
   * fire `blur`, which would run `onCommit(value)` and save the very edit the user just
   * abandoned. Whether any given browser actually fires it is not worth depending on either
   * way: the first answer wins, and the second is a no-op.
   */
  const settled = useRef(false)
  // Select the whole name on open: the common rename replaces it rather than appends to it.
  useEffect(() => inputRef.current?.select(), [])

  const commit = () => {
    if (settled.current) return
    settled.current = true
    onCommit(value)
  }
  const cancel = () => {
    if (settled.current) return
    settled.current = true
    onCancel()
  }

  return (
    <Input
      ref={inputRef}
      autoFocus
      aria-label={`Layout name ${name}`}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          cancel()
        }
      }}
      className="h-6 w-28 rounded-sm px-1.5 py-0 text-[13px] shadow-none focus-visible:ring-0 md:text-[13px]"
    />
  )
}
