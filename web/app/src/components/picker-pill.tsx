import { ChevronDownIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import type { Runner } from '@/api/types'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { chipVariants } from '@/components/ui/chip'
import { RUNNERS } from '@/routes/new-task-form'

/**
 * The composer's single-choice pill, factored out of new-task.tsx (#401) so the follow-up
 * surface reuses the exact same runner/model control — one pill grammar, one place to change it.
 */

/** The mockup's `.chip`: a quiet bordered pill that darkens on hover — the unified Chip's
 *  `interactive` variant, focus grammar included. */
export const chipClass = chipVariants({ variant: 'interactive', size: 'lg' })

export const chevron = (
  <ChevronDownIcon aria-hidden="true" className="size-2.5 shrink-0 text-soft-foreground" />
)

/** A generic single-choice pill (runner / model / variants): DropdownMenu radio semantics,
 *  two-line items (label + quiet description), disabled state carries its reason as `title`. */
export function PickerPill({
  slot,
  ariaLabel,
  label,
  value,
  options,
  onPick,
  disabled = false,
  hint,
  disabledHint,
  status,
}: {
  slot: string
  ariaLabel: string
  label: ReactNode
  value: string
  options: ReadonlyArray<{ value: string; label: string; desc?: string }>
  onPick: (value: string) => void
  disabled?: boolean
  /** Hover explanation for the enabled pill — what the setting does (e.g. the ×1 variants pill). */
  hint?: string
  disabledHint?: string
  /** Quiet non-selectable catalog state, kept inside the menu's accessible reading order. */
  status?: string
}) {
  const trigger = (
    <button
      type="button"
      data-slot={slot}
      aria-label={ariaLabel}
      disabled={disabled}
      title={disabled ? disabledHint : hint}
      className={chipClass}
    >
      {label}
      {chevron}
    </button>
  )
  // Radix never opens a disabled trigger, but `disabled:pointer-events-none` would also kill
  // the explanatory title tooltip — so the disabled pill renders bare, in a plain span wrapper
  // that still receives hover.
  if (disabled) {
    return (
      <span title={disabledHint} className="inline-flex">
        {trigger}
      </span>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" data-testid={`${slot}-menu`}>
        <DropdownMenuRadioGroup value={value} onValueChange={onPick}>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value} className="gap-2.5">
              <span className="flex min-w-0 flex-col">
                <span className="text-xs font-medium">{option.label}</span>
                {option.desc ? (
                  <span className="text-xs text-muted-foreground">{option.desc}</span>
                ) : null}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {status ? (
          <DropdownMenuItem disabled className="border-t border-border text-xs text-muted-foreground">
            {status}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Runner choice — rendered only when the host offers more than one backend, so a claude-only
 *  machine keeps the simple form (legacy rule). */
export function RunnerPill({
  runners,
  value,
  onPick,
  disabled = false,
}: {
  runners: readonly Runner[]
  value: Runner
  onPick: (runner: Runner) => void
  disabled?: boolean
}) {
  const options = RUNNERS.filter((r) => runners.includes(r.id))
  return (
    <PickerPill
      slot="runner-pill"
      ariaLabel="Runner"
      label={value}
      value={value}
      disabled={disabled}
      onPick={(next) => onPick(next as Runner)}
      options={options.map((r) => ({ value: r.id, label: r.label, desc: r.desc }))}
    />
  )
}
