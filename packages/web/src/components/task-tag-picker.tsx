import { CheckIcon, MinusIcon, PlusIcon, XIcon } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { Link as GlobalLink } from 'react-router'

import type { RunTag, TaskTag } from '@open-mercato/cezar-api-client'
import { useCreateTaskTag, useTaskTags } from '@/api/task-tags'
import { chipClass } from '@/components/chip'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { offersCreate, pickerTags, tagNameKey, tagSwatchClass, type ResolvedRunTag } from '@/lib/task-tags'
import { cn } from '@/lib/utils'

/** How a row reads across what the picker edits: one task is checked/empty; a bulk selection
 *  can also be mixed (spec 2026-11-23-task-tags § 7.3). */
export type TagRowState = 'checked' | 'mixed' | 'empty'

export function toRunTag(tag: Pick<TaskTag, 'id' | 'name' | 'color'>): RunTag {
  return { id: tag.id, name: tag.name, ...(tag.color ? { color: tag.color } : {}) }
}

/** A colored-dot tag chip. `onRemove` adds the ×; a snapshot chip (unknown id) is gray. */
export function TaskTagChip({
  tag,
  onRemove,
  className,
}: {
  tag: Pick<ResolvedRunTag, 'id' | 'name' | 'color' | 'snapshot'>
  onRemove?: () => void
  className?: string
}) {
  return (
    <span
      data-slot="task-tag-chip"
      data-tag-id={tag.id}
      className={cn(
        'inline-flex h-6 max-w-40 shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-2 text-label font-medium text-muted-foreground',
        onRemove && 'pr-1',
        className,
      )}
    >
      <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', tagSwatchClass(tag.snapshot ? undefined : tag.color))} />
      <span className="min-w-0 truncate">{tag.name}</span>
      {onRemove ? (
        <button
          type="button"
          data-slot="task-tag-chip-remove"
          aria-label={`Remove tag ${tag.name}`}
          onClick={(event) => {
            event.stopPropagation()
            onRemove()
          }}
          className="rounded-full p-0.5 text-soft-foreground transition-colors hover:text-foreground"
        >
          <XIcon aria-hidden="true" className="size-3" />
        </button>
      ) : null}
    </span>
  )
}

/**
 * The tag picker (spec § 7.1): search, this project's tags then global ones, checked rows for
 * applied tags, a `Create "<text>"` row when nothing visible matches, and `Manage tags…`.
 * Selecting a row calls `onToggle` and the popover stays open for a second pick.
 *
 * Either pass `children` (the trigger) or control it with `open`/`onOpenChange` plus an `anchor`.
 */
