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
}: {
  onPick: (view: ViewId) => void
  /** The view this column already shows — pickable nowhere, because it would be a no-op. */
  disabled?: ViewId
}) {
  return (
    <>
      {VIEW_IDS.map((view) => {
        const Icon = VIEW_ICONS[view]
        return (
          <DropdownMenuItem key={view} disabled={view === disabled} onSelect={() => onPick(view)}>
            <Icon aria-hidden="true" />
            {viewLabel(view)}
          </DropdownMenuItem>
        )
      })}
    </>
  )
}

/** A standalone picker: the `Nowy układ` button and the empty workspace's call to action. */
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
      <DropdownMenuContent align={align} className="w-52">
        <DropdownMenuLabel>{heading}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <ViewItems onPick={onPick} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
