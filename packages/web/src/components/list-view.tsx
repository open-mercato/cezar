import { SearchIcon, XIcon } from 'lucide-react'
import * as React from 'react'
import type { ReactNode } from 'react'

import { StatusDot } from '@/components/status-dot'
import { Badge } from '@/components/ui/badge'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { Attention } from '@/lib/attention'
import type { ListView } from '@/lib/task-groups'
import { cn } from '@/lib/utils'

/**
 * The Active/Archived filter, shared by the sidebar quick-list and (Step 3.4) the Tasks table.
 *
 * The spec requires the table's tabs to "share state with the sidebar quick-list tabs", and the
 * legacy UI got that for free by keeping a single `state.listView` global. Two surfaces in two
 * subtrees need one value, so it is context rather than a `useState` in either of them — a
 * quick-list that switched to Archived while the table still showed Active would be two answers
 * to one question.
 *
 * In-memory, not persisted: the legacy filter reset to Active on every reload, and a filter that
 * silently survives a restart hides runs the user does not know are hidden.
 */
const ListViewContext = React.createContext<[ListView, (view: ListView) => void] | null>(null)

export function ListViewProvider({ children }: { children: ReactNode }) {
  const [view, setView] = React.useState<ListView>('active')
  // The tuple is memoized so a re-render of the provider (which sits high in the tree) does not
  // invalidate the context for every consumer below it.
  const value = React.useMemo(() => [view, setView] as [ListView, (view: ListView) => void], [view])
  return <ListViewContext.Provider value={value}>{children}</ListViewContext.Provider>
}

/** Throws without a provider, on purpose: a default would let a consumer mount outside the shell
 *  and quietly keep its own private filter — the exact desync this context exists to prevent. */
export function useListView(): [ListView, (view: ListView) => void] {
  const value = React.useContext(ListViewContext)
  if (!value) throw new Error('useListView must be used inside a <ListViewProvider>')
  return value
}

/* ------------------------------------------------------------------------------------------
 * The task lists' shared furniture (cockpit concept 2): the per-project Tasks page and the
 * cross-project one are the same list at two scopes, so the pieces that make them read alike
 * live beside the filter state they share.
 * ---------------------------------------------------------------------------------------- */

/** Muted sentence-case column header for the task tables. */
export const LIST_HEAD_CLASS = 'h-10 px-3 text-xs font-medium text-muted-foreground first:pl-5 last:pr-5'
/** One task-table cell: generous padding, two-line rows land at 56px. */
export const LIST_CELL_CLASS = 'px-3 py-2.5 first:pl-5 last:pr-5'

const sentenceCase = (label: string) => label.charAt(0).toUpperCase() + label.slice(1)

/** A run's status as a soft outline badge — the colour stays in the dot. */
export function TaskStatusBadge({
  attention,
  title,
  children,
  className,
}: {
  attention: Attention
  title?: string
  /** Trailing detail inside the badge: a scheduled time, a queue position. */
  children?: ReactNode
  className?: string
}) {
  const wantsHuman = attention.bucket === 'waiting' || attention.bucket === 'permission' || attention.bucket === 'error'
  return (
    <Badge
      variant="outline"
      data-slot="pill"
      data-bucket={attention.bucket}
      title={title}
      className={cn(
        'h-6 gap-1.5 bg-card px-2 font-medium',
        wantsHuman ? 'text-foreground' : 'text-muted-foreground',
        className,
      )}
    >
      <StatusDot tone={attention.tone} pulse={attention.pulse} />
      {sentenceCase(attention.label)}
      {children}
    </Badge>
  )
}

/** The Active/Archived switch. Filters one list in place, so it has no tab panels. */
export function ListViewTabs({
  view,
  onChange,
  counts,
  className,
}: {
  view: ListView
  onChange: (view: ListView) => void
  counts?: { active: number; archived: number }
  className?: string
}) {
  const tab = (value: ListView, label: string) => {
    const count = counts?.[value] ?? 0
    return (
      <TabsTrigger value={value} data-slot="overview-tab" data-view={value} aria-pressed={view === value}>
        {label}
        {count > 0 ? <span className="text-xs font-normal text-muted-foreground tabular-nums">{count}</span> : null}
      </TabsTrigger>
    )
  }
  return (
    <Tabs value={view} onValueChange={(next) => onChange(next as ListView)} className={className}>
      <TabsList>
        {tab('active', 'Active')}
        {tab('archived', 'Archived')}
      </TabsList>
    </Tabs>
  )
}

export function ListSearch({
  value,
  onChange,
  placeholder,
  label,
  className,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  /** Accessible name — the placeholder is not one. */
  label: string
  className?: string
}) {
  return (
    <InputGroup className={cn('w-full bg-card sm:w-64', className)}>
      <InputGroupAddon>
        <SearchIcon aria-hidden="true" />
      </InputGroupAddon>
      <InputGroupInput
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="text-[13.5px]"
      />
      {value ? (
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => onChange('')}>
            <XIcon aria-hidden="true" />
          </InputGroupButton>
        </InputGroupAddon>
      ) : null}
    </InputGroup>
  )
}

/** The one surface a list sits on. Nothing inside it is boxed again. */
export function ListFrame({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('overflow-hidden rounded-xl border border-border bg-card shadow-xs', className)}
      {...props}
    />
  )
}

/** What an empty list honestly means — an icon, a sentence, at most one way forward. */
export function ListEmpty({
  icon,
  title,
  description,
  action,
  tone = 'neutral',
  className,
  ...props
}: Omit<React.ComponentProps<'div'>, 'title'> & {
  icon: ReactNode
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  tone?: 'neutral' | 'primary' | 'danger'
}) {
  return (
    <Empty
      data-tone={tone}
      className={cn('rounded-xl border border-dashed border-border py-16 md:py-20', className)}
      {...props}
    >
      <EmptyHeader className="max-w-md">
        <EmptyMedia
          variant="icon"
          className={cn(
            'size-11 rounded-xl [&_svg:not([class*=size-])]:size-5',
            tone === 'primary' && 'bg-primary/15 text-primary-strong',
            tone === 'danger' && 'bg-danger/10 text-danger',
            tone === 'neutral' && 'text-muted-foreground',
          )}
        >
          {icon}
        </EmptyMedia>
        <EmptyTitle className="text-base font-semibold">{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  )
}
