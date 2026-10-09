import { ChevronDownIcon } from 'lucide-react'
import * as React from 'react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { bareButton } from '@/components/bare-control'

/**
 * The mockup's `.chip` (spec 2026-09-14-automations-redesign § Primitives): a quiet 28px
 * bordered control that darkens on hover. One class string, `chipClass`, so the composer's
 * `PickerPill` (a chip that opens a menu) and this plain button chip render identically.
 *
 * Three states beyond the base, each a data attribute so a test or a stylesheet can address it:
 *  - `active` — a selected option in a chip row (the automation editor's schedule/event chips);
 *  - `skill` — the composer's picked-skill chip: violet border, mono, semibold;
 *  - `dashed` — an affordance that leads somewhere rather than selecting ("Manage…").
 */
export const chipClass =
  'inline-flex h-7 max-w-full max-md:h-8 items-center gap-1.5 rounded-md border border-border bg-card px-2 text-[12.5px] font-medium whitespace-nowrap text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-55 data-[state=open]:bg-muted data-[state=open]:text-foreground'

export const chipChevron = (
  <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 text-soft-foreground" />
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
    <Button
      variant="ghost"
      type={type}
      data-slot="chip"
      data-active={active ? 'true' : undefined}
      data-skill={skill ? 'true' : undefined}
      className={cn(
        bareButton,
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
    </Button>
  )
}
