import { ChevronDownIcon, PlusIcon, XIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

import { splitCards, type ViewId, type WorkspaceLayout } from './layout-state'
import { ViewPickerMenu } from './view-picker'

/**
 * The saved-layout strip (spec `2026-10-07-task-workspace` §5.2) — the row that REPLACES the
 * header's Session | Changes | Commits | Files tabs. Only one strip is ever shown: this is the
 * whole of the spec's "do not show both strips", and it is why `RunHeader` takes the row as a
 * slot rather than growing a second one.
 *
 * Visually the same underline-tab grammar `components/tab-link.tsx` paints (confirmed decision,
 * 2026-10-07: keep today's look), but these are BUTTONS, not links: a layout is not a URL, and
 * §5.3 keeps high-frequency layout state out of the address bar on purpose.
 */
export function LayoutCards({
  layouts,
  active,
  onSelect,
  onRename,
  onClose,
  onCreate,
}: {
  layouts: readonly WorkspaceLayout[]
  active: string
  onSelect: (name: string) => void
  onRename: (name: string, requested: string) => void
  onClose: (name: string) => void
  onCreate: (view: ViewId) => void
}) {
  const { visible, overflow } = splitCards(layouts, active)

  return (
    <div data-slot="layout-cards" className="mt-1.5 flex items-end gap-1 md:mt-2.5">
      {visible.map((layout) => (
        <LayoutCard
          key={layout.name}
          layout={layout}
          active={layout.name === active}
          onSelect={() => onSelect(layout.name)}
          onRename={(requested) => onRename(layout.name, requested)}
          onClose={() => onClose(layout.name)}
        />
      ))}

      {overflow.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="-mb-px flex h-8 items-center gap-1 rounded-t-md border-b-2 border-transparent px-2 text-[13px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Pozostałe
              <span className="tabular-nums">({overflow.length})</span>
              <ChevronDownIcon aria-hidden="true" className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 w-52 overflow-y-auto">
            {overflow.map((layout) => (
              <DropdownMenuItem key={layout.name} onSelect={() => onSelect(layout.name)}>
                <span className="truncate">{layout.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      <ViewPickerMenu
        heading="Nowy układ"
        onPick={onCreate}
        trigger={
          <Button
            variant="ghost"
            size="sm"
            className="-mb-px h-8 px-2 text-muted-foreground"
            title="Nowy układ — wybierz widok dla pierwszej kolumny"
          >
            <PlusIcon aria-hidden="true" />
            Nowy układ
          </Button>
        }
      />
    </div>
  )
}

/**
 * One card. Left click selects; right click opens the card menu (confirmed decision, 2026-10-07:
 * rename lives behind the context menu, not a double-click, so a mis-aimed second click on a tab
 * can never put the user in an edit they did not ask for). The X closes immediately — §5.2 is
 * explicit that there is no confirmation and no undo.
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
        '-mb-px group relative flex h-8 items-center rounded-t-md border-b-2 pl-3 pr-1 text-[13px] font-medium',
        active
          ? 'border-foreground font-semibold text-foreground'
          : 'border-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
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
          <DropdownMenuItem onSelect={startRename}>Zmień nazwę</DropdownMenuItem>
          <DropdownMenuItem onSelect={onClose}>Zamknij układ</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {editing ? (
        <RenameField
          name={layout.name}
          onCommit={(requested) => {
            setEditing(false)
            onRename(requested)
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <button
          type="button"
          aria-current={active ? 'page' : undefined}
          onClick={onSelect}
          title={`${layout.name} — prawy klik, by zmienić nazwę lub zamknąć`}
          className="max-w-40 truncate outline-none focus-visible:underline"
        >
          {layout.name}
        </button>
      )}

      {/* Always rendered so the card's width does not jump on hover; revealed on hover, focus
          within the card, and on the active card, which is the one a user closes most often. */}
      <button
        type="button"
        aria-label={`Zamknij układ ${layout.name}`}
        onClick={onClose}
        className={cn(
          'ml-1 grid size-5 shrink-0 place-items-center rounded opacity-0 transition-opacity hover:bg-muted focus-visible:opacity-100 group-hover:opacity-100',
          active && 'opacity-60',
        )}
      >
        <XIcon aria-hidden="true" className="size-3.5" />
      </button>
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
  // Select the whole name on open: the common rename replaces it rather than appends to it.
  useEffect(() => inputRef.current?.select(), [])

  return (
    <input
      ref={inputRef}
      autoFocus
      aria-label={`Nazwa układu ${name}`}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => onCommit(value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          onCommit(value)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          onCancel()
        }
      }}
      className="w-28 rounded border border-border bg-background px-1 text-[13px] outline-none focus-visible:border-foreground"
    />
  )
}
