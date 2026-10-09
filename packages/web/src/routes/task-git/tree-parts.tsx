import { ChevronRightIcon, FolderIcon, FolderOpenIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { SidebarMenu, SidebarMenuItem, SidebarMenuSub } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'

import type { TreeFile } from './file-tree'

/**
 * The file tree's rows, shared by the Changes tree and the worktree Files tree — the shadcn
 * `sidebar-11` shape: a `SidebarMenu` of rows, folders as a `Collapsible` whose children hang
 * off a `SidebarMenuSub` rail, a chevron that rotates when the folder opens.
 *
 * The rows are ghost `Button`s carrying the sidebar menu button's look rather than
 * `SidebarMenuButton` itself: that one reads the sidebar context, and these trees also render
 * inside a task workspace column card, which is not a sidebar.
 */
const ROW =
  'flex h-8 w-full min-w-0 shrink justify-start gap-1.5 rounded-md px-2 text-left text-[13px] font-normal text-inherit outline-hidden hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring active:translate-y-0 [&>svg]:size-4 [&>svg]:shrink-0'

export function TreeRoot({ className, children }: { className?: string; children: ReactNode }) {
  return <SidebarMenu className={cn('gap-0.5', className)}>{children}</SidebarMenu>
}

export function TreeFolder({
  slot,
  path,
  name,
  defaultOpen,
  trailing,
  children,
}: {
  /** The trigger's `data-slot` — each tree keeps its own hook name. */
  slot: string
  path: string
  name: string
  defaultOpen: boolean
  /** Right-aligned extras; told whether the folder is open (a collapsed folder sums its files). */
  trailing?: (open: boolean) => ReactNode
  /** Mounted only while open, so a lazy tree fetches a directory when it is first opened. */
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const Folder = open ? FolderOpenIcon : FolderIcon
  return (
    <SidebarMenuItem>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" data-slot={slot} data-path={path} title={name} className={ROW}>
            <ChevronRightIcon
              aria-hidden="true"
              className={cn('text-muted-foreground transition-transform', open && 'rotate-90')}
            />
            <Folder aria-hidden="true" className="text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{name}</span>
            {trailing ? <span className="flex shrink-0 items-center gap-2">{trailing(open)}</span> : null}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub className="mr-0 ml-3.5 gap-0.5 pr-0 pl-1.5">{children}</SidebarMenuSub>
        </CollapsibleContent>
      </Collapsible>
    </SidebarMenuItem>
  )
}

export function TreeFileRow({
  slot,
  path,
  name,
  icon,
  active,
  onSelect,
  trailing,
}: {
  slot: string
  path: string
  name: string
  icon: ReactNode
  active: boolean
  onSelect: (path: string) => void
  trailing?: ReactNode
}) {
  return (
    <SidebarMenuItem>
      <Button
        type="button"
        variant="ghost"
        data-slot={slot}
        data-path={path}
        data-active={active}
        aria-current={active ? 'true' : undefined}
        title={name}
        onClick={() => onSelect(path)}
        className={cn(
          ROW,
          'data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground',
        )}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {trailing ? <span className="flex shrink-0 items-center gap-2">{trailing}</span> : null}
      </Button>
    </SidebarMenuItem>
  )
}

/** A note row inside a folder: loading, an error, "Empty directory". */
export function TreeNote({ slot, tone, children }: { slot: string; tone?: 'danger'; children: ReactNode }) {
  return (
    <li data-slot={slot} className={cn('px-2 py-1.5 text-xs', tone === 'danger' ? 'text-danger' : 'text-soft-foreground')}>
      {children}
    </li>
  )
}

const STATUS: Record<TreeFile['status'], { letter: string; label: string; tone: string }> = {
  added: { letter: 'A', label: 'Added', tone: 'text-success' },
  modified: { letter: 'M', label: 'Modified', tone: 'text-muted-foreground' },
  deleted: { letter: 'D', label: 'Deleted', tone: 'text-danger' },
  renamed: { letter: 'R', label: 'Renamed', tone: 'text-muted-foreground' },
  copied: { letter: 'C', label: 'Copied', tone: 'text-muted-foreground' },
}

/** The one-letter change status at the end of a changed file's row (sidebar-11's badge). */
export function StatusLetter({ status }: { status: TreeFile['status'] }) {
  const entry = STATUS[status]
  return (
    <span
      data-slot="tree-status"
      data-status={status}
      title={entry.label}
      aria-label={entry.label}
      className={cn('w-3 shrink-0 text-center font-mono text-xs font-medium', entry.tone)}
    >
      {entry.letter}
    </span>
  )
}

/** ±12/−3 in miniature — a row's own counts (the aggregate label lives in the toolbar). */
export function TreeCounts({ adds, dels }: { adds: number; dels: number }) {
  if (adds === 0 && dels === 0) return null
  return (
    <span className="shrink-0 font-mono text-xs font-medium tabular-nums">
      {adds > 0 ? <span className="text-success">+{adds}</span> : null}
      {adds > 0 && dels > 0 ? ' ' : null}
      {dels > 0 ? <span className="text-danger">−{dels}</span> : null}
    </span>
  )
}
