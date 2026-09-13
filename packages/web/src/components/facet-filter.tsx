import { CheckIcon, ChevronDownIcon } from 'lucide-react'
import * as React from 'react'

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

/**
 * A multi-select filter pill: a chip that opens a searchable, tickable list.
 *
 * The shape is the one people already know from GitHub's issue filters and Linear's — a quiet
 * chip that names the facet, wears the count when it is narrowing anything, and opens a list you
 * type into. It replaced a row of `<select>`s here for three concrete reasons, not for fashion:
 *
 *  - a `<select>` is single-choice, so "how are storefront AND infra doing?" could not be asked
 *    at all;
 *  - a native option list cannot be searched, which stops working at about fifteen projects;
 *  - an option cannot carry its result count, so every pick is a guess that may empty the table.
 *
 * The list itself is `cmdk` (the same primitive behind ⌘K), so typing filters and the arrow keys
 * move — one interaction grammar for every "pick from a list" surface in the cockpit. Selecting
 * does NOT close the popover: picking three tags in a row is the common case, and a list that
 * shuts after each tick makes the common case three round trips.
 */

export interface FacetOption {
  value: string
  label: string
  /** How many rows this value would leave. Rendered right-aligned and quiet; `0` still shows,
   *  because "this would empty the table" is exactly what a filter should say before it is
   *  clicked rather than after. */
  count?: number
}

export function FacetFilter({
  slot,
  label,
  options,
  selected,
  onToggle,
  onClear,
  searchPlaceholder,
  emptyLabel = 'Nothing to filter by',
}: {
  /** `data-slot` suffix, and the id prefix for tests. */
  slot: string
  label: string
  options: readonly FacetOption[]
  selected: readonly string[]
  onToggle: (value: string) => void
  onClear: () => void
  searchPlaceholder?: string
  /** What an empty option list says. Not an error — a workspace with one workflow has nothing
   *  to filter by, and saying so beats an empty box. */
  emptyLabel?: string
}) {
  const [open, setOpen] = React.useState(false)
  const active = selected.length > 0
  // What the chip says once it is narrowing something: the single value by name (which is the
  // whole answer, and shorter than "Tags · 1"), a count past that.
  const summary =
    selected.length === 1
      ? (options.find((option) => option.value === selected[0])?.label ?? selected[0])
      : `${selected.length} selected`

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot={`facet-${slot}`}
          data-active={active ? 'true' : undefined}
          aria-label={`Filter by ${label.toLowerCase()}`}
          className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
            active && 'border-violet/40 bg-violet/10 text-foreground',
          )}
        >
          <span className={cn(active && 'text-soft-foreground')}>{label}</span>
          {active ? <span className="max-w-[140px] truncate font-semibold">{summary}</span> : null}
          <ChevronDownIcon aria-hidden="true" className="size-2.5 shrink-0 text-soft-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0" data-testid={`facet-${slot}-menu`}>
        <Command>
          {/* Past a handful of options the list is only usable if it can be typed at; below that
              the input costs one row and is ignored. Shown unconditionally so the control does
              not change shape as a workspace grows. */}
          <CommandInput placeholder={searchPlaceholder ?? `Search ${label.toLowerCase()}…`} />
          <CommandList>
            <CommandEmpty>{emptyLabel}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => {
                const checked = selected.includes(option.value)
                return (
                  <CommandItem
                    key={option.value}
                    value={option.label}
                    onSelect={() => onToggle(option.value)}
                    data-slot="facet-option"
                    data-value={option.value}
                    aria-checked={checked}
                    role="option"
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        'flex size-4 shrink-0 items-center justify-center rounded-[4px] border',
                        checked ? 'border-violet bg-violet text-violet-foreground' : 'border-input',
                      )}
                    >
                      {checked ? <CheckIcon className="size-3" /> : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {option.count === undefined ? null : (
                      <span className="shrink-0 font-mono text-[11px] text-soft-foreground tabular-nums">
                        {option.count}
                      </span>
                    )}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
        {active ? (
          <div className="border-t border-border p-1">
            <button
              type="button"
              data-action={`facet-${slot}-clear`}
              onClick={() => onClear()}
              className="w-full rounded-sm px-2 py-1.5 text-left text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Clear {label.toLowerCase()}
            </button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

/**
 * A one-click toggle chip — the affordance for a facet small enough to lay out flat.
 *
 * Tags get these rather than a popover on purpose: they are the reason this page exists, there
 * are rarely more than a dozen, and seeing the whole set at a glance is most of the value. A
 * popover would hide exactly the thing the user came to look at.
 */
export function ToggleChip({
  label,
  count,
  selected,
  onToggle,
  slot,
  tone = 'neutral',
}: {
  label: string
  count?: number
  selected: boolean
  onToggle: () => void
  slot?: string
  /** `tag` paints the violet tag grammar the table's chips use, so the filter and the cells it
   *  filters read as the same vocabulary. */
  tone?: 'neutral' | 'tag'
}) {
  return (
    <button
      type="button"
      data-slot={slot}
      data-selected={selected ? 'true' : undefined}
      aria-pressed={selected}
      onClick={onToggle}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors',
        tone === 'tag'
          ? 'border-violet/25 bg-violet/10 text-violet hover:bg-violet/20'
          : 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground',
        selected && 'border-violet bg-violet text-violet-foreground hover:bg-violet',
      )}
    >
      {label}
      {count === undefined ? null : (
        <span className={cn('font-mono text-[11px] tabular-nums', !selected && 'text-soft-foreground')}>
          {count}
        </span>
      )}
    </button>
  )
}

/**
 * A segmented control — one row of mutually exclusive toggles, the same grammar the Tasks
 * table's Active/Archived tabs use. For "group by", where there are four short options and the
 * current one should be readable without opening anything.
 *
 * Two deliberate properties, both of which the "group by" caller depends on:
 *
 *  - **`value` is a plain string, not one of the option values.** A value matching no option
 *    means NOTHING is pressed, which is a real and common state — "not grouped" is not a fifth
 *    grouping, it is the absence of one, so it needs no button of its own.
 *  - **Clicking the pressed option still fires `onChange`.** The component reports the click and
 *    lets the caller decide what a re-click means; "group by" reads it as "release this", which
 *    is why it needs no `None`. A caller wanting strict radio behaviour simply ignores it.
 */
export function SegmentedControl<T extends string>({
  slot,
  label,
  value,
  options,
  onChange,
}: {
  slot: string
  label: string
  /** The pressed option's value — or anything else, meaning none of them is pressed. */
  value: string
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  return (
    <div
      data-slot={slot}
      role="group"
      aria-label={label}
      className="inline-flex gap-0.5 rounded-md bg-muted p-[3px]"
    >
      {options.map((option) => {
        const isActive = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            data-value={option.value}
            // Like the list tabs: these re-slice one list in place, they do not switch panels.
            // `aria-pressed` is also the honest reading of a toggle that can be released.
            aria-pressed={isActive}
            onClick={() => onChange(option.value)}
            className={cn(
              'flex h-6 items-center justify-center rounded-[6px] px-2.5 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground',
              isActive && 'bg-card font-semibold text-foreground shadow-xs',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
