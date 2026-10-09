import { Columns3Icon, MoreHorizontalIcon, PencilIcon, PlusIcon, XIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

import { layoutDisplayName, viewLabel, type ViewId, type WorkspaceLayout } from './layout-state'
import { VIEW_ICONS } from './view-picker'

type StripItem =
  | { kind: 'fixed'; key: string; view: ViewId }
  | { kind: 'layout'; key: string; layout: WorkspaceLayout }

/** The row's `gap-0.5`, and the two icon buttons at its end (28px + that gap). */
const CARD_GAP = 2
const NEW_BUTTON_WIDTH = 30
const MORE_BUTTON_WIDTH = 30

/**
 * The saved-layout strip (spec `2026-10-07-task-workspace` §5.2) — the row that REPLACES the
 * header's Session | Changes | Commits | Files tabs. Only one strip is ever shown: this is the
 * whole of the spec's "do not show both strips", and it is why `RunHeader` takes the row as a
 * slot rather than growing a second one.
 *
 * Visually the same underline-tab grammar `components/tab-link.tsx` paints, which is what §3.1
 * asks for — reuse the current conventions rather than invent a parallel one. But these are
 * BUTTONS, not links: a layout is not a URL, and §5.3 keeps layout state out of the address bar
 * on purpose.
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
}) {
  /*
   * The strip never scrolls. Every card — fixed and saved alike — is one item in one row, and the
   * ones that do not fit fold into the `…` menu at the row's end. How many fit is MEASURED, not
   * counted: the room left depends on the window, the sidebar and how much the header's right
   * side is carrying, and a fixed number was wrong on every one of them.
   *
   * Two passes, both before paint: with `fit` unknown every card is rendered (the row clips, so
   * nothing shows) and measured; the count is then stored and the row re-rendered with it.
   */
  const items: StripItem[] = [
    ...fixedViews.map((view): StripItem => ({ kind: 'fixed', key: `fixed:${view}`, view })),
    ...layouts.map((layout): StripItem => ({ kind: 'layout', key: `layout:${layout.name}`, layout })),
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
    // The observer is the real signal — the strip's room changes with the sidebar and the
    // header's right side, not only with the window. The window listener is the belt to its
    // braces: a ResizeObserver is delivered with a frame, and a tab that is not being painted
    // gets neither until it is shown again.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read)
    observer?.observe(root)
    window.addEventListener('resize', read)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', read)
    }
  }, [])

  // Anything that changes what there is to fit, or the room to fit it in, starts a new measure.
  useLayoutEffect(() => setFit(null), [signature, width])
  useLayoutEffect(() => {
    const root = rootRef.current
    if (fit !== null || !root) return
    const cards = [...root.querySelectorAll<HTMLElement>(':scope > [data-slot="layout-card"]')]
    const widths = cards.map((card) => card.offsetWidth + CARD_GAP)
    const room = root.clientWidth - NEW_BUTTON_WIDTH
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
  // The active card is ALWAYS on the strip: a selected tab the user cannot see is the one thing a
  // tab strip may not do. Past the cut, it follows the leading cards.
  const activeIndex = items.findIndex(isActive)
  if (activeIndex >= shownCount) visible = [...visible, items[activeIndex]!]
  const shownKeys = new Set(visible.map((item) => item.key))
  const overflow = items.filter((item) => !shownKeys.has(item.key))

  return (
    <div ref={rootRef} data-slot="layout-cards" className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-clip">
      {visible.map((item) => {
        // The digit that selects this card from the keyboard — its place on the whole strip.
        const position = items.indexOf(item) + 1
        if (item.kind === 'layout') {
          const layout = item.layout
          return (
            <LayoutCard
              key={item.key}
              layout={layout}
              active={isActive(item)}
              onSelect={() => onSelect(layout.name)}
              onRename={(requested) => onRename(layout.name, requested)}
              onClose={() => onClose(layout.name)}
            />
          )
        }
        // A fixed card: one per view, always first and in the same order. Not a saved layout —
        // no close, no rename — just one of the task's standing surfaces.
        const Icon = VIEW_ICONS[item.view]
        const selected = isActive(item)
        return (
          <Button
            key={item.key}
            type="button"
            variant="ghost"
            data-slot="layout-card"
            data-fixed={item.view}
            data-active={selected ? 'true' : undefined}
            aria-pressed={selected}
            title={position <= 9 ? `${viewLabel(item.view)} (${position})` : undefined}
            onClick={() => onSelectFixed?.(item.view)}
            className={cn(
              '-mb-px h-9 shrink-0 gap-1.5 rounded-none border-b-2 border-transparent px-2.5 text-[13px] font-medium text-muted-foreground hover:bg-transparent hover:text-foreground active:translate-y-0',
              selected && 'border-foreground text-foreground',
            )}
          >
            <Icon aria-hidden="true" className="size-3.5 shrink-0" />
            {viewLabel(item.view)}
          </Button>
        )
      })}

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
              className="mb-1 size-7 shrink-0 text-muted-foreground"
            >
              <MoreHorizontalIcon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 w-52 overflow-y-auto">
            {overflow.map((item) => {
              const Icon =
                item.kind === 'fixed'
                  ? VIEW_ICONS[item.view]
                  : item.layout.columns.length === 1
                    ? VIEW_ICONS[item.layout.columns[0]!.view]
                    : Columns3Icon
              return (
                <DropdownMenuItem
                  key={item.key}
                  onSelect={() => (item.kind === 'fixed' ? onSelectFixed?.(item.view) : onSelect(item.layout.name))}
                >
                  <Icon aria-hidden="true" />
                  <span className="truncate">
                    {item.kind === 'fixed' ? viewLabel(item.view) : layoutDisplayName(item.layout.name)}
                  </span>
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {/* No picker here: the new layout opens empty and its stage is the picker. */}
      <Button
        variant="ghost"
        size="icon-sm"
        /* `data-action` rather than `data-slot`: the shadcn Button already spends its
           `data-slot` on `button`, and the browser-level specs need a hook that is not the
           label. */
        data-action="new-layout"
        className="mb-1 size-7 shrink-0 text-muted-foreground"
        aria-label="New layout"
        title="New layout"
        onClick={() => onCreate()}
      >
        <PlusIcon aria-hidden="true" />
      </Button>
    </div>
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
  // One column wears its view's icon; a split wears the columns glyph.
  const Icon = layout.columns.length === 1 ? VIEW_ICONS[layout.columns[0]!.view] : Columns3Icon

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
        '-mb-px group relative flex h-9 shrink-0 items-center gap-1.5 border-b-2 pl-2 pr-0.5 text-[13px] font-medium transition-colors',
        active
          ? 'border-foreground text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground',
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

      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
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
      className="h-6 w-28 rounded-sm px-1.5 py-0 text-[13px] shadow-none focus-visible:ring-0 md:text-[13px] dark:bg-card"
    />
  )
}
