import {
  FileDiffIcon,
  CodeXmlIcon,
  GitCommitHorizontalIcon,
  GlobeIcon,
  LayersIcon,
  MessageSquareTextIcon,
  TerminalIcon,
  WorkflowIcon,
} from 'lucide-react'
import { createContext, useContext, type ComponentType, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

import { VIEW_IDS, viewLabel, type ViewId } from './layout-state'

/** The views this cockpit can show — a Terminal only where `capabilities.terminal` allows a
 *  shell; every picker reads this. */
export const AvailableViewsContext = createContext<readonly ViewId[]>(VIEW_IDS)

function useAvailable(order: readonly ViewId[]): ViewId[] {
  const available = useContext(AvailableViewsContext)
  return order.filter((view) => available.includes(view))
}

export const VIEW_ICONS: Record<ViewId, ComponentType<{ className?: string }>> = {
  session: MessageSquareTextIcon,
  changes: FileDiffIcon,
  commits: GitCommitHorizontalIcon,
  files: CodeXmlIcon,
  browser: GlobeIcon,
  // The same icon the standalone graph route uses, so the tile and the surface agree.
  graph: WorkflowIcon,
  assets: LayersIcon,
  terminal: TerminalIcon,
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
  const views = useAvailable(VIEW_IDS)
  return (
    <>
      {views.map((view) => {
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
  const views = useAvailable(VIEW_IDS)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-64">
        <DropdownMenuLabel>{heading}</DropdownMenuLabel>
        <div data-slot="view-tiles" className="grid grid-cols-3 gap-1 p-1">
          {views.map((view) => {
            const Icon = VIEW_ICONS[view]
            return (
              <DropdownMenuItem
                key={view}
                data-view={view}
                data-view-action="create"
                onSelect={() => onPick(view)}
                className="flex h-16 flex-col items-center justify-center gap-1.5 rounded-md bg-muted/50 text-center text-xs text-muted-foreground focus:text-foreground"
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

/** The tiles' order — the same as the fixed cards on the strip. */
const TILE_ORDER: readonly ViewId[] = ['session', 'graph', 'changes', 'commits', 'files', 'browser', 'assets', 'terminal']

/** One line per view, for the tiles of an empty layout. */
const VIEW_HINTS: Record<ViewId, string> = {
  session: 'The conversation with the agent',
  graph: 'The workflow, live, step by step',
  changes: 'What this task changed, as a diff',
  commits: 'The commits on the task branch',
  files: 'The worktree, file by file',
  browser: "The task's app, with Design Mode",
  assets: 'Pages and reports the agent published',
  terminal: 'A shell in the task worktree',
}

/**
 * The stage of an EMPTY layout: every view as a tile, and picking one makes it the layout's first
 * window. This is how a layout is created — the strip's `+` opens an empty one — and what a layout
 * returns to when its last window is closed.
 */
export function ViewTiles({
  onPick,
  scope = 'layout',
}: {
  onPick: (view: ViewId) => void
  /** What is being filled: a whole new layout, or one new window of an existing one. */
  scope?: 'layout' | 'window'
}) {
  const views = useAvailable(TILE_ORDER)
  return (
    // A container, because the tiles also fill ONE window of a split layout: the grid answers to
    // the room it has, not to the viewport.
    <div
      data-slot="view-tiles-stage"
      className="@container flex min-h-0 flex-1 justify-center overflow-y-auto p-4 @md:p-6"
    >
      <div className="my-auto flex w-full max-w-2xl flex-col gap-5">
        <div className="flex flex-col gap-1 text-center">
          <h2 className="text-base font-medium text-foreground">
            {scope === 'layout' ? 'What should this layout show?' : 'What should this window show?'}
          </h2>
          <p className="text-sm text-muted-foreground">
            {scope === 'layout'
              ? 'Pick a view to start. You can split it into more windows afterwards.'
              : 'Pick a view for the new window.'}
          </p>
        </div>
        <div className="grid grid-cols-1 gap-2.5 @[15rem]:grid-cols-2 @lg:grid-cols-3 @lg:gap-3">
          {views.map((view) => {
            const Icon = VIEW_ICONS[view]
            return (
              <Button
                key={view}
                type="button"
                variant="outline"
                data-view={view}
                data-view-action="create"
                onClick={() => onPick(view)}
                className="group/tile h-auto flex-col items-start justify-start gap-2.5 rounded-xl p-3 text-left whitespace-normal @lg:gap-3 @lg:p-4"
              >
                <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors group-hover/tile:bg-primary group-hover/tile:text-primary-foreground">
                  <Icon aria-hidden="true" className="size-[18px]" />
                </span>
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium text-foreground">{viewLabel(view)}</span>
                  <span className="text-xs font-normal text-muted-foreground">{VIEW_HINTS[view]}</span>
                </span>
              </Button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
