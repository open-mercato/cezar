import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * The mockup's segmented control (spec 2026-09-14-automations-redesign § Primitives): one row of
 * mutually exclusive toggles in a muted well, the pressed one lifted onto a card. The Tasks
 * "group by" control and the sidebar's Active | Archived tabs use this grammar; the Automations
 * header's List | Week | Day is the same control.
 *
 * Radio semantics by default: re-clicking the pressed option is a no-op. A caller that wants
 * "press again to release" (group by — "not grouped" is the absence of a choice, not a fifth
 * option) passes `allowRelease`, and then `onChange` fires for the pressed value too and the
 * caller decides what that means. `value` is a plain string on purpose: a value matching no
 * option means nothing is pressed, which is a real state for that caller.
 */
export interface SegmentedOption<T extends string> {
  value: T
  label: React.ReactNode
  /** A small tabular count after the label (the list tab's "List 7"). */
  count?: number
}

export function Segmented<T extends string>({
  slot,
  label,
  value,
  options,
  onChange,
  full = false,
  allowRelease = false,
  className,
}: {
  slot: string
  /** The group's accessible name. */
  label: string
  /** The pressed option's value — or anything else, meaning none of them is pressed. */
  value: string
  options: readonly SegmentedOption<T>[]
  onChange: (value: T) => void
  /** Stretch across the container, buttons sharing the width equally. */
  full?: boolean
  /** Fire `onChange` for the already-pressed option too. */
  allowRelease?: boolean
  className?: string
}) {
  return (
    <div
      data-slot={slot}
      data-full={full ? 'true' : undefined}
      role="group"
      aria-label={label}
      className={cn('inline-flex gap-0.5 rounded-md bg-muted p-[3px]', full && 'flex w-full', className)}
    >
      {options.map((option) => {
        const isActive = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            data-value={option.value}
            // These re-slice one thing in place, they do not switch panels — `aria-pressed` is
            // the honest reading of a toggle, and of one that can be released.
            aria-pressed={isActive}
            onClick={() => {
              if (isActive && !allowRelease) return
              onChange(option.value)
            }}
            className={cn(
              'flex h-7 items-center justify-center gap-1.5 rounded-[7px] px-3 text-[12.5px] font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground',
              full && 'flex-1',
              isActive && 'bg-card font-semibold text-foreground shadow-xs',
            )}
          >
            {option.label}
            {option.count !== undefined ? (
              <small className="font-mono text-[11px] font-normal tabular-nums">{option.count}</small>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
