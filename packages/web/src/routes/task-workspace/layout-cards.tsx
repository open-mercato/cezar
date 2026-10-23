import { CheckIcon, ChevronDownIcon, MoreHorizontalIcon, NotebookTextIcon, SaveIcon, XIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import {
  isReservedLayoutName,
  layoutDisplayName,
  MAX_LAYOUT_NAME_LENGTH,
  viewLabel,
  WORKING_LAYOUT_NAME,
  type SavedLayout,
  type ViewId,
  type WorkspaceLayout,
} from './layout-state'
import { stripTabs, type StripTab } from './strip'
import { VIEW_ICONS } from './view-picker'

/** The row's `gap-0.5`, and the `…` button that folds the tabs that do not fit (28px + that gap). */
const CARD_GAP = 2
const NO_HINTS: ReadonlyMap<string, string> = new Map()
const NO_VIEWS: readonly ViewId[] = []
const NO_SAVED: readonly SavedLayout[] = []
const MORE_BUTTON_WIDTH = 30

/** The drag payload a view tab carries; the workspace's drop zones accept only this. */
export const VIEW_DRAG_TYPE = 'text/cez-view'
/** The payload a column header's grip carries (`workspace-columns.tsx`). */
const COLUMN_DRAG_TYPE = 'text/cez-column'

/**
 * The task's tab row (spec `2026-10-07-task-workspace` §5.2) — the row that REPLACES the header's
 * Session | Changes | Commits | Files tabs, in two parts:
 *
 *  - left, one underline tab per VIEW plus Notes (its own page, placed by `stripTabs`). A tab opens that view
 *    alone; dragged onto the workspace it splits the screen, and ⌥-click opens it beside what is
 *    showing. `onViews` lights a tab whose view is live elsewhere (the terminal drawer);
 *  - right, the LAYOUT menu: one compact button naming the layout that shows. Its menu opens the
 *    layouts the user saved for every task, and saves what is on screen under a name — a layout
 *    is never created behind the user's back (splitting edits the task's one working arrangement).
 *
 * Tabs and layouts are BUTTONS, not links: a layout is not a URL, and §5.3 keeps layout state out
 * of the address bar on purpose. Dropping a column header onto this row closes that column.
 */
export function LayoutCards({
  layouts,
  active,
  onSelect,
  onClose,
  saved = NO_SAVED,
  onApplySaved,
  onSaveCurrent,
  onDeleteSaved,
  fixedViews = [],
  fixedActive = null,
  onViews = NO_VIEWS,
  onSelectFixed,
  notesHref,
  notesActive = false,
  showLayouts = true,
  onViewDragStart,
  onViewDragEnd,
  onOpenBeside,
  onColumnDropClose,
  keyHints = NO_HINTS,
  showKeyHints = false,
}: {
  layouts: readonly WorkspaceLayout[]
  active: string
  /** The views that get a tab, in strip order. */
  fixedViews?: readonly ViewId[]
  /** The view tab that is showing; no saved layout is active while one is. */
  fixedActive?: ViewId | null
  /** Tabs whose view is live without being the one that shows (the terminal drawer) — lit, not underlined. */
  onViews?: readonly ViewId[]
  onSelectFixed?: (view: ViewId) => void
  /** This task's own layouts (the working arrangement, saved ones it opened) — select and close. */
  onSelect: (name: string) => void
  onClose: (name: string) => void
  /** The layouts saved for every task, and what the Layout menu does with them. */
  saved?: readonly SavedLayout[]
  onApplySaved?: (layout: SavedLayout) => void
  /** Save what is on screen under a name; absent where there is nothing to save. */
  onSaveCurrent?: (name: string) => void
  onDeleteSaved?: (name: string) => void
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
  /** The shortcut that opens each tab, by tab id (`view:<id>`, `view:notes` — `strip.ts`) — `1`
   *  for ⌘1. Printed on the tabs while `showKeyHints` (⌘ held), and always in the `…` menu. */
  keyHints?: ReadonlyMap<string, string>
  showKeyHints?: boolean
}) {
  /*
   * The row never scrolls: the tabs that do not fit fold into a `…` menu. How many fit is MEASURED,
   * not counted: the room left depends on the window, the sidebar and the header's right side.
   *
   * Two passes, both before paint: with `fit` unknown every tab is rendered (the row clips, so
   * nothing shows) and measured; the count is then stored and the row re-rendered with it.
   */
  const items: StripTab[] = notesHref ? stripTabs(fixedViews) : [...fixedViews]
  const isActive = (tab: StripTab) => (tab === 'notes' ? notesActive : fixedActive === tab)

  const rootRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [fit, setFit] = useState<number | null>(null)
  // The layout menu names the active layout, so its width — and the room left — follows it.
  const signature = `${items.join('|')}#${showLayouts && fixedActive === null ? active : ''}`

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

  // A web font that lands after the measure widens every tab without resizing the row, so the
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
  // The backstop: a row that still overflows after a measure folds one more tab, so the layout
  // menu can never end up clipped under whatever sits to the row's right.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (fit === null || fit === 0 || !root) return
    if (root.scrollWidth > root.clientWidth + 1) setFit(fit - 1)
  })
  useLayoutEffect(() => {
    const root = rootRef.current
    if (fit !== null || !root) return
    const cards = [...root.querySelectorAll<HTMLElement>('[data-strip-item]')]
    const widths = cards.map((card) => card.offsetWidth + CARD_GAP)
    // What is on the row besides the tabs: the layout menu.
    const chrome = [...root.querySelectorAll<HTMLElement>('[data-strip-chrome]')].reduce(
      (sum, node) => sum + node.offsetWidth + CARD_GAP,
      0,
    )
    const room = root.clientWidth - chrome
    if (widths.reduce((sum, value) => sum + value, 0) <= room) {
      setFit(items.length)
      return
    }
    // The active tab is always shown, wherever it sits in the order — so its width is spent
    // first, and the leading tabs take what is left.
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
  // The active tab is ALWAYS on the row: a selected tab the user cannot see is the one thing a
  // tab strip may not do. Past the cut, it follows the leading tabs.
  const activeIndex = items.findIndex(isActive)
  if (activeIndex >= shownCount) visible = [...visible, items[activeIndex]!]
  const overflow = items.filter((tab) => !visible.includes(tab))

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
      {visible.map((view) => {
        if (view === 'notes') {
          return (
            <Link
              key="notes"
              to={notesHref!}
              data-strip-item=""
              aria-current={notesActive ? 'page' : undefined}
              className={cn(
                'relative -mb-px flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-[13px] font-medium',
                notesActive
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <TabIcon hint={showKeyHints ? keyHints.get('view:notes') : undefined}>
                <NotebookTextIcon aria-hidden="true" className="size-3.5 shrink-0" />
              </TabIcon>
              Notes
            </Link>
          )
        }
        // The digit that selects this tab from the keyboard — its place on the whole row.
        const position = items.indexOf(view) + 1
        const Icon = VIEW_ICONS[view]
        const selected = isActive(view)
        const on = onViews.includes(view)
        const label = viewLabel(view)
        const hint = keyHints.get(`view:${view}`)
        return (
          <Button
            key={view}
            type="button"
            variant="ghost"
            data-slot="layout-card"
            data-strip-item=""
            data-fixed={view}
            data-active={selected ? 'true' : undefined}
            data-on={on ? '' : undefined}
            aria-pressed={selected || on}
            draggable={onViewDragStart !== undefined}
            title={
              onViewDragStart
                ? `${label}${position <= 9 ? ` (${position})` : ''} — drag onto the workspace to split, ⌥-click to open beside`
                : label
            }
            onClick={(event) => {
              if (event.altKey && onOpenBeside) onOpenBeside(view)
              else onSelectFixed?.(view)
            }}
            onDragStart={(event) => {
              event.dataTransfer.setData(VIEW_DRAG_TYPE, view)
              event.dataTransfer.effectAllowed = 'copyMove'
              onViewDragStart?.(view)
            }}
            onDragEnd={() => onViewDragEnd?.()}
            className={cn(
              'relative -mb-px h-9 shrink-0 gap-1.5 rounded-none border-b-2 border-transparent px-2.5 text-[13px] font-medium text-muted-foreground hover:bg-transparent hover:text-foreground active:translate-y-0',
              (selected || on) && 'text-foreground',
              selected && 'border-foreground',
            )}
          >
            <TabIcon hint={showKeyHints ? hint : undefined}>
              <Icon aria-hidden="true" className="size-3.5 shrink-0" />
            </TabIcon>
            {label}
            {on && !selected ? (
              <span aria-hidden="true" className="absolute top-2 right-1 size-1.5 rounded-full bg-primary" />
            ) : null}
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
              data-action="more-views"
              aria-label={`${overflow.length} more views`}
              title="More views"
              className="mb-1 size-7 shrink-0 text-muted-foreground"
            >
              <MoreHorizontalIcon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 w-56 overflow-y-auto">
            {overflow.map((view) => {
              if (view === 'notes') {
                return (
                  <DropdownMenuItem key="notes" asChild>
                    <Link to={notesHref!}>
                      <NotebookTextIcon aria-hidden="true" />
                      <span className="truncate">Notes</span>
                      {keyHints.get('view:notes') ? <DropdownMenuShortcut>{keyHints.get('view:notes')}</DropdownMenuShortcut> : null}
                    </Link>
                  </DropdownMenuItem>
                )
              }
              const Icon = VIEW_ICONS[view]
              const hint = keyHints.get(`view:${view}`)
              return (
                <DropdownMenuItem key={view} data-view={view} onSelect={() => onSelectFixed?.(view)}>
                  <Icon aria-hidden="true" />
                  <span className="truncate">{viewLabel(view)}</span>
                  {hint ? <DropdownMenuShortcut>{hint}</DropdownMenuShortcut> : null}
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {closeTarget ? (
        <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 rounded bg-background px-2 py-0.5 text-xs font-medium text-foreground shadow-sm">
          Drop to close this column
        </span>
      ) : null}

      {showLayouts ? (
        <div data-strip-chrome="" className="ml-auto flex shrink-0 items-center pb-1 pl-2">
          <LayoutMenu
            layouts={layouts}
            active={fixedActive === null ? active : null}
            saved={saved}
            onSelect={onSelect}
            onClose={onClose}
            onApplySaved={onApplySaved}
            onSaveCurrent={onSaveCurrent}
            onDeleteSaved={onDeleteSaved}
            suggestedName={suggestName(layouts, fixedActive === null ? active : null, fixedActive)}
          />
        </div>
      ) : null}
    </div>
  )
}

/** A tab's icon, or while ⌘ is held the key that selects it. The strip's fit is measured from tab
 *  widths, so a hint must never change one: a digit takes the icon's place at its size, a longer
 *  chord floats over the tab's corner and the icon keeps its space. */
function TabIcon({ hint, children }: { hint: string | undefined; children: ReactNode }) {
  const kbdClass =
    'pointer-events-none flex shrink-0 items-center justify-center rounded-[4px] bg-foreground font-mono text-[10px] leading-none font-semibold text-background'
  if (!hint) return children
  if (hint.length === 1) {
    return (
      <kbd data-slot="tab-key-hint" aria-hidden="true" className={cn(kbdClass, 'size-3.5')}>
        {hint}
      </kbd>
    )
  }
  return (
    <>
      <span className="invisible flex shrink-0">{children}</span>
      <kbd data-slot="tab-key-hint" aria-hidden="true" className={cn(kbdClass, 'absolute -top-1 right-0 z-10 h-4 px-1')}>
        {hint}
      </kbd>
    </>
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

/** The name the save dialog offers: the layout's own when it has one worth keeping, else what it shows. */
function suggestName(layouts: readonly WorkspaceLayout[], active: string | null, fixed: ViewId | null): string {
  const current = active === null ? undefined : layouts.find((layout) => layout.name === active)
  if (current && current.name !== WORKING_LAYOUT_NAME) return layoutDisplayName(current.name)
  if (current) return current.columns.map((column) => viewLabel(column.view)).join(' + ')
  return fixed ? `${viewLabel(fixed)} layout` : ''
}

/**
 * The layouts as ONE button: it names the layout that shows (or just "Layout" while a view tab
 * does). Its menu opens a layout SAVED for every task, lists this task's own (the working
 * arrangement, saved ones it opened) and saves what is on screen under a name the user picks.
 */
function LayoutMenu({
  layouts,
  active,
  saved,
  onSelect,
  onClose,
  onApplySaved,
  onSaveCurrent,
  onDeleteSaved,
  suggestedName,
}: {
  layouts: readonly WorkspaceLayout[]
  /** This task's layout that shows, or null while a view tab does. */
  active: string | null
  saved: readonly SavedLayout[]
  onSelect: (name: string) => void
  onClose: (name: string) => void
  onApplySaved?: (layout: SavedLayout) => void
  onSaveCurrent?: (name: string) => void
  onDeleteSaved?: (name: string) => void
  suggestedName: string
}) {
  const current = active === null ? undefined : layouts.find((layout) => layout.name === active)
  const savedNames = new Set(saved.map((layout) => layout.name))
  // This task's own layouts that are not a saved one under the same name.
  const local = layouts.filter((layout) => !savedNames.has(layout.name))
  const [saving, setSaving] = useState(false)
  // The menu closing into the dialog must not take focus back to its button (the name field has it).
  const intoDialog = useRef(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            ref={triggerRef}
            data-action="layouts"
            data-active-layout={current ? current.name : undefined}
            aria-label={current ? `Layout: ${layoutDisplayName(current.name)}` : 'Layouts'}
            title="Layouts — open a saved one, or save what is on screen"
            className={cn('h-7 max-w-48 shrink-0 gap-1.5 px-2 text-[12.5px]', current ? 'text-foreground' : 'text-muted-foreground')}
          >
            <LayoutGlyph count={current?.columns.length ?? 2} />
            <span className="truncate max-md:hidden">{current ? layoutDisplayName(current.name) : 'Layout'}</span>
            <ChevronDownIcon aria-hidden="true" className="size-3.5 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="max-h-96 w-64 overflow-y-auto"
          onCloseAutoFocus={(event) => {
            if (!intoDialog.current) return
            intoDialog.current = false
            event.preventDefault()
          }}
        >
          <DropdownMenuLabel>Saved layouts</DropdownMenuLabel>
          {saved.length === 0 ? (
            <p className="px-2 pb-1.5 text-xs text-muted-foreground">
              None yet — arrange the view (drag a tab onto it), then save it here. Saved layouts are offered in every
              task.
            </p>
          ) : null}
          {saved.map((layout) => (
            <LayoutRow
              key={`saved:${layout.name}`}
              name={layout.name}
              count={layout.columns.length}
              selected={layout.name === active}
              kind="saved"
              onPick={() => onApplySaved?.(layout)}
              remove={
                onDeleteSaved
                  ? { label: `Delete saved layout ${layout.name}`, run: () => onDeleteSaved(layout.name) }
                  : undefined
              }
            />
          ))}
          {local.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>This task</DropdownMenuLabel>
              {local.map((layout) => (
                <LayoutRow
                  key={`task:${layout.name}`}
                  name={layoutDisplayName(layout.name)}
                  count={layout.columns.length}
                  selected={layout.name === active}
                  kind="task"
                  onPick={() => onSelect(layout.name)}
                  remove={{ label: `Close layout ${layoutDisplayName(layout.name)}`, run: () => onClose(layout.name) }}
                />
              ))}
            </>
          ) : null}
          {onSaveCurrent ? (
            <>
              <DropdownMenuSeparator />
              {/* `data-action` rather than `data-slot`: the browser-level specs need a hook that is not the label. */}
              <DropdownMenuItem
                data-action="save-layout"
                onSelect={() => {
                  intoDialog.current = true
                  setSaving(true)
                }}
              >
                <SaveIcon aria-hidden="true" />
                Save current view as layout…
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <SaveLayoutDialog
        open={saving}
        suggested={suggestedName}
        taken={savedNames}
        onCommit={(name) => {
          setSaving(false)
          onSaveCurrent?.(name)
        }}
        onCancel={() => setSaving(false)}
        returnFocus={() => triggerRef.current?.focus()}
      />
    </>
  )
}

function LayoutRow({
  name,
  count,
  selected,
  kind,
  onPick,
  remove,
}: {
  name: string
  count: number
  selected: boolean
  kind: 'saved' | 'task'
  onPick: () => void
  remove?: { label: string; run: () => void }
}) {
  return (
    <DropdownMenuItem
      data-layout={name}
      data-layout-kind={kind}
      data-active={selected ? '' : undefined}
      onSelect={onPick}
      // The row's × is pointer-only (a button inside a menu item is outside the arrow-key order),
      // so Delete on the focused row does the same.
      aria-keyshortcuts={remove ? 'Delete' : undefined}
      onKeyDown={(event) => {
        if (!remove || (event.key !== 'Delete' && event.key !== 'Backspace')) return
        event.preventDefault()
        remove.run()
      }}
      className="group/layout pr-1"
    >
      <LayoutGlyph count={count} />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {selected ? <CheckIcon aria-hidden="true" className="size-3.5" /> : null}
      {remove ? (
        // A button inside the item: its click is stopped so it removes without opening.
        <button
          type="button"
          aria-label={remove.label}
          title={`${remove.label} (Delete)`}
          className="flex size-5 items-center justify-center rounded-sm text-muted-foreground opacity-0 group-hover/layout:opacity-100 group-focus/layout:opacity-100 hover:bg-background hover:text-foreground"
          onPointerUp={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            remove.run()
          }}
        >
          <XIcon aria-hidden="true" className="size-3.5" />
        </button>
      ) : null}
    </DropdownMenuItem>
  )
}

/** Name what is on screen. A view tab's name, or the working arrangement's, is refused — those
 *  are not layouts — and an existing name is replaced, which the dialog says before it happens. */
function SaveLayoutDialog({
  open,
  suggested,
  taken,
  onCommit,
  onCancel,
  returnFocus,
}: {
  /** Where focus goes when it closes — the menu item that opened it is gone by then. */
  returnFocus: () => void
  open: boolean
  suggested: string
  taken: ReadonlySet<string>
  onCommit: (name: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState('')
  useEffect(() => {
    if (open) setValue(suggested)
  }, [open, suggested])
  const name = value.trim()
  const reserved = name !== '' && isReservedLayoutName(name)

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent
        className="sm:max-w-sm"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          returnFocus()
        }}
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (name !== '' && !reserved) onCommit(name)
          }}
        >
          <DialogHeader>
            <DialogTitle>Save layout</DialogTitle>
            <DialogDescription>Saved layouts are offered in every task, in every project.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Input
              autoFocus
              aria-label="Layout name"
              maxLength={MAX_LAYOUT_NAME_LENGTH}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
            />
            {reserved ? (
              <p className="text-xs text-danger">
                {name === WORKING_LAYOUT_NAME
                  ? `“${WORKING_LAYOUT_NAME}” is the task's unsaved arrangement — pick another.`
                  : 'That name belongs to a view tab — pick another.'}
              </p>
            ) : taken.has(name) ? (
              <p className="text-xs text-muted-foreground">Replaces the saved layout “{name}”.</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={name === '' || reserved}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
