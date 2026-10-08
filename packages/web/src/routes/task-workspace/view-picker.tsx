import { FileDiffIcon, FolderTreeIcon, GitCommitHorizontalIcon, GlobeIcon, MessageSquareTextIcon } from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

import { VIEW_IDS, viewLabel, type ViewId } from './layout-state'

/*
 * Every view here is pickable, Browser included, on every cockpit.
 *
 * `capabilities.preview` says whether THIS TASK'S OWN APP can be shown (§9, Milestone 3) — not
 * whether the column works. §7 is explicit that "The user may type any URL, including task app
 * addresses and external sites such as GitHub", so disabling the tile on a hosted cockpit would
 * take away a working browser to express a limit that only applies to one kind of address. The
 * column itself says so, where the limit actually bites: `browser-view.tsx` refuses a loopback
 * address on a hosted cockpit with the reason, and loads everything else.
 */

const VIEW_ICONS: Record<ViewId, ComponentType<{ className?: string }>> = {
  session: MessageSquareTextIcon,
  changes: FileDiffIcon,
  commits: GitCommitHorizontalIcon,
  files: FolderTreeIcon,
  browser: GlobeIcon,
}

/**
 * The pickable views, as menu items (spec `2026-10-07-task-workspace` §5.2).
 *
 * A fragment of items rather than a menu of its own, so the ONE list serves `Nowy układ`, the
 * column header's `Zmień widok` and its `Dodaj kolumnę` — three places that must never offer
 * different views, and would if each wrote its own list.
 *
 * `Przeglądarka` is enabled as of Milestone 3. `Terminal` is deliberately absent from this list —
 * it is the bottom drawer, not a column.
 */
export function ViewItems({
  onPick,
  disabled,
  purpose = 'set',
}: {
  onPick: (view: ViewId) => void
  /** The view this column already shows — pickable nowhere, because it would be a no-op. */
  disabled?: ViewId
  /**
   * What picking an item does here. The column menu shows this list TWICE — once to replace the
   * column's view, once to add a column — so `data-view` alone is ambiguous in that menu and a
   * browser-level spec cannot say which of the two it meant. This narrows it.
   */
  purpose?: 'set' | 'add'
}) {
  return (
    <>
      {VIEW_IDS.map((view) => {
        const Icon = VIEW_ICONS[view]
        return (
          <DropdownMenuItem
            key={view}
            /* The stable hook the browser-level specs pick a view by: the Polish label is the
               thing a copy change would move, and the view id is the thing that cannot. */
            data-view={view}
            data-view-action={purpose}
            disabled={view === disabled}
            onSelect={() => onPick(view)}
          >
            <Icon aria-hidden="true" />
            {viewLabel(view)}
          </DropdownMenuItem>
        )
      })}
    </>
  )
}

/**
 * The TILE picker (spec §5.2: "Selecting an enabled tile creates a new layout"; §11: "it opens a
 * tile picker"). Behind `Nowy układ`, the view area's `+`, and the emptied-workspace call to
 * action — the three places that create rather than switch.
 *
 * Tiles, but still `DropdownMenuItem`s in a grid: Radix keeps the roving focus, the Escape
 * handling and the typeahead that a hand-rolled popover would have to re-implement, and the
 * items keep the `role="menuitem"` semantics assistive tech already gets from every other menu
 * in the cockpit. Only the layout changes, which is what "tile" asks for.
 *
 * The column header's own menu stays a list (`ViewItems`): switching a column's view is a choice
 * among commands next to `Zamknij kolumnę`, not the creation gesture the spec describes.
 */
export function ViewPickerMenu({
  trigger,
  heading,
  onPick,
  align = 'start',
}: {
  trigger: ReactNode
  heading: string
  onPick: (view: ViewId) => void
  align?: 'start' | 'end'
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-64">
        <DropdownMenuLabel>{heading}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <div data-slot="view-tiles" className="grid grid-cols-3 gap-1 p-1">
          {VIEW_IDS.map((view) => {
            const Icon = VIEW_ICONS[view]
            return (
              <DropdownMenuItem
                key={view}
                data-view={view}
                data-view-action="create"
                onSelect={() => onPick(view)}
                className="flex h-16 flex-col items-center justify-center gap-1 rounded-md border border-border text-center text-xs"
              >
                <Icon aria-hidden="true" className="size-4" />
                <span className="truncate px-1">{viewLabel(view)}</span>
              </DropdownMenuItem>
            )
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
