import { ChevronDownIcon } from 'lucide-react'
import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Family: PICKER / row chip — the 28px (`h-7`) bordered pill of a control row: a value you can
 * change (`PickerPill`, `SourcePill`, `FacetFilter` build on `chipClass`) or a selectable option
 * (`active`). Same height, radius and `text-ui` as every other pill in the row; mono never —
 * a code value belongs in `BranchChip`. Status is never painted here (that is `Pill` + `StatusDot`).
 *
 * The mockup's `.chip` (spec 2026-09-14-automations-redesign § Primitives): a quiet bordered
 * pill that darkens on hover. One class string, `chipClass`, so the composer's `PickerPill`
 * (a chip that opens a menu) and this plain button chip render identically.
 *
 * Three states beyond the base, each a data attribute so a test or a stylesheet can address it:
 *  - `active` — a selected option in a chip row (the automation editor's schedule/event chips);
 *  - `skill` — the composer's picked-skill chip: violet border (one face and weight for the whole
 *    pill row — a mono, semibold chip beside plain ones read as a second typeface);
 *  - `dashed` — an affordance that leads somewhere rather than selecting ("Manage…").
 */
const chipFaceClass = 'inline-flex items-center gap-1.5 border border-border bg-card px-2.5 text-ui font-medium text-muted-foreground'

export const chipClass =
  `${chipFaceClass} h-7 rounded-full transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-55`

/** The `active` face: a selected option. */
export const chipActiveClass = 'border-foreground font-semibold text-foreground'

/**
 * A chip that only says something (an answer read back): the same face with no hover, and a
 * long value wraps inside it — the 14px radius reads as `rounded-full` on one line.
 */
export function StaticChip({
  active = false,
  dashed = false,
  icon,
  className,
  children,
  ...props
}: React.ComponentProps<'span'> & { active?: boolean; dashed?: boolean; icon?: React.ReactNode }) {
  return (
    <span
      data-slot="chip"
      data-active={active ? 'true' : undefined}
      className={cn(
        chipFaceClass,
        'min-h-7 max-w-full rounded-[14px] py-0.5 break-words',
        active && chipActiveClass,
        dashed && 'border-dashed',
        className,
      )}
      {...props}
    >
      {icon}
      <span className="min-w-0">{children}</span>
    </span>
  )
}

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
        active && chipActiveClass,
        skill && 'border-violet text-foreground',
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