export function TaskTagPicker({
  projectId,
  stateOf,
  onToggle,
  children,
  open: controlledOpen,
  onOpenChange,
  anchor,
  align = 'start',
  disabled = false,
}: {
  /** The project a created tag is scoped to, and whose tags are offered. */
  projectId: string | undefined
  stateOf: (tagId: string) => TagRowState
  /** `add` is true for an empty or mixed row, false for a checked one. */
  onToggle: (tag: RunTag, add: boolean) => void
  children?: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** With a controlled picker and no trigger, what the popover anchors to. */
  anchor?: ReactNode
  align?: 'start' | 'center' | 'end'
  disabled?: boolean
}) {
  const [ownOpen, setOwnOpen] = useState(false)
  const open = controlledOpen ?? ownOpen
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setOwnOpen(next)
    onOpenChange?.(next)
    if (!next) {
      setSearch('')
      setError(null)
    }
  }
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const registry = useTaskTags()
  const create = useCreateTaskTag()
  const { project, global } = pickerTags(registry.data, projectId)
  const key = tagNameKey(search)
  const matches = (tag: TaskTag) => key === '' || tagNameKey(tag.name).includes(key)
  const projectRows = project.filter(matches)
  const globalRows = global.filter(matches)
  const canCreate = projectId !== undefined && offersCreate(search, [...project, ...global])

  const toggle = (tag: TaskTag) => {
    setError(null)
    onToggle(toRunTag(tag), stateOf(tag.id) !== 'checked')
  }

  const createAndAdd = () => {
    const name = search.trim()
    if (!name || create.isPending) return
    setError(null)
    create.mutate(
      { name, projectId },
      {
        onSuccess: ({ tag }) => {
          setSearch('')
          onToggle(toRunTag(tag), true)
        },
        onError: (err) => setError(err instanceof Error ? err.message : String(err)),
      },
    )
  }

  const row = (tag: TaskTag) => {
    const state = stateOf(tag.id)
    return (
      <CommandItem
        key={tag.id}
        value={tag.id}
        data-slot="task-tag-option"
        data-tag-id={tag.id}
        data-state={state}
        onSelect={() => toggle(tag)}
      >
        <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', tagSwatchClass(tag.color))} />
        <span className="min-w-0 flex-1 truncate text-xs">{tag.name}</span>
        {state === 'checked' ? <CheckIcon aria-label="applied" className="size-3.5 shrink-0 text-primary" /> : null}
        {state === 'mixed' ? <MinusIcon aria-label="on some" className="size-3.5 shrink-0 text-muted-foreground" /> : null}
      </CommandItem>
    )
  }

  const content = (
    <PopoverContent align={align} sideOffset={8} className="w-[288px] max-w-[calc(100vw-2rem)] p-0" data-slot="task-tag-picker">
      <Command shouldFilter={false}>
        <CommandInput
          placeholder="search or create a tag…"
          value={search}
          onValueChange={(value) => {
            setSearch(value)
            setError(null)
          }}
          onInput={() => listRef.current?.scrollTo(0, 0)}
        />
        <CommandList ref={listRef} className="max-h-[min(16rem,calc(var(--radix-popover-content-available-height)-5rem))]">
          {projectRows.length === 0 && globalRows.length === 0 && !canCreate ? (
            <CommandEmpty>{registry.isPending ? 'Loading…' : 'No tags yet — type a name to create one.'}</CommandEmpty>
          ) : null}
          {canCreate ? (
            <CommandGroup>
              <CommandItem value="__create__" data-slot="task-tag-create" onSelect={createAndAdd} disabled={create.isPending}>
                <PlusIcon aria-hidden="true" className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-xs">
                  Create “{search.trim()}”
                </span>
              </CommandItem>
            </CommandGroup>
          ) : null}
          {projectRows.length > 0 ? <CommandGroup heading="This project">{projectRows.map(row)}</CommandGroup> : null}
          {globalRows.length > 0 ? <CommandGroup heading="Global">{globalRows.map(row)}</CommandGroup> : null}
        </CommandList>
        {error ? (
          <p role="alert" className="border-t border-border px-3 py-2 text-label text-danger">
            {error}
          </p>
        ) : null}
        <div className="border-t border-border px-3 py-2">
          <GlobalLink
            to="/settings/global/task-tags"
            data-slot="task-tag-manage"
            className="text-label font-medium text-muted-foreground hover:text-foreground hover:underline"
            onClick={() => setOpen(false)}
          >
            Manage tags…
          </GlobalLink>
        </div>
      </Command>
    </PopoverContent>
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {children ? (
        <PopoverTrigger asChild disabled={disabled}>
          {children}
        </PopoverTrigger>
      ) : anchor ? (
        <PopoverAnchor asChild>{anchor}</PopoverAnchor>
      ) : (
        <PopoverAnchor />
      )}
      {content}
    </Popover>
  )
}

/** The dashed `+ Tag` affordance (composer, header). With `compact` it is just a `+`. */
export function AddTagButton({ compact = false, className, ...props }: React.ComponentProps<'button'> & { compact?: boolean }) {
  return (
    <button
      type="button"
      data-slot="task-tag-add"
      aria-label={compact ? 'Add a tag' : undefined}
      {...props}
      className={cn(chipClass, 'border-dashed text-soft-foreground', compact ? 'h-6 px-1.5' : '', className)}
    >
      <PlusIcon aria-hidden="true" className="size-3 shrink-0" />
      {compact ? null : <span>Tag</span>}
    </button>
  )
}
