import { ChevronDownIcon, Columns3Icon, InfoIcon, PencilIcon, PlusIcon, XIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

import { layoutDisplayName, splitCards, type ViewId, type WorkspaceLayout } from './layout-state'
import { VIEW_ICONS, ViewPickerMenu } from './view-picker'

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
  overviewActive = false,
  onSelectOverview,
}: {
  layouts: readonly WorkspaceLayout[]
  active: string
  /** The fixed Overview card is showing; no saved layout wears the active mark while it is. */
  overviewActive?: boolean
  /** Present when the host offers the fixed Overview card. */
  onSelectOverview?: () => void
  onSelect: (name: string) => void
  onRename: (name: string, requested: string) => void
  onClose: (name: string) => void
  onCreate: (view: ViewId) => void
}) {
  const { visible, overflow } = splitCards(layouts, active)

  return (
    <div data-slot="layout-cards" className="flex items-end gap-0.5">
      {/* The one card that is not a saved layout: it cannot be closed, renamed or reordered,
          and it is always first. It is the task itself — title, state, facts, actions. */}
      {onSelectOverview ? (
        <Button
          type="button"
          variant="ghost"
          data-slot="layout-card"
          data-layout="overview"
          data-active={overviewActive ? 'true' : undefined}
          aria-pressed={overviewActive}
          onClick={onSelectOverview}
          className={cn(
            '-mb-px h-9 gap-1.5 rounded-none border-b-2 border-transparent px-2.5 text-[13px] font-medium text-muted-foreground hover:bg-transparent hover:text-foreground active:translate-y-0',
            overviewActive && 'border-foreground text-foreground',
          )}
        >
          <InfoIcon aria-hidden="true" className="size-3.5 shrink-0" />
          Overview
        </Button>
      ) : null}
      {visible.map((layout) => (
        <LayoutCard
          key={layout.name}
          layout={layout}
          active={!overviewActive && layout.name === active}
          onSelect={() => onSelect(layout.name)}
          onRename={(requested) => onRename(layout.name, requested)}
          onClose={() => onClose(layout.name)}
        />
      ))}

      {overflow.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className="-mb-px h-9 gap-1 rounded-none border-b-2 border-transparent px-2 text-[13px] hover:bg-transparent"
            >
              More
              <span className="tabular-nums">({overflow.length})</span>
              <ChevronDownIcon aria-hidden="true" className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 w-52 overflow-y-auto">
            {overflow.map((layout) => (
              <DropdownMenuItem key={layout.name} onSelect={() => onSelect(layout.name)}>
                <span className="truncate">{layoutDisplayName(layout.name)}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      <ViewPickerMenu
        heading="New layout"
        onPick={onCreate}
        trigger={
          <Button
            variant="ghost"
            size="icon-sm"
            /* `data-action` rather than `data-slot`: the shadcn Button already spends its
               `data-slot` on `button`, and the browser-level specs need a hook that is not the
               label. */
            data-action="new-layout"
            className="mb-1 ml-1 size-7 shrink-0 text-muted-foreground"
            aria-label="New layout"
            title="New layout — pick the view for its first column"
          >
            <PlusIcon aria-hidden="true" />
          </Button>
        }
      />
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
