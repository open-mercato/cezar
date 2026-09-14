import { ChevronDownIcon } from 'lucide-react'
import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * The mockup's `.chip` (spec 2026-09-14-automations-redesign § Primitives): a quiet 26px
 * bordered pill that darkens on hover. One class string, `chipClass`, so the composer's
 * `PickerPill` (a chip that opens a menu) and this plain button chip render identically.
 *
 * Three states beyond the base, each a data attribute so a test or a stylesheet can address it:
 *  - `active` — a selected option in a chip row (the automation editor's schedule/event chips);
 *  - `skill` — the composer's picked-skill chip: violet border, mono, semibold;
 *  - `dashed` — an affordance that leads somewhere rather than selecting ("Manage…").
 */
export const chipClass =
  'inline-flex h-[26px] items-center gap-1.5 rounded-full border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-55'

export const chipChevron = (
  <ChevronDownIcon aria-hidden="true" className="size-2.5 shrink-0 text-soft-foreground" />
)

export function Chip({
  active = false,
  skill = false,
  dashed = false,
  chevron = false,
  icon,
  className,
  children,
  type = 'button',
  ...props
}: React.ComponentProps<'button'> & {
  active?: boolean
  skill?: boolean
  dashed?: boolean
  /** Append the picker chevron — the chip opens something. */
  chevron?: boolean
  /** A leading 12px icon (`<SomeIcon className="size-3" />`). */
  icon?: React.ReactNode
}) {
  return (
    <button
      type={type}
      data-slot="chip"
      data-active={active ? 'true' : undefined}
      data-skill={skill ? 'true' : undefined}
      className={cn(
        chipClass,
        active && 'border-foreground font-semibold text-foreground',
        skill && 'border-violet font-mono font-semibold text-foreground',
        dashed && 'border-dashed',
        className,
      )}
      {...props}
    >
      {icon}
      {children}
      {chevron ? chipChevron : null}
    </button>
  )
}
